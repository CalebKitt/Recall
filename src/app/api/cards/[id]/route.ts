import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { cardVariants, cards } from "@/lib/db/schema";
import { requireUserId } from "@/lib/auth";
import { json, notFound, route } from "@/lib/api";
import { newCardState } from "@/lib/srs";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const patchCard = z.object({
  front: z.string().trim().min(1).max(4000).optional(),
  back: z.string().trim().min(1).max(4000).optional(),
  hint: z.string().trim().max(4000).optional(),
  tags: z.array(z.string().trim().max(48)).max(20).optional(),
  suspended: z.boolean().optional(),
  /** Wipe scheduling and send the card back to the new queue. */
  reset: z.boolean().optional(),
});

export const PATCH = route(async (req: Request, { params }: Params) => {
  const userId = await requireUserId();
  const { id } = await params;

  const existing = await db.query.cards.findFirst({
    where: and(eq(cards.id, id), eq(cards.userId, userId)),
  });
  if (!existing) throw notFound("Card not found");

  const body = patchCard.parse(await req.json());
  const { reset, ...fields } = body;

  const patch: Record<string, unknown> = { ...fields, updatedAt: new Date() };

  if (reset) {
    const fresh = newCardState();
    Object.assign(patch, {
      state: fresh.state,
      learningStep: fresh.learningStep,
      intervalDays: fresh.intervalDays,
      ease: fresh.ease,
      reps: fresh.reps,
      lapses: fresh.lapses,
      dueAt: new Date(),
      lastReviewedAt: null,
      // Review history is kept, but the card's own counters start over so the
      // "accuracy since reset" reading is meaningful.
      totalReviews: 0,
      correctReviews: 0,
    });
  }

  const [card] = await db
    .update(cards)
    .set(patch)
    .where(and(eq(cards.id, id), eq(cards.userId, userId)))
    .returning();

  // Editing the prompt or answer invalidates any cached AI rewordings.
  if (body.front !== undefined || body.back !== undefined || body.hint !== undefined) {
    await db.delete(cardVariants).where(eq(cardVariants.cardId, id));
  }

  return json({ card });
});

export const DELETE = route(async (_req: Request, { params }: Params) => {
  const userId = await requireUserId();
  const { id } = await params;

  const deleted = await db
    .delete(cards)
    .where(and(eq(cards.id, id), eq(cards.userId, userId)))
    .returning({ id: cards.id });

  if (deleted.length === 0) throw notFound("Card not found");
  return json({ ok: true });
});
