/**
 * Disposable local Postgres, for trying the app without installing anything.
 *
 * Runs PGlite (Postgres compiled to WASM) behind a real Postgres wire-protocol
 * socket, so `postgres://…@localhost:5433/postgres` works exactly like a normal
 * server. Data lives in .pglite-data/ and persists between runs.
 *
 *   node scripts/dev-db.mjs
 *
 * This is a convenience for local development only — use Neon or a real
 * Postgres for anything you care about keeping.
 */

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.DEV_DB_PORT ?? 5433);
const DATA_DIR = path.join(process.cwd(), ".pglite-data");

const db = await PGlite.create({ dataDir: DATA_DIR });

// Apply any migrations that have not been applied yet. Tracked in a tiny table
// of our own so re-running this script is always safe.
await db.exec(`create table if not exists _dev_migrations (name text primary key, applied_at timestamptz default now())`);

const applied = new Set(
  (await db.query("select name from _dev_migrations")).rows.map((r) => r.name),
);

const dir = path.join(process.cwd(), "drizzle");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

for (const file of files) {
  if (applied.has(file)) continue;
  const sql = readFileSync(path.join(dir, file), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) await db.exec(trimmed);
  }
  await db.query("insert into _dev_migrations (name) values ($1)", [file]);
  console.log(`applied migration: ${file}`);
}

const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1" });
await server.start();

console.log(`\nDev Postgres listening on port ${PORT}`);
console.log(`DATABASE_URL="postgresql://postgres:postgres@localhost:${PORT}/postgres"`);
console.log(`Data directory: ${DATA_DIR}\nPress Ctrl+C to stop.\n`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await server.stop();
    await db.close();
    process.exit(0);
  });
}
