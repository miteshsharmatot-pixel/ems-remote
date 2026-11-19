import express from "express";
import { db, save, sha256, randomToken, saveUser, saveSessionState } from "./db.js";
import { verifyCredentials } from "./browser.js";
import { loginPage, messagePage, sendPage } from "./loginpage.js";

const ACCESS_TTL_MS = 60 * 60 * 1000;            // 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS_PER_TX = 5;

const pending = new Map(); // tx -> { client, params, expiresAt, attempts }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
}, 60 * 1000).unref();

// who is asking and where the user is sent back to: shown on the sign-in page so a look-alike app is easier to spot
function pageInfo(client, params) {
  let host = "";
  try { host = new URL(params.redirectUri).host; } catch { /* leave blank */ }
  return { app: String(client?.client_name || "").slice(0, 40), host };
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
    sendPage(res, 200, (n) => loginPage(n, { tx, ...pageInfo(client, params) }));
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
    if (hit.count > 20) return sendPage(res, 429, (n) => messagePage(n, "Too many attempts", "Please wait 15 minutes and try again."));

    const { tx, email, password } = req.body || {};
    const p = pending.get(tx);
    if (!p || p.expiresAt < now) {
      return sendPage(res, 400, (n) => messagePage(n, "This sign-in link expired", "Go back to Claude and click Connect again."));
    }
    if (++p.attempts > MAX_ATTEMPTS_PER_TX) {
      pending.delete(tx);
      return sendPage(res, 429, (n) => messagePage(n, "Too many failed attempts", "Go back to Claude and click Connect again."));
    }
    const info = pageInfo(p.client, p.params);
    if (!email || !password) return sendPage(res, 400, (n) => loginPage(n, { tx, error: "Enter both email and password.", ...info }));

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
      sendPage(res, 401, (n) => loginPage(n, { tx, error: e.message, ...info }));
    }
  });
  return r;
}
