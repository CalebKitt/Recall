import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../../src/lib/db/schema.ts";
import type { Db } from "../../src/lib/db/types.ts";

/**
 * Spin up a throwaway Postgres in this process and apply the real migrations.
 *
 * PGlite is a genuine Postgres build compiled to WASM, so the schema, the
 * `filter (where …)` aggregates, `on conflict` upserts and cascading deletes
 * all behave as they will in production — no mocks, no query duplication.
 */
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });

  const dir = path.join(process.cwd(), "drizzle");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    throw new Error("No migrations found — run `npm run db:generate` first.");
  }

  for (const file of files) {
    const sql = readFileSync(path.join(dir, file), "utf8");
    // drizzle-kit separates statements with this marker.
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }

  return {
    db: db as unknown as Db,
    close: () => client.close(),
  };
}

/** Insert a user plus their settings row and return the id. */
export async function makeUser(
  db: Db,
  opts: { timezone?: string; newCardsPerDay?: number; maxReviewsPerDay?: number } = {},
): Promise<string> {
  const [user] = await db
    .insert(schema.users)
    .values({ name: "Test User", email: `test-${crypto.randomUUID()}@example.com` })
    .returning();

  await db.insert(schema.userSettings).values({
    userId: user.id,
    timezone: opts.timezone ?? "UTC",
    newCardsPerDay: opts.newCardsPerDay ?? 20,
    maxReviewsPerDay: opts.maxReviewsPerDay ?? 200,
  });

  return user.id;
}

export async function makeDeck(db: Db, userId: string, name = "Test Deck"): Promise<string> {
  const [deck] = await db.insert(schema.decks).values({ userId, name }).returning();
  return deck.id;
}

export async function makeCards(
  db: Db,
  deckId: string,
  userId: string,
  rows: { front: string; back: string }[],
): Promise<string[]> {
  const inserted = await db
    .insert(schema.cards)
    .values(rows.map((r) => ({ ...r, deckId, userId })))
    .returning({ id: schema.cards.id });
  return inserted.map((r) => r.id);
}

export { schema };
