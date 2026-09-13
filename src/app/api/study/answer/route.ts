import { z } from "zod";
import { requireUserId } from "@/lib/auth";
import { json, route } from "@/lib/api";
import { answerCard } from "@/lib/study";
import type { Rating } from "@/lib/srs";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const body = z.object({
  cardId: z.string().uuid(),
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  /** Time the card was on screen, used for the average-seconds statistic. */
  elapsedMs: z.number().int().min(0).max(3_600_000).optional(),
  usedAiVariant: z.boolean().optional(),
});

export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  const input = body.parse(await req.json());

  const result = await answerCard(db, {
    userId,
    cardId: input.cardId,
    rating: input.rating as Rating,
    elapsedMs: input.elapsedMs,
    usedAiVariant: input.usedAiVariant,
  });

  return json(result);
});
