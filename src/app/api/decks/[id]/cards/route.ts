import { and, asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { cards, decks } from "@/lib/db/schema";
import { requireUserId } from "@/lib/auth";
import { json, notFound, route } from "@/lib/api";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const createCard = z.object({
  front: z.string().trim().min(1, "Question is required").max(4000),
  back: z.string().trim().min(1, "Answer is required").max(4000),
  hint: z.string().trim().max(4000).optional().default(""),
  tags: z.array(z.string().trim().max(48)).max(20).optional().default([]),
});

/** Accepts one card or a batch, so paste-import and the editor share a route. */
const createBody = z.union([createCard, z.object({ cards: z.array(createCard).min(1).max(500) })]);

async function assertDeck(userId: string, deckId: string) {
  const deck = await db.query.decks.findFirst({
    where: and(eq(decks.id, deckId), eq(decks.userId, userId)),
  });
  if (!deck) throw notFound("Deck not found");
  return deck;
}

export const GET = route(async (req: Request, { params }: Params) => {
  const userId = await requireUserId();
  const { id } = await params;
  await assertDeck(userId, id);

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200) || 200, 500);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
  const sort = url.searchParams.get("sort") ?? "created";

  const filter = q
    ? and(
        eq(cards.deckId, id),
        or(ilike(cards.front, `%${q}%`), ilike(cards.back, `%${q}%`), ilike(cards.hint, `%${q}%`)),
      )
    : eq(cards.deckId, id);

  const orderBy =
    sort === "due"
      ? asc(cards.dueAt)
      : sort === "accuracy"
        ? // Cards never reviewed sort last rather than appearing as 0%.
          asc(sql`case when ${cards.totalReviews} = 0 then 2 else ${cards.correctReviews}::float / ${cards.totalReviews} end`)
        : sort === "lapses"
          ? desc(cards.lapses)
          : asc(cards.createdAt);

  const [rows, [total]] = await Promise.all([
    db.select().from(cards).where(filter).orderBy(orderBy).limit(limit).offset(offset),
    db.select({ n: count() }).from(cards).where(filter),
  ]);

  return json({ cards: rows, total: total?.n ?? 0, limit, offset });
});

export const POST = route(async (req: Request, { params }: Params) => {
  const userId = await requireUserId();
  const { id } = await params;
  await assertDeck(userId, id);

  const body = createBody.parse(await req.json());
  const incoming = "cards" in body ? body.cards : [body];

  const inserted = await db
    .insert(cards)
    .values(incoming.map((c) => ({ ...c, deckId: id, userId })))
    .returning();

  await db.update(decks).set({ updatedAt: new Date() }).where(eq(decks.id, id));

  return json({ cards: inserted, created: inserted.length }, 201);
});
