import fs from "fs";
import path from "path";

// Minimal .env loader (no extra dependency)
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return v;
}

export const PORT = parseInt(process.env.PORT || "3000", 10);
export const HOST = process.env.HOST || "127.0.0.1"; // 0.0.0.0 in containers; IIS proxies to 127.0.0.1
// Render sets RENDER_EXTERNAL_URL itself, so PUBLIC_URL is optional there
const publicUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
if (!publicUrl) throw new Error("Missing required env var PUBLIC_URL (see .env.example)");
export const PUBLIC_URL = publicUrl.replace(/\/+$/, "");
export const DATABASE_URL = process.env.DATABASE_URL || ""; // set => users/tokens/sessions live in Postgres instead of data\
export const SECRET = required("SECRET");
if (SECRET.length < 32) throw new Error("SECRET must be at least 32 characters");
export const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
export const EMS_BASE_URL = (process.env.EMS_BASE_URL || "https://ems.theonetechnologies.co.in").replace(/\/+$/, "");
export const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || "3", 10);
