/**
 * Copy everything from the local development database into a real Postgres.
 *
 *   node scripts/migrate-to-cloud.mjs "postgresql://user:pass@host/db?sslmode=require"
 *
 * Reads the local PGlite data directory directly, so BOTH `npm run dev` and
 * `node scripts/dev-db.mjs` must be stopped first — that database serves a
 * single connection and the running app holds it.
 *
 * Rows keep their original ids, and every insert is ON CONFLICT DO NOTHING, so
 * running this twice does not duplicate anything. Run `npm run db:migrate`
 * against the target first to create the tables.
 */

import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import path from "node:path";
import { existsSync } from "node:fs";

const target = process.argv[2] || process.env.TARGET_DATABASE_URL;
if (!target) {
  console.error("Usage: node scripts/migrate-to-cloud.mjs <target-connection-string>");
  process.exit(1);
}

const DATA_DIR = path.join(process.cwd(), ".pglite-data");
if (!existsSync(DATA_DIR)) {
  console.error(`No local database found at ${DATA_DIR}. Nothing to migrate.`);
  process.exit(1);
}

/**
 * Parent tables first: every table's foreign keys must already be satisfied by
 * the time its rows are inserted.
 */
const TABLES = [
  "user",
  "account",
  "session",
  "verificationToken",
  "user_settings",
  "deck",
  "card",
  "review",
  "daily_stat",
  "card_variant",
  "card_suggestion",
  "ai_usage",
];

const CHUNK = 500;
const quote = (id) => `"${id.replace(/"/g, '""')}"`;

let source;
let dest;

try {
  source = await PGlite.create({ dataDir: DATA_DIR });
} catch (err) {
  console.error(
    "Could not open the local database. Stop `npm run dev` and `node scripts/dev-db.mjs` first.\n",
    err.message,
  );
  process.exit(1);
}

dest = postgres(target, { max: 1, prepare: false, onnotice: () => {} });

try {
  // Fail early and clearly if the schema has not been created yet.
  const [{ count: tableCount }] = await dest`
    select count(*)::int as count
    from information_schema.tables
    where table_schema = 'public' and table_name = 'deck'
  `;
  if (tableCount === 0) {
    console.error('Target database has no tables. Run "npm run db:migrate" against it first.');
    process.exit(1);
  }

  let grandTotal = 0;

  for (const table of TABLES) {
    const { rows } = await source.query(`select * from ${quote(table)}`);
    if (rows.length === 0) {
      console.log(`${table.padEnd(18)} 0`);
      continue;
    }

    const columns = Object.keys(rows[0]);
    let copied = 0;

    for (let i = 0; i < rows.length; i += CHUNK) {
      const batch = rows.slice(i, i + CHUNK);
      // postgres.js expands an array of objects into a multi-row INSERT.
      const result = await dest`
        insert into ${dest(table)} ${dest(batch, ...columns)}
        on conflict do nothing
      `;
      copied += result.count ?? 0;
    }

    grandTotal += copied;
    const skipped = rows.length - copied;
    console.log(`${table.padEnd(18)} ${copied}${skipped > 0 ? `  (${skipped} already present)` : ""}`);
  }

  console.log(`\nCopied ${grandTotal} rows.`);
  console.log("Point DATABASE_URL at the target and restart the app to use it.");
} catch (err) {
  console.error("\nMigration failed:", err.message);
  process.exitCode = 1;
} finally {
  await dest?.end({ timeout: 5 });
  await source?.close();
}
