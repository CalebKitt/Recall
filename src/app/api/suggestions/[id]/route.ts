import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { cardSuggestions, cards, decks } from "@/lib/db/schema";
import { requireUserId } from "@/lib/auth";
import { json, notFound, route } from "@/lib/api";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const decisionBody = z.object({
  action: z.enum(["accept", "reject"]),
  /** Accepting after editing the text in place. */
  front: z.string().trim().min(1).max(4000).optional(),
  back: z.string().trim().min(1).max(4000).optional(),
});

/**
 * Accept a suggestion (creating a real card) or reject it.
 *
 * Rejected rows are kept rather than deleted so the same idea is excluded from
 * future generations.
 */
export const POST = route(async (req: Request, { params }: Params) => {
  const userId = await requireUserId();
  const { id } = await params;
  const input = decisionBody.parse(await req.json());

  const suggestion = await db.query.cardSuggestions.findFirst({
    where: and(eq(cardSuggestions.id, id), eq(cardSuggestions.userId, userId)),
  });
  if (!suggestion) throw notFound("Suggestion not found");

  if (input.action === "reject") {
    await db
      .update(cardSuggestions)
      .set({ status: "rejected" })
      .where(eq(cardSuggestions.id, id));
    return json({ ok: true, status: "rejected" });
  }

  const front = input.front ?? suggestion.front;
  const back = input.back ?? suggestion.back;

  const created = await db.transaction(async (tx) => {
    const [card] = await tx
      .insert(cards)
      .values({ deckId: suggestion.deckId, userId, front, back })
      .returning();

    await tx
      .update(cardSuggestions)
      .set({ status: "accepted" })
      .where(eq(cardSuggestions.id, id));

    await tx.update(decks).set({ updatedAt: new Date() }).where(eq(decks.id, suggestion.deckId));

    return card;
  });

  return json({ ok: true, status: "accepted", card: created }, 201);
});
