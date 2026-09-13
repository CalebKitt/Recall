import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { aiUsage, cardSuggestions, cards, decks } from "@/lib/db/schema";
import { requireUserId } from "@/lib/auth";
import { badRequest, json, notFound, route } from "@/lib/api";
import { GeminiError, geminiModel, suggestCards } from "@/lib/gemini";
import { resolveGeminiKey } from "@/lib/settings";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const generateBody = z.object({ count: z.number().int().min(1).max(20).optional() });

/** Normalised identity for a suggestion, used to avoid repeats. */
const keyOf = (front: string, back: string) =>
  `${front.trim().toLowerCase()}|${back.trim().toLowerCase()}`.replace(/\s+/g, " ").slice(0, 500);

async function ownedDeck(userId: string, deckId: string) {
  const deck = await db.query.decks.findFirst({
    where: and(eq(decks.id, deckId), eq(decks.userId, userId)),
  });
  if (!deck) throw notFound("Deck not found");
  return deck;
}

/** Suggestions still awaiting a decision. */
export const GET = route(async (_req: Request, { params }: Params) => {
  const userId = await requireUserId();
  const { id } = await params;
  await ownedDeck(userId, id);

  const pending = await db
    .select()
    .from(cardSuggestions)
    .where(and(eq(cardSuggestions.deckId, id), eq(cardSuggestions.status, "pending")))
    .orderBy(cardSuggestions.createdAt);

  return json({ suggestions: pending });
});

/**
 * Ask Gemini for new cards that fit this deck's subject without duplicating
 * anything already in it.
 *
 * The model sees the existing cards and every previously rejected suggestion,
 * and we still dedupe its output locally — the model is asked not to repeat
 * itself, but correctness here does not depend on it obeying.
 */
export const POST = route(async (req: Request, { params }: Params) => {
  const userId = await requireUserId();
  const { id } = await params;
  const deck = await ownedDeck(userId, id);

  const raw = await req.text();
  const { count } = generateBody.parse(raw ? JSON.parse(raw) : {});

  const resolved = await resolveGeminiKey(db, userId);
  if (!resolved) {
    throw badRequest("No Gemini API key configured. Add one in Settings to generate suggestions.");
  }

  const existing = await db
    .select({ front: cards.front, back: cards.back })
    .from(cards)
    .where(eq(cards.deckId, id));

  if (existing.length === 0 && !deck.topic && !deck.description) {
    throw badRequest(
      "Add at least one card, or set the deck's topic, so suggestions have something to build on.",
    );
  }

  const priorSuggestions = await db
    .select({ front: cardSuggestions.front, back: cardSuggestions.back, status: cardSuggestions.status, dedupeKey: cardSuggestions.dedupeKey })
    .from(cardSuggestions)
    .where(eq(cardSuggestions.deckId, id));

  const rejected = priorSuggestions.filter((s) => s.status === "rejected").map((s) => s.front);

  let result: Awaited<ReturnType<typeof suggestCards>>;
  try {
    result = await suggestCards({
      apiKey: resolved.apiKey,
      deckName: deck.name,
      description: deck.description,
      topic: deck.topic,
      existing,
      rejected,
      count: count ?? 8,
    });
  } catch (err) {
    await db.insert(aiUsage).values({
      userId,
      kind: "suggest",
      model: geminiModel,
      ok: false,
      detail: { deckId: id, error: err instanceof GeminiError ? err.message : String(err) },
    });
    throw err;
  }

  // Reject anything matching an existing card or a suggestion already seen.
  const taken = new Set<string>([
    ...existing.map((c) => keyOf(c.front, c.back)),
    ...priorSuggestions.map((s) => s.dedupeKey),
  ]);
  const existingAnswers = new Set(existing.map((c) => c.back.trim().toLowerCase()));

  const fresh = result.cards.filter((c) => {
    const key = keyOf(c.front, c.back);
    if (taken.has(key)) return false;
    // Same answer with a different question is still the same card.
    if (existingAnswers.has(c.back.trim().toLowerCase())) return false;
    taken.add(key);
    return true;
  });

  const inserted =
    fresh.length > 0
      ? await db
          .insert(cardSuggestions)
          .values(
            fresh.map((c) => ({
              deckId: id,
              userId,
              front: c.front,
              back: c.back,
              rationale: c.rationale,
              dedupeKey: keyOf(c.front, c.back),
            })),
          )
          .onConflictDoNothing()
          .returning()
      : [];

  await db.insert(aiUsage).values({
    userId,
    kind: "suggest",
    model: geminiModel,
    ok: true,
    detail: {
      deckId: id,
      scope: result.scope,
      returned: result.cards.length,
      kept: inserted.length,
      keySource: resolved.source,
    },
  });

  return json({
    suggestions: inserted,
    scope: result.scope,
    filtered: result.cards.length - inserted.length,
  });
});

/** Clear pending suggestions without acting on them. */
export const DELETE = route(async (_req: Request, { params }: Params) => {
  const userId = await requireUserId();
  const { id } = await params;
  await ownedDeck(userId, id);

  await db
    .delete(cardSuggestions)
    .where(and(eq(cardSuggestions.deckId, id), eq(cardSuggestions.status, "pending")));

  return json({ ok: true });
});
