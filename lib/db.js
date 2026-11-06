import fs from "fs";
import path from "path";
import crypto from "crypto";
import { DATA_DIR, SECRET, DATABASE_URL } from "./config.js";

const USE_DB = !!DATABASE_URL;
if (!USE_DB) fs.mkdirSync(path.join(DATA_DIR, "sessions"), { recursive: true });
const STORE_PATH = path.join(DATA_DIR, "store.json");
const KEY = crypto.scryptSync(SECRET, "ems-mcp-salt-v1", 32);

// ---- encryption (AES-256-GCM) for EMS passwords & session files -----------
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
export function decrypt(b64) {
  const buf = Buffer.from(b64, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const userIdFor = (email) => sha256(email.trim().toLowerCase()).slice(0, 24);

// ---- JSON store: atomic file writes, or Postgres when DATABASE_URL is set ----
// Everything is held in memory; Postgres is written behind (and read once at startup), so reads stay synchronous.
let data = { clients: {}, codes: {}, access: {}, refresh: {}, users: {}, templates: {} };
const sessions = new Map(); // userId -> encrypted session (DB mode only)
let pg = null;
let pending = Promise.resolve(); // serialises DB writes

if (USE_DB) {
  pg = await (await import("./pgstore.js")).createPgStore(DATABASE_URL);
  const saved = await pg.get("store");
  if (saved) {
    try { data = { ...data, ...JSON.parse(saved) }; } catch (e) { console.error("Could not read store from Postgres, starting empty:", e.message); }
  }
  for (const [k, v] of await pg.all("session:")) sessions.set(k.slice("session:".length), v);
} else if (fs.existsSync(STORE_PATH)) {
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(STORE_PATH, "utf-8")) };
  } catch (e) {
    console.error("Could not read store.json, starting empty:", e.message);
  }
}

const dbWrite = (fn) => { pending = pending.then(fn).catch((e) => console.error("Postgres write failed:", e.message)); };

let writeTimer = null;
function flush() {
  const json = JSON.stringify(data);
  if (USE_DB) return dbWrite(() => pg.set("store", json));
  const tmp = STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, json, { mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}
export function save() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 200);
}
export function saveNow() {
  clearTimeout(writeTimer);
  flush();
}
/** Awaitable save for shutdown: makes sure everything has reached disk / Postgres. */
export async function flushAll() {
  saveNow();
  await pending;
}

export const db = {
  get clients() { return data.clients; },
  get codes() { return data.codes; },
  get access() { return data.access; },
  get refresh() { return data.refresh; },
  get users() { return data.users; },
};

// purge expired entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of Object.entries(data.codes)) if (v.expiresAt < now) delete data.codes[k];
  for (const [k, v] of Object.entries(data.access)) if (v.expiresAt < now) delete data.access[k];
  for (const [k, v] of Object.entries(data.refresh)) if (v.expiresAt < now) delete data.refresh[k];
  save();
}, 10 * 60 * 1000).unref();

// ---- per-user EMS credentials ------------------------------------------------
export function saveUser(email, password) {
  const id = userIdFor(email);
  data.users[id] = { email: email.trim(), passwordEnc: encrypt(password), updatedAt: Date.now() };
  saveNow();
  return id;
}
export function getUserCreds(userId) {
  const u = data.users[userId];
  if (!u) return null;
  return { email: u.email, password: decrypt(u.passwordEnc) };
}
// ---- per-user task templates -------------------------------------------------
export const getTemplates = (userId) => data.templates[userId] || {};
export function setTemplate(userId, name, tasks) {
  (data.templates[userId] ||= {})[name] = tasks;
  saveNow();
}
export function removeTemplate(userId, name) {
  const had = !!data.templates[userId]?.[name];
  if (had) { delete data.templates[userId][name]; saveNow(); }
  return had;
}

export function deleteUser(userId) {
  delete data.users[userId];
  delete data.templates[userId];
  for (const [k, v] of Object.entries(data.access)) if (v.userId === userId) delete data.access[k];
  for (const [k, v] of Object.entries(data.refresh)) if (v.userId === userId) delete data.refresh[k];
  if (USE_DB) { sessions.delete(userId); dbWrite(() => pg.del(`session:${userId}`)); }
  else {
    const sp = sessionPath(userId);
    if (fs.existsSync(sp)) fs.unlinkSync(sp);
  }
  saveNow();
}

// ---- per-user browser session (cookies) are encrypted at rest too ---------------
export function sessionPath(userId) {
  return path.join(DATA_DIR, "sessions", `${userId}.enc`);
}
export function saveSessionState(userId, stateObj) {
  const enc = encrypt(JSON.stringify(stateObj));
  if (USE_DB) {
    sessions.set(userId, enc);
    return dbWrite(() => pg.set(`session:${userId}`, enc));
  }
  fs.writeFileSync(sessionPath(userId), enc, { mode: 0o600 });
}
export function loadSessionState(userId) {
  try {
    if (USE_DB) return sessions.has(userId) ? JSON.parse(decrypt(sessions.get(userId))) : null;
    const p = sessionPath(userId);
    return fs.existsSync(p) ? JSON.parse(decrypt(fs.readFileSync(p, "utf-8"))) : null;
  } catch {
    return null;
  }
}
