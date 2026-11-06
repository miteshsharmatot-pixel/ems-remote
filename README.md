# EMS Task Filler - Remote MCP (multi-user, IIS)

One shared server, one URL. Each employee connects once, signs in with **their own** EMS
email/password, and can then tell Claude (or any MCP client) "log my tasks for today...".

```
MCP client --HTTPS--> IIS (reverse proxy) --> Node service :3000 --> EMS
```

## What it does
**Tasks:** `ems_search_projects`, `ems_get_day_tasks`, `ems_fill_tasks`, `ems_edit_task` (edit/delete), `ems_copy_tasks`,
`ems_task_report` (list / missing days / hours per project), `ems_template`
**Time & people:** `ems_tracker` (time left to 9:30), `ems_attendance`, `ems_my_projects`, `ems_bugs`
**Leaves:** `ems_get_leave_balance`, `ems_get_leave_options`, `ems_prepare_leave`, `ems_submit_leave`, `ems_discard_leave`
**Privacy:** `ems_forget_me`

Tasks and reports use plain HTTP calls with the user's EMS session (fast, no screenshots). A headless browser is only
used for EMS login and the leave forms (and as a fallback if EMS changes the task form).

## What gets stored (per user, on your server only)
- EMS password: AES-256-GCM encrypted with `SECRET` from `.env`
- EMS session cookies: encrypted the same way
- OAuth tokens: only SHA-256 hashes
- Task templates: plain, per user
Users can wipe their data any time by asking Claude to run **forget me** (`ems_forget_me`).

