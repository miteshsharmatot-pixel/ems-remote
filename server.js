import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

import { PORT, HOST, PUBLIC_URL, EMS_BASE_URL, DATABASE_URL } from "./lib/config.js";
import { flushAll } from "./lib/db.js";
import { closeAll } from "./lib/browser.js";
import { EmsOAuthProvider, loginRouter } from "./lib/oauth.js";
import { registerTools } from "./lib/tools.js";

const app = express();
app.set("trust proxy", 1); // running behind IIS reverse proxy
app.disable("x-powered-by");

const provider = new EmsOAuthProvider();
const issuerUrl = new URL(PUBLIC_URL);
const mcpUrl = new URL(`${PUBLIC_URL}/mcp`);

// OAuth endpoints: /.well-known/*, /authorize, /token, /register, /revoke
app.use(mcpAuthRouter({
  provider, issuerUrl, baseUrl: issuerUrl, resourceServerUrl: mcpUrl,
  resourceName: "EMS Task Filler",
}));
app.use(loginRouter());

const bearer = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
});

// Stateless Streamable HTTP: a fresh server+transport per request, bound to the authenticated user.
app.post("/mcp", bearer, express.json({ limit: "2mb" }), async (req, res) => {
  const userId = req.auth?.extra?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  if (process.env.LOG_REQUESTS) {
    const t0 = Date.now();
    const what = req.body?.params?.name || req.body?.method;
    console.log(`${new Date().toISOString()} -> ${what}`);
    res.on("finish", () => console.log(`${new Date().toISOString()} <- ${what} ${Date.now() - t0}ms`));
  }
  const server = new McpServer({ name: "ems-task-filler", version: "2.0.0" });
  registerTools(server, userId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("MCP error:", e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});
const notAllowed = (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

app.get("/health", (_req, res) => res.json({ ok: true, storage: DATABASE_URL ? "postgres" : "files" }));

// Can this host reach EMS at all? (no login, no data - just the HTTP status of the login page)
app.get("/health/ems", async (_req, res) => {
  try {
    const r = await fetch(`${EMS_BASE_URL}/Account/Login`, { redirect: "manual", signal: AbortSignal.timeout(10000) });
    res.json({ ems: r.status });
  } catch (e) {
    res.status(502).json({ ems: "unreachable", error: e.cause?.code || e.message });
  }
});

const httpServer = app.listen(PORT, HOST, () => console.log(`EMS MCP listening on ${HOST}:${PORT} (public: ${PUBLIC_URL}/mcp)`));

// Render's free plan sleeps an instance after ~15 min without inbound requests. A request to our own public URL goes
// through Render's proxy, so it counts as traffic. Opt-in: set KEEP_ALIVE=1 (render.yaml does).
if (process.env.KEEP_ALIVE) {
  const ping = () => fetch(`${PUBLIC_URL}/health`, { signal: AbortSignal.timeout(15000) }).catch(() => {});
  setInterval(ping, 8 * 60 * 1000).unref();
}

async function shutdown() {
  await flushAll();
  httpServer.close();
  await closeAll();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
