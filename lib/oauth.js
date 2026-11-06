import express from "express";
import { db, save, sha256, randomToken, saveUser, saveSessionState } from "./db.js";
import { verifyCredentials } from "./browser.js";

const ACCESS_TTL_MS = 60 * 60 * 1000;            // 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS_PER_TX = 5;

const pending = new Map(); // tx -> { client, params, expiresAt, attempts }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
}, 60 * 1000).unref();

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function loginPage(tx, error) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect EMS to Claude</title>
<style>
 body{font-family:system-ui,Segoe UI,Arial,sans-serif;background:#f4f4f5;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
 .card{background:#fff;padding:32px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:100%;max-width:380px}
 h1{font-size:20px;margin:0 0 6px} p{color:#555;font-size:14px;margin:0 0 18px;line-height:1.45}
 label{display:block;font-size:13px;margin:12px 0 4px;color:#333}
 input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:8px;font-size:15px}
 button{margin-top:20px;width:100%;padding:11px;border:0;border-radius:8px;background:#c0392b;color:#fff;font-size:15px;cursor:pointer}
 .err{background:#fdecea;color:#b71c1c;padding:10px;border-radius:8px;font-size:13px;margin-bottom:10px}
 .note{font-size:12px;color:#777;margin-top:14px}
</style></head><body><form class="card" method="post" action="/login" autocomplete="off">
<h1>Connect your EMS account</h1>
<p>Sign in with your EMS credentials so Claude can add your daily tasks for you.</p>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<input type="hidden" name="tx" value="${esc(tx)}">
<label for="email">EMS email / username</label><input id="email" name="email" type="text" required autofocus>
<label for="password">EMS password</label><input id="password" name="password" type="password" required>
<button type="submit">Connect</button>
<div class="note">Your credentials are stored encrypted on the company server and used only to log in to EMS on your behalf. You can remove them any time by asking Claude to run "forget me".</div>
</form></body></html>`;
}

export class EmsOAuthProvider {
  get clientsStore() {
    return {
      getClient: (id) => db.clients[id],
      registerClient: (info) => {
        db.clients[info.client_id] = info;
        save();
        return info;
      },
    };
  }

  async authorize(client, params, res) {
    const tx = randomToken(18);
    pending.set(tx, { client, params, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 });
    res.status(200).type("html").send(loginPage(tx));
  }

  async challengeForAuthorizationCode(client, authorizationCode) {
    const rec = db.codes[sha256(authorizationCode)];
    if (!rec || rec.expiresAt < Date.now()) throw new Error("Invalid or expired authorization code");
    return rec.codeChallenge;
  }

  issueTokens(userId, clientId) {
    const access = randomToken(32), refresh = randomToken(32), now = Date.now();
    db.access[sha256(access)] = { userId, clientId, expiresAt: now + ACCESS_TTL_MS };
    db.refresh[sha256(refresh)] = { userId, clientId, expiresAt: now + REFRESH_TTL_MS };
    save();
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh };
  }

  async exchangeAuthorizationCode(client, authorizationCode, _verifier, redirectUri) {
    const h = sha256(authorizationCode);
    const rec = db.codes[h];
    delete db.codes[h]; // single use
    if (!rec || rec.expiresAt < Date.now()) throw new Error("Invalid or expired authorization code");
    if (rec.clientId !== client.client_id) throw new Error("Authorization code was issued to a different client");
    if (redirectUri && rec.redirectUri !== redirectUri) throw new Error("redirect_uri mismatch");
    return this.issueTokens(rec.userId, client.client_id);
  }

  async exchangeRefreshToken(client, refreshToken) {
    const h = sha256(refreshToken);
    const rec = db.refresh[h];
    if (!rec || rec.expiresAt < Date.now() || rec.clientId !== client.client_id) throw new Error("Invalid refresh token");
    delete db.refresh[h]; // rotate
    return this.issueTokens(rec.userId, client.client_id);
  }

  async verifyAccessToken(token) {
    const rec = db.access[sha256(token)];
    if (!rec || rec.expiresAt < Date.now()) throw new Error("Invalid or expired token");
    return { token, clientId: rec.clientId, scopes: [], expiresAt: Math.floor(rec.expiresAt / 1000), extra: { userId: rec.userId } };
  }

  async revokeToken(client, request) {
    const h = sha256(request.token);
    delete db.access[h];
    delete db.refresh[h];
    save();
  }
}

// ---- POST /login : the sign-in form target -----------------------------------
const ipHits = new Map(); // ip -> { count, resetAt }
export function loginRouter() {
  const r = express.Router();
  r.post("/login", express.urlencoded({ extended: false, limit: "10kb" }), async (req, res) => {
    const now = Date.now();
    const hit = ipHits.get(req.ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
    if (hit.resetAt < now) { hit.count = 0; hit.resetAt = now + 15 * 60 * 1000; }
    hit.count++;
    ipHits.set(req.ip, hit);
    if (hit.count > 20) return res.status(429).type("html").send(loginPage("", "Too many attempts. Try again in 15 minutes."));

    const { tx, email, password } = req.body || {};
    const p = pending.get(tx);
    if (!p || p.expiresAt < now) {
      return res.status(400).type("html").send("<p style='font-family:sans-serif'>This sign-in link expired. Go back to Claude and click Connect again.</p>");
    }
    if (++p.attempts > MAX_ATTEMPTS_PER_TX) {
      pending.delete(tx);
      return res.status(429).type("html").send("<p style='font-family:sans-serif'>Too many failed attempts. Go back to Claude and click Connect again.</p>");
    }
    if (!email || !password) return res.status(400).type("html").send(loginPage(tx, "Enter both email and password."));

    try {
      const state = await verifyCredentials(String(email).trim(), String(password));
      const userId = saveUser(String(email), String(password));
      saveSessionState(userId, state);

      const code = randomToken(32);
      db.codes[sha256(code)] = {
        userId, clientId: p.client.client_id, codeChallenge: p.params.codeChallenge,
        redirectUri: p.params.redirectUri, expiresAt: now + CODE_TTL_MS,
      };
      save();
      pending.delete(tx);

      const target = new URL(p.params.redirectUri);
      target.searchParams.set("code", code);
      if (p.params.state) target.searchParams.set("state", p.params.state);
      res.redirect(target.toString());
    } catch (e) {
      res.status(401).type("html").send(loginPage(tx, e.message));
    }
  });
  return r;
}
