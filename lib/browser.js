import { chromium } from "playwright";
import { EMS_BASE_URL, MAX_CONCURRENT_JOBS } from "./config.js";
import { getUserCreds, loadSessionState, saveSessionState } from "./db.js";

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    // containers (Render etc.): no user-namespace sandbox and a tiny /dev/shm
    const args = process.env.CHROMIUM_LOW_MEM ? ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] : [];
    browserPromise = chromium.launch({ headless: true, args }).then((b) => {
      b.on("disconnected", () => {
        browserPromise = null;
        contexts.clear();
      });
      return b;
    });
  }
  return browserPromise;
}

// ---- simple concurrency limiter so a busy day doesn't exhaust the server ----
let running = 0;
const waiters = [];
export async function withJob(fn) {
  if (running >= MAX_CONCURRENT_JOBS) await new Promise((r) => waiters.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiters.shift()?.();
  }
}

// ---- per-user contexts (cookie jars), evicted when idle ---------------------
const contexts = new Map(); // userId -> { ctxPromise, lastUsed }
const IDLE_MS = 15 * 60 * 1000;

async function getContext(userId) {
  let entry = contexts.get(userId);
  if (!entry) {
    const ctxPromise = (async () => {
      const browser = await getBrowser();
      const opts = { baseURL: EMS_BASE_URL };
      const state = loadSessionState(userId);
      if (state) opts.storageState = state;
      const ctx = await browser.newContext(opts);
      // images/fonts are never needed for form work: skip them to load pages faster
      await ctx.route("**/*", (r) => (["image", "font", "media"].includes(r.request().resourceType()) ? r.abort() : r.continue()));
      return ctx;
    })();
    entry = { ctxPromise, lastUsed: Date.now() };
    contexts.set(userId, entry);
  }
  entry.lastUsed = Date.now();
  return entry.ctxPromise;
}

setInterval(async () => {
  for (const [userId, e] of contexts) {
    if (Date.now() - e.lastUsed > IDLE_MS && !(e.busyPages > 0)) {
      contexts.delete(userId);
      const ctx = await e.ctxPromise.catch(() => null);
      if (ctx && ctx.pages().length === 0) await ctx.close().catch(() => {});
      else if (ctx) contexts.set(userId, e); // pages still open (unsubmitted fill) -> keep
    }
  }
}, 60 * 1000).unref();

const isLoginUrl = (url) => /\/Account\/Login/i.test(url);

async function performLogin(page, email, password) {
  await page.goto("/Account/Login", { waitUntil: "domcontentloaded" });
  const emailInput = page
    .locator("#Email, input[name='Email'], input[type='email'], input[name='UserName'], input[name='Username']")
    .first();
  const passwordInput = page.locator("#Password, input[name='Password'], input[type='password']").first();
  await emailInput.waitFor({ state: "visible", timeout: 15000 });
  await emailInput.fill(email);
  await passwordInput.fill(password);
  const signIn = page
    .locator("button:has-text('Sign in'), button:has-text('Log in'), input[type='submit']")
    .first();
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null),
    signIn.click(),
  ]);
  await page.waitForTimeout(500);
  if (isLoginUrl(page.url())) {
    const err = await page
      .locator(".validation-summary-errors, .field-validation-error, .alert-danger")
      .first()
      .innerText()
      .catch(() => null);
    throw new Error("EMS rejected the login" + (err ? `: ${err.trim()}` : " - check email/password."));
  }
}

/** Used by the OAuth login page: verifies credentials in an isolated context. */
export async function verifyCredentials(email, password) {
  return withJob(async () => {
    const browser = await getBrowser();
    const ctx = await browser.newContext({ baseURL: EMS_BASE_URL });
    try {
      const page = await ctx.newPage();
      await performLogin(page, email, password);
      return await ctx.storageState();
    } finally {
      await ctx.close().catch(() => {});
    }
  });
}

/** Returns a logged-in page for this user, re-logging-in with stored creds if needed. */
export async function getAuthenticatedPage(userId) {
  const context = await getContext(userId);
  const page = await context.newPage();
  await page.goto("/Task/AddEdit", { waitUntil: "domcontentloaded" });
  if (isLoginUrl(page.url())) {
    const creds = getUserCreds(userId);
    if (!creds) {
      await page.close();
      throw new Error("No saved EMS credentials for this user. Disconnect and reconnect the connector.");
    }
    try {
      await performLogin(page, creds.email, creds.password);
    } catch (e) {
      await page.close();
      throw new Error(`${e.message} (If you changed your EMS password, disconnect and reconnect the connector.)`);
    }
    saveSessionState(userId, await context.storageState());
    await page.goto("/Task/AddEdit", { waitUntil: "domcontentloaded" });
  }
  return page;
}

// ---- fast path: plain HTTP with the user's session cookies (no page load) -----
const needsLogin = (r) =>
  r.status() === 401 || ([301, 302, 303, 307].includes(r.status()) && /\/Account\/Login/i.test(r.headers()["location"] || ""));

/** HTTP request as this user; re-logs-in once if the EMS session expired. Redirects are NOT followed. */
export async function apiRequest(userId, method, url, opts = {}) {
  const ctx = await getContext(userId);
  const go = () => ctx.request.fetch(url, { method, maxRedirects: 0, failOnStatusCode: false, ...opts });
  let r = await go();
  if (needsLogin(r)) {
    await (await getAuthenticatedPage(userId)).close();
    r = await go();
    if (needsLogin(r)) throw new Error("EMS login failed - disconnect and reconnect the connector.");
  }
  return r;
}

// Parses HTML in a blank, network-less page via DOMParser (scripts stay inert). `fn` must be self-contained.
let parserPage = null;
export async function parseHtml(html, fn, arg) {
  if (!parserPage || parserPage.isClosed()) {
    const b = await getBrowser();
    parserPage = await (await b.newContext()).newPage();
  }
  return parserPage.evaluate(([h, src, a]) => (0, eval)(src)(new DOMParser().parseFromString(h, "text/html"), a), [html, fn.toString(), arg]);
}

export async function closeAll() {
  for (const [, e] of contexts) (await e.ctxPromise.catch(() => null))?.close().catch(() => {});
  contexts.clear();
  if (browserPromise) (await browserPromise.catch(() => null))?.close().catch(() => {});
}