## Server requirements
- Windows Server + IIS with **URL Rewrite** and **Application Request Routing (ARR)**
- Node.js 20+ LTS
- [NSSM](https://nssm.cc) (runs Node as a Windows service)
- An **HTTPS hostname** with a valid certificate (e.g. `https://ems-mcp.yourcompany.com`).
  claude.ai connectors need it reachable from the internet; VS Code / Claude Code / Cursor on the company network can use an internal HTTPS name.
- Outbound access from the server to `https://ems.theonetechnologies.co.in`

## 1. Install
```powershell
# copy this folder to e.g. C:\ems-mcp, then in PowerShell:
cd C:\ems-mcp
$env:PLAYWRIGHT_BROWSERS_PATH = "C:\ems-mcp-browsers"   # shared location, also used by the service
npm install                                            # also downloads Chromium
copy .env.example .env
notepad .env
```
In `.env` set `PUBLIC_URL` (https hostname, no trailing slash) and `SECRET`
(`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
**Back up SECRET. If it is lost or changed, all stored credentials become unreadable and everyone must reconnect.**

## 2. Run as a Windows service
Elevated PowerShell:
```powershell
.\scripts\install-service.ps1 -NssmPath C:\tools\nssm.exe `
   -ServiceUser "DOMAIN\svc-emsmcp" -ServicePassword "***"   # recommended: dedicated account
curl http://127.0.0.1:3000/health     # -> {"ok":true}
```
Logs: `C:\ems-mcp\logs\`. Set `LOG_REQUESTS=1` in `.env` to log every tool call with its duration.

## 3. Publish through IIS
1. IIS Manager -> server node -> **Application Request Routing Cache** -> *Server Proxy Settings*:
   tick **Enable proxy**, **Time-out** `180` seconds, **Response buffer threshold** `0`.
2. Create a site bound to your hostname on **HTTPS (443)** with your certificate. Its physical path is a folder
   containing ONLY the `web.config` from this project (the port in it must match `PORT` in `.env`).
   **Never point the IIS site at the folder that holds the code, `.env` or `data\`** - IIS would serve those files to the web.
   Run the Node service from its own local folder (e.g. `C:\ems-mcp`), not from a network share.
3. Check `https://ems-mcp.yourcompany.com/health` -> `{"ok":true}` and
   `https://ems-mcp.yourcompany.com/.well-known/oauth-authorization-server` -> JSON.

## 4. Connect a client
URL for every client: `https://ems-mcp.yourcompany.com/mcp`. On first use a browser tab opens; the user enters their own EMS login.

- **claude.ai (web / Claude Desktop connector):** *Customize -> Connectors -> Add custom connector*, name `EMS Tasks`, paste the URL.
  Note: a connector added this way belongs to the Claude account, so PCs sharing one Claude account share one EMS sign-in.
- **Claude Code / VS Code extension:** `claude mcp add --transport http ems https://ems-mcp.yourcompany.com/mcp`, then `/mcp` -> Authenticate.
- **VS Code (`.vscode/mcp.json`):** `{"servers":{"ems":{"type":"http","url":"https://ems-mcp.yourcompany.com/mcp"}}}`
- **Cursor (`~/.cursor/mcp.json`):** `{"mcpServers":{"ems":{"url":"https://ems-mcp.yourcompany.com/mcp"}}}`
- **Claude Desktop config file (per-PC sign-in):**
  `{"mcpServers":{"ems":{"command":"npx","args":["-y","mcp-remote","https://ems-mcp.yourcompany.com/mcp"]}}}`

To switch EMS accounts on a PC: ask Claude to run `ems_forget_me`, and delete `%USERPROFILE%\.mcp-auth` if `mcp-remote` is used.

## Alternative: deploy on Render (free, no IIS)
Needs the code in a **private** GitHub repo (this folder has no secrets; never commit `.env` or `data\`) and a free Postgres
(e.g. [Neon](https://neon.tech)), because Render's free disk is wiped on every restart/redeploy.

1. **Database:** create a Neon project, copy its connection string (`postgresql://...?sslmode=require`).
2. **Render:** New -> *Blueprint* -> select the repo (it reads `render.yaml`). When asked, paste the connection string as `DATABASE_URL`.
   `SECRET` is generated for you - leave it alone; the public URL (`https://<name>.onrender.com`) is picked up automatically.
3. **Check:** `https://<name>.onrender.com/health` -> `{"ok":true}`, and `/health/ems` -> `{"ems":200}` (or 3xx).
   If `/health/ems` says `unreachable`, EMS is not reachable from the internet and no cloud host can work - use a server inside the company network.
4. **Connect clients** with `https://<name>.onrender.com/mcp` (see section 4).

Free-plan limits: the service sleeps after ~15 min idle (first call then takes ~30-60 s while it wakes); about 512 MB RAM, so the
login/leave browser jobs run one at a time (`MAX_CONCURRENT_JOBS=1`). To avoid sleeping, ping `/health` every 5 min with a free
uptime monitor, or use a paid instance.

## Safety behaviour
- Tasks and leaves are saved immediately (no confirmation step); `preview: true` on `ems_fill_tasks` / `ems_copy_tasks` shows what would be saved.
- Nothing is saved if a project is unmatched or ambiguous, or a task type/status is unknown. Exact duplicates are skipped.
- Approved tasks are locked; only pending tasks can be edited or deleted.
- Leave: generic reasons ("Personal", "Work at home"), reasons over 100 characters and non-10-digit contact numbers are rejected before submitting.

## Operations notes
- `MAX_CONCURRENT_JOBS` (default 3) limits simultaneous browser jobs (login and leave forms). Each uses ~150-300 MB RAM.
- Idle user browser contexts are freed after 15 minutes; sessions persist encrypted on disk.
- If a user changes their EMS password they must disconnect/reconnect.
- Upgrade: `npm install`, then `nssm restart EmsMcp`.
- If EMS changes its HTML: task form parsing is in `lib/fast.js`, login in `lib/browser.js`, leave form in `lib/leave.js`.

## Security checklist before rollout
- Get approval from IT / the EMS owner: this server holds employees' EMS credentials.
- Run the service as a dedicated low-privilege account; only it and admins may read `data\` and `.env`.
- HTTPS only; keep the server patched; restrict RDP/admin access.
