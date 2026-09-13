import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { aiUsage, cardVariants, cards, decks } from "@/lib/db/schema";
import { requireUserId } from "@/lib/auth";
import { json, notFound, route } from "@/lib/api";
import { contentHash } from "@/lib/crypto";
import { GeminiError, geminiModel, rewordPrompts } from "@/lib/gemini";
import { getSettings, resolveGeminiKey } from "@/lib/settings";

export const dynamic = "force-dynamic";

const body = z.object({
  cardId: z.string().uuid(),
  /** Set when the reader asks for a different wording than the one on screen. */
  refresh: z.boolean().optional(),
  /** The variant currently displayed, so it is not served again. */
  currentVariantId: z.string().uuid().optional(),
});

/** Keep a small pool per card and rotate through it. */
const TARGET_VARIANTS = 4;
const GENERATE_BATCH = 3;

/**
 * Return the prompt to show for a card — an AI rewording when the feature is
 * on, otherwise the card's own text.
 *
 * Variants are cached per card-content hash and served least-recently-shown
 * first, so a normal review is a single indexed query and the model is only
 * called when the pool needs topping up. Any AI failure degrades to the
 * original wording rather than blocking the review.
 */
export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  const { cardId, refresh = false, currentVariantId } = body.parse(await req.json());

  const card = await db.query.cards.findFirst({
    where: and(eq(cards.id, cardId), eq(cards.userId, userId)),
  });
  if (!card) throw notFound("Card not found");

  const settings = await getSettings(db, userId);
  if (!settings.aiRewordEnabled) {
    return json({ text: card.front, isVariant: false, reason: "disabled" });
  }

  const hash = contentHash(card.front, card.back, card.hint);

  const pool = await db
    .select()
    .from(cardVariants)
    .where(and(eq(cardVariants.cardId, cardId), eq(cardVariants.sourceHash, hash)))
    // Never-shown variants first, then least recently shown. Written as raw SQL
    // because the direction must precede NULLS FIRST; wrapping this in asc()
    // would emit "… nulls first asc", which Postgres rejects.
    .orderBy(sql`${cardVariants.lastShownAt} asc nulls first`, asc(cardVariants.timesShown));

  // Drop variants generated from an older version of the card.
  if (pool.length === 0) {
    await db.delete(cardVariants).where(eq(cardVariants.cardId, cardId));
  }

  // On a refresh, the wording already on screen is not a valid answer.
  const candidates = refresh && currentVariantId ? pool.filter((v) => v.id !== currentVariantId) : pool;
  let chosen = candidates[0] ?? null;

  // Generate when the pool is thin, and also when a refresh has nothing else
  // cached to offer — that request exists precisely to produce something new.
  if (pool.length < TARGET_VARIANTS || (refresh && !chosen)) {
    const resolved = await resolveGeminiKey(db, userId);

    if (!resolved) {
      return json({
        text: chosen?.text ?? card.front,
        isVariant: Boolean(chosen),
        reason: "no-key",
        error: "No Gemini API key configured. Add one in Settings to use AI rewording.",
      });
    }

    const deck = await db.query.decks.findFirst({ where: eq(decks.id, card.deckId) });

    try {
      const variants = await rewordPrompts({
        apiKey: resolved.apiKey,
        front: card.front,
        back: card.back,
        hint: card.hint,
        deckName: deck?.name,
        count: GENERATE_BATCH,
      });

      const fresh = variants.filter((v) => !pool.some((p) => p.text === v));

      // Prefer a newly generated wording when refreshing, so asking again
      // visibly changes the question rather than cycling the same few.
      const preferFresh = refresh;

      if (fresh.length > 0) {
        const inserted = await db
          .insert(cardVariants)
          .values(fresh.map((text) => ({ cardId, text, sourceHash: hash })))
          .returning();
        if (!chosen || preferFresh) chosen = inserted[0];
      }

      await db.insert(aiUsage).values({
        userId,
        kind: "reword",
        model: geminiModel,
        ok: true,
        detail: { cardId, generated: fresh.length, keySource: resolved.source, refresh },
      });
    } catch (err) {
      const message = err instanceof GeminiError ? err.message : "AI rewording failed";
      await db.insert(aiUsage).values({
        userId,
        kind: "reword",
        model: geminiModel,
        ok: false,
        detail: { cardId, error: message },
      });

      // Serve a cached variant if we have one, else the original wording.
      if (!chosen) {
        return json({ text: card.front, isVariant: false, reason: "error", error: message });
      }
    }
  }

  if (!chosen) {
    // A refresh that produced nothing keeps the current wording rather than
    // dropping the reader back to the original mid-review.
    if (refresh && currentVariantId) {
      const current = pool.find((v) => v.id === currentVariantId);
      if (current) {
        return json({
          text: current.text,
          isVariant: true,
          variantId: current.id,
          reason: "no-alternative",
          error: "No other wording available right now. Try again in a moment.",
        });
      }
    }
    return json({ text: card.front, isVariant: false, reason: "empty" });
  }

  await db
    .update(cardVariants)
    .set({ timesShown: sql`${cardVariants.timesShown} + 1`, lastShownAt: new Date() })
    .where(eq(cardVariants.id, chosen.id));

  return json({ text: chosen.text, isVariant: true, variantId: chosen.id });
});
