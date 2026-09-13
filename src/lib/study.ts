import { and, asc, count, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "./db/types";
import { cards, dailyStats, decks, reviews, type Card } from "./db/schema";
import { getSettings } from "./settings";
import { computeLongestStreak, computeStreak, dayStartUtc, localDay, safeZone } from "./time";
import {
  DEFAULT_SRS_CONFIG,
  previewIntervals,
  scheduleCard,
  type Rating,
  type SchedulingState,
} from "./srs";
import { HttpError, notFound } from "./errors";

/**
 * Learning cards coming due within this window count as outstanding and are
 * served by the queue — Anki calls it the "learn ahead limit".
 *
 * The same window MUST be used by `getDueCounts` and `buildQueue`. If the
 * counts ignored it, a card sitting in a ten-minute learning step would be
 * invisible, the day would be marked complete while it was still pending, and
 * the streak would be awarded early. If the counts used a wider window than the
 * queue, the day could never be completed at all.
 */
const LEARNING_LOOKAHEAD_MS = 20 * 60_000;

/**
 * How far ahead a "review early" session may pull cards from. A week covers
 * the cards you would plausibly want to get in front of; anything further out
 * is not "early", it is unrelated.
 */
const REVIEW_AHEAD_MS = 7 * 86_400_000;

export interface QueueCard {
  id: string;
  deckId: string;
  deckName: string;
  front: string;
  back: string;
  hint: string;
  tags: string[];
  state: Card["state"];
  dueAt: string;
  intervalDays: number;
  ease: number;
  reps: number;
  lapses: number;
  totalReviews: number;
  correctReviews: number;
  /** Button labels ("1m", "10m", "3d", "8d") for this card's current state. */
  intervals: Record<Rating, string>;
}

export interface DueCounts {
  newCards: number;
  learning: number;
  review: number;
  total: number;
}

function toSchedulingState(card: Card): SchedulingState {
  return {
    state: card.state,
    learningStep: card.learningStep,
    intervalDays: card.intervalDays,
    ease: card.ease,
    reps: card.reps,
    lapses: card.lapses,
  };
}

function toQueueCard(card: Card, deckName: string, now: Date): QueueCard {
  return {
    id: card.id,
    deckId: card.deckId,
    deckName,
    front: card.front,
    back: card.back,
    hint: card.hint,
    tags: card.tags,
    state: card.state,
    dueAt: card.dueAt.toISOString(),
    intervalDays: card.intervalDays,
    ease: card.ease,
    reps: card.reps,
    lapses: card.lapses,
    totalReviews: card.totalReviews,
    correctReviews: card.correctReviews,
    intervals: previewIntervals(toSchedulingState(card), now),
  };
}

/**
 * How many new cards this user may still introduce today, and how many
 * reviews remain within their daily cap.
 *
 * Counted from the review log rather than a counter column so the numbers stay
 * correct even if a request fails partway through.
 */
async function remainingAllowance(
  db: Db,
  userId: string,
  deckId: string | null,
  day: string,
): Promise<{ newRemaining: number; reviewRemaining: number }> {
  const settings = await getSettings(db, userId);

  const scope = deckId
    ? and(eq(reviews.userId, userId), eq(reviews.localDay, day), eq(reviews.deckId, deckId))
    : and(eq(reviews.userId, userId), eq(reviews.localDay, day));

  const [introduced] = await db
    .select({ n: count() })
    .from(reviews)
    .where(and(scope, eq(reviews.stateBefore, "new")));

  const [reviewed] = await db
    .select({ n: count() })
    .from(reviews)
    .where(and(scope, ne(reviews.stateBefore, "new")));

  const newRemaining = Math.max(0, settings.newCardsPerDay - (introduced?.n ?? 0));
  const reviewRemaining =
    settings.maxReviewsPerDay > 0
      ? Math.max(0, settings.maxReviewsPerDay - (reviewed?.n ?? 0))
      : Number.MAX_SAFE_INTEGER;

  return { newRemaining, reviewRemaining };
}

/** Counts for the deck list and study header, with daily caps applied. */
export async function getDueCounts(
  db: Db,
  userId: string,
  deckId: string | null = null,
): Promise<DueCounts> {
  const settings = await getSettings(db, userId);
  const now = new Date();
  const day = localDay(now, safeZone(settings.timezone));
  const { newRemaining, reviewRemaining } = await remainingAllowance(db, userId, deckId, day);

  const base = deckId
    ? and(eq(cards.userId, userId), eq(cards.deckId, deckId), eq(cards.suspended, false))
    : and(eq(cards.userId, userId), eq(cards.suspended, false));

  const learnHorizon = new Date(now.getTime() + LEARNING_LOOKAHEAD_MS);

  const [[availableNew], [learningDue], [reviewDue]] = await Promise.all([
    db.select({ n: count() }).from(cards).where(and(base, eq(cards.state, "new"))),

    // Mirrors the queue's learn-ahead window, so counts and queue never disagree.
    db
      .select({ n: count() })
      .from(cards)
      .where(and(base, inArray(cards.state, ["learning", "relearning"]), lte(cards.dueAt, learnHorizon))),

    db
      .select({ n: count() })
      .from(cards)
      .where(and(base, eq(cards.state, "review"), lte(cards.dueAt, now))),
  ]);

  const newCards = Math.min(availableNew?.n ?? 0, newRemaining);
  const learning = learningDue?.n ?? 0;
  const review = Math.min(reviewDue?.n ?? 0, reviewRemaining);

  return { newCards, learning, review, total: newCards + learning + review };
}

/**
 * Build a study session queue.
 *
 * Ordering mirrors Anki: cards already in a learning step come first (they are
 * time-sensitive), then reviews interleaved with a capped number of new cards.
 *
 * With `ahead`, a deck that has nothing due also pulls in cards falling due
 * over the next few days, so "review early" has something to show instead of
 * an empty session.
 */
export async function buildQueue(
  db: Db,
  userId: string,
  deckId: string | null,
  limit = 60,
  opts: { ahead?: boolean } = {},
): Promise<{
  cards: QueueCard[];
  counts: DueCounts;
  nextDueAt: string | null;
  ahead: boolean;
}> {
  const settings = await getSettings(db, userId);
  const tz = safeZone(settings.timezone);
  const now = new Date();
  const day = localDay(now, tz);

  if (deckId) {
    const deck = await db.query.decks.findFirst({
      where: and(eq(decks.id, deckId), eq(decks.userId, userId)),
    });
    if (!deck) throw notFound("Deck not found");
  }

  const deckRows = await db
    .select({ id: decks.id, name: decks.name })
    .from(decks)
    .where(eq(decks.userId, userId));
  const deckNames = new Map(deckRows.map((d) => [d.id, d.name]));

  const base = deckId
    ? and(eq(cards.userId, userId), eq(cards.deckId, deckId), eq(cards.suspended, false))
    : and(eq(cards.userId, userId), eq(cards.suspended, false));

  const { newRemaining, reviewRemaining } = await remainingAllowance(db, userId, deckId, day);

  // Learning cards due now, plus any coming due shortly, so a session that is
  // otherwise empty does not end while cards are still mid-ladder.
  const learningCards = await db
    .select()
    .from(cards)
    .where(
      and(
        base,
        inArray(cards.state, ["learning", "relearning"]),
        lte(cards.dueAt, new Date(now.getTime() + LEARNING_LOOKAHEAD_MS)),
      ),
    )
    .orderBy(asc(cards.dueAt))
    .limit(limit);

  const reviewCards =
    reviewRemaining > 0
      ? await db
          .select()
          .from(cards)
          .where(and(base, eq(cards.state, "review"), lte(cards.dueAt, now)))
          .orderBy(asc(cards.dueAt))
          .limit(Math.min(limit, reviewRemaining))
      : [];

  const newCards =
    newRemaining > 0
      ? await db
          .select()
          .from(cards)
          .where(and(base, eq(cards.state, "new")))
          .orderBy(asc(cards.createdAt))
          .limit(Math.min(limit, newRemaining))
      : [];

  // Interleave new cards evenly through the reviews rather than front- or
  // back-loading them, which keeps the session from feeling like two chores.
  const mixed: Card[] = [];
  const totalMix = reviewCards.length + newCards.length;
  if (totalMix > 0) {
    const step = newCards.length > 0 ? totalMix / newCards.length : Infinity;
    let ri = 0;
    let ni = 0;
    for (let i = 0; i < totalMix; i++) {
      const wantNew = ni < newCards.length && i >= Math.floor(ni * step);
      if (wantNew) mixed.push(newCards[ni++]);
      else if (ri < reviewCards.length) mixed.push(reviewCards[ri++]);
      else if (ni < newCards.length) mixed.push(newCards[ni++]);
    }
  }

  let ordered = [...learningCards, ...mixed].slice(0, limit);

  // Only fall back to reviewing ahead once the real queue is exhausted, so a
  // normal session is never diluted with cards that are not actually due.
  let servingAhead = false;
  if (ordered.length === 0 && opts.ahead) {
    const upcoming = await db
      .select()
      .from(cards)
      .where(
        and(
          base,
          ne(cards.state, "new"),
          gt(cards.dueAt, now),
          lte(cards.dueAt, new Date(now.getTime() + REVIEW_AHEAD_MS)),
          // Skip anything already studied today. This keeps an early session
          // from re-drilling cards just answered — which is repetition, not
          // spaced repetition — and it guarantees the session terminates,
          // since answering a card stamps lastReviewedAt with today.
          or(
            isNull(cards.lastReviewedAt),
            lt(cards.lastReviewedAt, dayStartUtc(day, tz)),
          ),
        ),
      )
      .orderBy(asc(cards.dueAt))
      .limit(limit);

    if (upcoming.length > 0) {
      ordered = upcoming;
      servingAhead = true;
    }
  }

  // When nothing is due, tell the client when to come back.
  let nextDueAt: string | null = null;
  if (ordered.length === 0) {
    const [next] = await db
      .select({ dueAt: cards.dueAt })
      .from(cards)
      .where(and(base, ne(cards.state, "new"), gt(cards.dueAt, now)))
      .orderBy(asc(cards.dueAt))
      .limit(1);
    nextDueAt = next?.dueAt.toISOString() ?? null;
  }

  return {
    cards: ordered.map((c) => toQueueCard(c, deckNames.get(c.deckId) ?? "Deck", now)),
    counts: await getDueCounts(db, userId, deckId),
    nextDueAt,
    ahead: servingAhead,
  };
}

export interface AnswerResult {
  card: {
    id: string;
    state: Card["state"];
    dueAt: string;
    intervalDays: number;
    ease: number;
    lapses: number;
  };
  streak: number;
  dayCompleted: boolean;
  counts: DueCounts;
  becameLeech: boolean;
}

/**
 * Record an answer: advance the scheduler, append to the review log, and roll
 * up today's counters. All writes happen in one transaction so a failure
 * cannot leave the card rescheduled but unlogged.
 */
export async function answerCard(
  db: Db,
  args: {
  userId: string;
  cardId: string;
  rating: Rating;
  elapsedMs?: number;
  usedAiVariant?: boolean;
  },
): Promise<AnswerResult> {
  const { userId, cardId, rating } = args;
  const settings = await getSettings(db, userId);
  const tz = safeZone(settings.timezone);
  const now = new Date();
  const day = localDay(now, tz);

  const card = await db.query.cards.findFirst({
    where: and(eq(cards.id, cardId), eq(cards.userId, userId)),
  });
  if (!card) throw notFound("Card not found");
  if (card.suspended) throw new HttpError(409, "This card is suspended");

  const result = scheduleCard(toSchedulingState(card), rating, now, DEFAULT_SRS_CONFIG);
  const correct = rating > 1;
  const elapsedMs = Math.min(Math.max(args.elapsedMs ?? 0, 0), 3_600_000);

  await db.transaction(async (tx) => {
    await tx
      .update(cards)
      .set({
        state: result.state,
        learningStep: result.learningStep,
        intervalDays: result.intervalDays,
        ease: result.ease,
        reps: result.reps,
        lapses: result.lapses,
        dueAt: result.dueAt,
        lastReviewedAt: now,
        suspended: result.becameLeech ? true : card.suspended,
        totalReviews: card.totalReviews + 1,
        correctReviews: card.correctReviews + (correct ? 1 : 0),
        updatedAt: now,
      })
      .where(eq(cards.id, cardId));

    await tx.insert(reviews).values({
      cardId,
      deckId: card.deckId,
      userId,
      rating,
      correct,
      stateBefore: card.state,
      intervalBefore: card.intervalDays,
      intervalAfter: result.intervalDays,
      easeAfter: result.ease,
      elapsedMs,
      usedAiVariant: args.usedAiVariant ?? false,
      reviewedAt: now,
      localDay: day,
    });

    await tx
      .insert(dailyStats)
      .values({
        userId,
        day,
        reviewCount: 1,
        correctCount: correct ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: [dailyStats.userId, dailyStats.day],
        set: {
          reviewCount: sql`${dailyStats.reviewCount} + 1`,
          correctCount: sql`${dailyStats.correctCount} + ${correct ? 1 : 0}`,
          updatedAt: now,
        },
      });
  });

  // A day counts toward the streak once the whole queue — every deck — is clear.
  const accountCounts = await getDueCounts(db, userId, null);
  let dayCompleted = false;
  if (accountCounts.total === 0) {
    await db
      .update(dailyStats)
      .set({ completed: true, updatedAt: now })
      .where(and(eq(dailyStats.userId, userId), eq(dailyStats.day, day)));
    dayCompleted = true;
  }

  const { current } = await getStreak(db, userId);

  return {
    card: {
      id: cardId,
      state: result.state,
      dueAt: result.dueAt.toISOString(),
      intervalDays: result.intervalDays,
      ease: result.ease,
      lapses: result.lapses,
    },
    streak: current,
    dayCompleted,
    // The UI is studying one deck, so report that deck's remaining counts.
    counts: await getDueCounts(db, userId, card.deckId),
    becameLeech: result.becameLeech,
  };
}

export interface StreakInfo {
  current: number;
  longest: number;
  includesToday: boolean;
  today: string;
  completedDays: string[];
}

export async function getStreak(db: Db, userId: string): Promise<StreakInfo> {
  const settings = await getSettings(db, userId);
  const tz = safeZone(settings.timezone);
  const today = localDay(new Date(), tz);

  const rows = await db
    .select({ day: dailyStats.day })
    .from(dailyStats)
    .where(and(eq(dailyStats.userId, userId), eq(dailyStats.completed, true)));

  const completed = new Set(rows.map((r) => r.day));
  const { current, includesToday } = computeStreak(completed, today);

  return {
    current,
    longest: computeLongestStreak(completed),
    includesToday,
    today,
    completedDays: [...completed].sort(),
  };
}
