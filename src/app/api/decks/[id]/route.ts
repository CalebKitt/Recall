import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { decks } from "@/lib/db/schema";
import { requireUserId } from "@/lib/auth";
import { json, notFound, route } from "@/lib/api";
import { getDueCounts } from "@/lib/study";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const patchDeck = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  topic: z.string().trim().max(200).optional(),
  color: z.string().trim().max(24).optional(),
});

/** Load a deck, asserting the caller owns it. */
async function ownedDeck(userId: string, id: string) {
  const deck = await db.query.decks.findFirst({
    where: and(eq(decks.id, id), eq(decks.userId, userId)),
  });
  if (!deck) throw notFound("Deck not found");
  return deck;
}

export const GET = route(async (_req: Request, { params }: Params) => {
  const userId = await requireUserId();
  const { id } = await params;
  const deck = await ownedDeck(userId, id);
  return json({ deck, counts: await getDueCounts(db, userId, id) });
});

export const PATCH = route(async (req: Request, { params }: Params) => {
  const userId = await requireUserId();
  const { id } = await params;
  await ownedDeck(userId, id);

  const body = patchDeck.parse(await req.json());
  const [deck] = await db
    .update(decks)
    .set({ ...body, updatedAt: new Date() })
    .where(and(eq(decks.id, id), eq(decks.userId, userId)))
    .returning();

  return json({ deck });
});

/** Deleting a deck cascades to its cards, reviews, variants and suggestions. */
export const DELETE = route(async (_req: Request, { params }: Params) => {
  const userId = await requireUserId();
  const { id } = await params;
  await ownedDeck(userId, id);

  await db.delete(decks).where(and(eq(decks.id, id), eq(decks.userId, userId)));
  return json({ ok: true });
});
