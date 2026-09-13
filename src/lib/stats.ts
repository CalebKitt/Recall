import { and, avg, count, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "./db/types";
import { cards, dailyStats, decks, reviews } from "./db/schema";
import { getSettings } from "./settings";
import { addDays, localDay, safeZone } from "./time";
import { getStreak } from "./study";

export interface DayPoint {
  day: string;
  reviews: number;
  correct: number;
  accuracy: number | null;
  completed: boolean;
}

export interface DeckStat {
  deckId: string;
  name: string;
  color: string;
  totalCards: number;
  newCards: number;
  learning: number;
  young: number;
  mature: number;
  suspended: number;
  totalReviews: number;
  correctReviews: number;
  accuracy: number | null;
  dueNow: number;
}

export interface OverviewStats {
  streak: { current: number; longest: number; includesToday: boolean };
  totals: {
    decks: number;
    cards: number;
    reviews: number;
    accuracy: number | null;
    reviewsToday: number;
    accuracyToday: number | null;
    studyDays: number;
    avgSecondsPerCard: number | null;
  };
  history: DayPoint[];
  ratingSpread: { rating: number; n: number }[];
  decks: DeckStat[];
}

const pct = (correct: number, total: number): number | null =>
  total > 0 ? correct / total : null;

/** A card is "mature" once its interval reaches 21 days — Anki's convention. */
const MATURE_DAYS = 21;

export async function getOverview(db: Db, userId: string, historyDays = 60): Promise<OverviewStats> {
  const settings = await getSettings(db, userId);
  const tz = safeZone(settings.timezone);
  const today = localDay(new Date(), tz);
  const since = addDays(today, -(historyDays - 1));

  const [streak, deckStats, cardTotals, reviewTotals, todayRow, dayRows, ratingRows, timing] =
    await Promise.all([
      getStreak(db, userId),

      // Per-deck card composition, bucketed by scheduling maturity.
      db
        .select({
          deckId: decks.id,
          name: decks.name,
          color: decks.color,
          totalCards: count(cards.id),
          newCards: sql<number>`count(*) filter (where ${cards.state} = 'new')::int`,
          learning: sql<number>`count(*) filter (where ${cards.state} in ('learning','relearning'))::int`,
          young: sql<number>`count(*) filter (where ${cards.state} = 'review' and ${cards.intervalDays} < ${MATURE_DAYS})::int`,
          mature: sql<number>`count(*) filter (where ${cards.state} = 'review' and ${cards.intervalDays} >= ${MATURE_DAYS})::int`,
          suspended: sql<number>`count(*) filter (where ${cards.suspended})::int`,
          dueNow: sql<number>`count(*) filter (where ${cards.dueAt} <= now() and not ${cards.suspended})::int`,
          totalReviews: sql<number>`coalesce(sum(${cards.totalReviews}), 0)::int`,
          correctReviews: sql<number>`coalesce(sum(${cards.correctReviews}), 0)::int`,
        })
        .from(decks)
        .leftJoin(cards, eq(cards.deckId, decks.id))
        .where(eq(decks.userId, userId))
        .groupBy(decks.id, decks.name, decks.color)
        .orderBy(decks.name),

      db.select({ n: count() }).from(cards).where(eq(cards.userId, userId)),

      db
        .select({
          n: count(),
          correct: sql<number>`count(*) filter (where ${reviews.correct})::int`,
        })
        .from(reviews)
        .where(eq(reviews.userId, userId)),

      db
        .select({
          n: count(),
          correct: sql<number>`count(*) filter (where ${reviews.correct})::int`,
        })
        .from(reviews)
        .where(and(eq(reviews.userId, userId), eq(reviews.localDay, today))),

      db
        .select({
          day: dailyStats.day,
          reviews: dailyStats.reviewCount,
          correct: dailyStats.correctCount,
          completed: dailyStats.completed,
        })
        .from(dailyStats)
        .where(and(eq(dailyStats.userId, userId), gte(dailyStats.day, since)))
        .orderBy(dailyStats.day),

      db
        .select({ rating: reviews.rating, n: count() })
        .from(reviews)
        .where(eq(reviews.userId, userId))
        .groupBy(reviews.rating)
        .orderBy(reviews.rating),

      db
        .select({ avgMs: avg(reviews.elapsedMs) })
        .from(reviews)
        .where(and(eq(reviews.userId, userId), sql`${reviews.elapsedMs} > 0`)),
    ]);

  // Fill gaps so the chart shows unstudied days as zero rather than skipping them.
  const byDay = new Map(dayRows.map((r) => [r.day, r]));
  const history: DayPoint[] = [];
  for (let d = since; d <= today; d = addDays(d, 1)) {
    const row = byDay.get(d);
    const n = row?.reviews ?? 0;
    const c = row?.correct ?? 0;
    history.push({ day: d, reviews: n, correct: c, accuracy: pct(c, n), completed: row?.completed ?? false });
  }

  const totalReviews = reviewTotals[0]?.n ?? 0;
  const totalCorrect = reviewTotals[0]?.correct ?? 0;
  const avgMs = Number(timing[0]?.avgMs ?? 0);

  return {
    streak: {
      current: streak.current,
      longest: streak.longest,
      includesToday: streak.includesToday,
    },
    totals: {
      decks: deckStats.length,
      cards: cardTotals[0]?.n ?? 0,
      reviews: totalReviews,
      accuracy: pct(totalCorrect, totalReviews),
      reviewsToday: todayRow[0]?.n ?? 0,
      accuracyToday: pct(todayRow[0]?.correct ?? 0, todayRow[0]?.n ?? 0),
      studyDays: dayRows.filter((r) => r.reviews > 0).length,
      avgSecondsPerCard: avgMs > 0 ? avgMs / 1000 : null,
    },
    history,
    ratingSpread: ratingRows.map((r) => ({ rating: r.rating, n: r.n })),
    decks: deckStats.map((d) => ({
      ...d,
      // The left join yields one all-null row for an empty deck; report zero.
      totalCards: d.totalCards ?? 0,
      accuracy: pct(d.correctReviews, d.totalReviews),
    })),
  };
}

export interface CardStat {
  cardId: string;
  front: string;
  back: string;
  totalReviews: number;
  correctReviews: number;
  accuracy: number | null;
  lapses: number;
  intervalDays: number;
  ease: number;
  state: string;
  dueAt: string;
  suspended: boolean;
}

/** Per-deck detail: every card with its accuracy, worst performers first. */
export async function getDeckStats(db: Db, userId: string, deckId: string) {
  const deck = await db.query.decks.findFirst({
    where: and(eq(decks.id, deckId), eq(decks.userId, userId)),
  });
  if (!deck) return null;

  const rows = await db
    .select()
    .from(cards)
    .where(and(eq(cards.deckId, deckId), eq(cards.userId, userId)))
    .orderBy(desc(cards.lapses), cards.createdAt);

  const [totals] = await db
    .select({
      n: count(),
      correct: sql<number>`count(*) filter (where ${reviews.correct})::int`,
      avgMs: avg(reviews.elapsedMs),
    })
    .from(reviews)
    .where(and(eq(reviews.userId, userId), eq(reviews.deckId, deckId)));

  const cardStats: CardStat[] = rows.map((c) => ({
    cardId: c.id,
    front: c.front,
    back: c.back,
    totalReviews: c.totalReviews,
    correctReviews: c.correctReviews,
    accuracy: pct(c.correctReviews, c.totalReviews),
    lapses: c.lapses,
    intervalDays: c.intervalDays,
    ease: c.ease,
    state: c.state,
    dueAt: c.dueAt.toISOString(),
    suspended: c.suspended,
  }));

  return {
    deck: { id: deck.id, name: deck.name, color: deck.color },
    totals: {
      reviews: totals?.n ?? 0,
      accuracy: pct(totals?.correct ?? 0, totals?.n ?? 0),
      avgSeconds: Number(totals?.avgMs ?? 0) / 1000 || null,
    },
    cards: cardStats,
    /** Cards with a real track record and sub-70% accuracy. */
    troubleCards: cardStats
      .filter((c) => c.totalReviews >= 3 && (c.accuracy ?? 1) < 0.7)
      .sort((a, b) => (a.accuracy ?? 1) - (b.accuracy ?? 1))
      .slice(0, 10),
  };
}
