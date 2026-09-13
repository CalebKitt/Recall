import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.",
  );
}

declare global {
  // eslint-disable-next-line no-var
  var __recallSql: ReturnType<typeof postgres> | undefined;
}

/**
 * Pool size. Lower it via DB_POOL_MAX when the far end cannot take many
 * connections — a serverless deployment fanning out across many instances, or
 * the single-connection dev server in scripts/dev-db.mjs (which needs 1).
 */
const poolMax = Number(process.env.DB_POOL_MAX) || (process.env.NODE_ENV === "production" ? 10 : 3);

/**
 * Seconds an idle connection is kept. Set DB_IDLE_TIMEOUT=0 to hold connections
 * open indefinitely — needed by the bundled dev database, which serves a single
 * connection and does not cope with the pool cycling it.
 */
const idleTimeout = process.env.DB_IDLE_TIMEOUT === undefined ? 20 : Number(process.env.DB_IDLE_TIMEOUT);

/**
 * Next.js dev-mode hot reloading re-evaluates modules, which would otherwise
 * open a new pool on every edit until Postgres refuses connections. Cache the
 * client on globalThis so reloads reuse it.
 *
 * `prepare: false` is required for transaction-pooled connections (Neon's
 * pooler, PgBouncer) which cannot support session-scoped prepared statements.
 */
const client =
  globalThis.__recallSql ??
  postgres(connectionString, {
    max: poolMax,
    idle_timeout: idleTimeout > 0 ? idleTimeout : undefined,
    prepare: false,
  });

if (process.env.NODE_ENV !== "production") globalThis.__recallSql = client;

export const db = drizzle(client, { schema });
export { schema };
