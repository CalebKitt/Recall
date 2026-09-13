import { count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { cards, decks } from "@/lib/db/schema";
import { requireUserId } from "@/lib/auth";
import { json, route } from "@/lib/api";
import { getDueCounts } from "@/lib/study";

export const dynamic = "force-dynamic";

const createDeck = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  description: z.string().trim().max(2000).optional().default(""),
  topic: z.string().trim().max(200).optional().default(""),
  color: z.string().trim().max(24).optional().default("indigo"),
});

/** All of the signed-in user's decks, each with live due counts. */
export const GET = route(async () => {
  const userId = await requireUserId();

  const rows = await db
    .select({
      id: decks.id,
      name: decks.name,
      description: decks.description,
      topic: decks.topic,
      color: decks.color,
      createdAt: decks.createdAt,
      updatedAt: decks.updatedAt,
      cardCount: count(cards.id),
      dueCount: sql<number>`count(*) filter (where ${cards.dueAt} <= now() and not ${cards.suspended} and ${cards.state} <> 'new')::int`,
      newCount: sql<number>`count(*) filter (where ${cards.state} = 'new' and not ${cards.suspended})::int`,
    })
    .from(decks)
    .leftJoin(cards, eq(cards.deckId, decks.id))
    .where(eq(decks.userId, userId))
    .groupBy(decks.id)
    .orderBy(decks.name);

  // Raw counts ignore the daily caps; re-derive the capped numbers per deck so
  // the badges match what a study session will actually serve.
  const withCaps = await Promise.all(
    rows.map(async (deck) => ({
      ...deck,
      counts: await getDueCounts(db, userId, deck.id),
    })),
  );

  return json({ decks: withCaps });
});

export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  const body = createDeck.parse(await req.json());

  const [deck] = await db
    .insert(decks)
    .values({ userId, ...body })
    .returning();

  return json({ deck }, 201);
});
