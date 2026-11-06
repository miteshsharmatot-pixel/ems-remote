// Tiny key/value store on Postgres, used instead of the data\ folder on hosts with no persistent disk (e.g. Render free).
export async function createPgStore(url) {
  const { default: pg } = await import("pg");
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    ssl: local ? false : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX || 3),
  });
  pool.on("error", (e) => console.error("Postgres idle client error:", e.message)); // e.g. serverless DB closed an idle connection
  await pool.query("create table if not exists kv (key text primary key, value text not null)");
  return {
    get: async (k) => (await pool.query("select value from kv where key = $1", [k])).rows[0]?.value ?? null,
    set: (k, v) => pool.query("insert into kv (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value", [k, v]),
    del: (k) => pool.query("delete from kv where key = $1", [k]),
    all: async (prefix) => (await pool.query("select key, value from kv where key like $1", [prefix + "%"])).rows.map((r) => [r.key, r.value]),
    close: () => pool.end(),
  };
}
