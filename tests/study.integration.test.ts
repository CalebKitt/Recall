import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { createTestDb, makeCards, makeDeck, makeUser, schema } from "./helpers/testDb.ts";
import { answerCard, buildQueue, getDueCounts, getStreak } from "../src/lib/study.ts";
import { getOverview, getDeckStats } from "../src/lib/stats.ts";
import { getSettings } from "../src/lib/settings.ts";
import type { Db } from "../src/lib/db/types.ts";
import { localDay } from "../src/lib/time.ts";

/**
 * End-to-end exercise of the service layer against a real Postgres.
 *
 * These cover the parts that unit tests cannot: the SQL itself, the transaction
 * in answerCard, the daily-stats upsert, cascading deletes, and the interaction
 * between daily caps and queue building.
 */

let db: Db;
let close: () => Promise<void>;

before(async () => {
  ({ db, close } = await createTestDb());
});

after(async () => {
  await close();
});

/** Wipe user-owned data between tests; cascades clear everything downstream. */
beforeEach(async () => {
  await db.delete(schema.users);
});

const today = () => localDay(new Date(), "UTC");

describe("schema and migrations", () => {
  it("creates every table the app uses", async () => {
    const result = (await db.execute(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    )) as unknown as { rows?: { table_name: string }[] } | { table_name: string }[];
    // Drivers differ: postgres-js returns an array, PGlite returns { rows }.
    const rows = Array.isArray(result) ? result : (result.rows ?? []);
    const names = rows.map((r) => r.table_name);
    for (const expected of [
      "account",
      "ai_usage",
      "card",
      "card_suggestion",
      "card_variant",
      "daily_stat",
      "deck",
      "review",
      "session",
      "user",
      "user_settings",
      "verificationToken",
    ]) {
      assert.ok(names.includes(expected), `missing table: ${expected}`);
    }
  });

  it("cascades a deck delete to its cards and reviews", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);
    const [cardId] = await makeCards(db, deckId, userId, [{ front: "q", back: "a" }]);
    await answerCard(db, { userId, cardId, rating: 3 });

    assert.equal((await db.select().from(schema.reviews)).length, 1);

    await db.delete(schema.decks).where(eq(schema.decks.id, deckId));

    assert.equal((await db.select().from(schema.cards)).length, 0);
    assert.equal((await db.select().from(schema.reviews)).length, 0);
  });

  it("cascades a user delete to everything they own", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);
    await makeCards(db, deckId, userId, [{ front: "q", back: "a" }]);

    await db.delete(schema.users).where(eq(schema.users.id, userId));

    assert.equal((await db.select().from(schema.decks)).length, 0);
    assert.equal((await db.select().from(schema.cards)).length, 0);
    assert.equal((await db.select().from(schema.userSettings)).length, 0);
  });
});

describe("settings", () => {
  it("creates a defaults row on first read", async () => {
    const [user] = await db
      .insert(schema.users)
      .values({ email: `lazy-${crypto.randomUUID()}@example.com` })
      .returning();

    const settings = await getSettings(db, user.id);
    assert.equal(settings.newCardsPerDay, 20);
    assert.equal(settings.aiRewordEnabled, false);
    assert.equal(settings.timezone, "UTC");

    // Second call must not throw on the unique primary key.
    const again = await getSettings(db, user.id);
    assert.equal(again.userId, settings.userId);
  });
});

describe("queue building", () => {
  it("serves new cards and reports their count", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);
    await makeCards(db, deckId, userId, [
      { front: "q1", back: "a1" },
      { front: "q2", back: "a2" },
      { front: "q3", back: "a3" },
    ]);

    const queue = await buildQueue(db, userId, deckId);
    assert.equal(queue.cards.length, 3);
    assert.equal(queue.counts.newCards, 3);
    assert.equal(queue.counts.total, 3);
    // Answer-button previews must come back populated.
    assert.equal(queue.cards[0].intervals[1], "1m");
  });

  it("respects the daily new-card limit", async () => {
    const userId = await makeUser(db, { newCardsPerDay: 2 });
    const deckId = await makeDeck(db, userId);
    await makeCards(
      db,
      deckId,
      userId,
      Array.from({ length: 6 }, (_, i) => ({ front: `q${i}`, back: `a${i}` })),
    );

    const queue = await buildQueue(db, userId, deckId);
    assert.equal(queue.cards.length, 2, "only two new cards may be introduced today");
    assert.equal(queue.counts.newCards, 2);
  });

  it("stops introducing new cards once the day's allowance is spent", async () => {
    const userId = await makeUser(db, { newCardsPerDay: 2 });
    const deckId = await makeDeck(db, userId);
    const ids = await makeCards(db, deckId, userId, [
      { front: "q1", back: "a1" },
      { front: "q2", back: "a2" },
      { front: "q3", back: "a3" },
    ]);

    // Graduate two cards so they leave the queue entirely.
    await answerCard(db, { userId, cardId: ids[0], rating: 4 });
    await answerCard(db, { userId, cardId: ids[1], rating: 4 });

    const counts = await getDueCounts(db, userId, deckId);
    assert.equal(counts.newCards, 0, "allowance is spent for today");
    assert.equal(counts.total, 0);
  });

  it("excludes suspended cards", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);
    const ids = await makeCards(db, deckId, userId, [
      { front: "q1", back: "a1" },
      { front: "q2", back: "a2" },
    ]);

    await db.update(schema.cards).set({ suspended: true }).where(eq(schema.cards.id, ids[0]));

    const queue = await buildQueue(db, userId, deckId);
    assert.equal(queue.cards.length, 1);
    assert.equal(queue.cards[0].id, ids[1]);
  });

  it("never leaks another user's cards", async () => {
    const alice = await makeUser(db);
    const bob = await makeUser(db);
    const aliceDeck = await makeDeck(db, alice, "Alice");
    const bobDeck = await makeDeck(db, bob, "Bob");
    await makeCards(db, aliceDeck, alice, [{ front: "alice-q", back: "a" }]);
    await makeCards(db, bobDeck, bob, [{ front: "bob-q", back: "b" }]);

    const queue = await buildQueue(db, alice, null);
    assert.equal(queue.cards.length, 1);
    assert.equal(queue.cards[0].front, "alice-q");
  });

  it("rejects a deck belonging to someone else", async () => {
    const alice = await makeUser(db);
    const bob = await makeUser(db);
    const bobDeck = await makeDeck(db, bob);

    await assert.rejects(() => buildQueue(db, alice, bobDeck), /Deck not found/);
  });

  it("serves nothing early unless asked", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);
    const [cardId] = await makeCards(db, deckId, userId, [{ front: "q", back: "a" }]);
    await answerCard(db, { userId, cardId, rating: 4 }); // Due in ~4 days.

    const normal = await buildQueue(db, userId, deckId);
    assert.equal(normal.cards.length, 0);
    assert.equal(normal.ahead, false);
  });

  it("pulls upcoming cards into a review-ahead session", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);
    const [cardId] = await makeCards(db, deckId, userId, [{ front: "q", back: "a" }]);

    // Studied yesterday, next due in four days.
    await db
      .update(schema.cards)
      .set({
        state: "review",
        intervalDays: 4,
        dueAt: new Date(Date.now() + 4 * 86_400_000),
        lastReviewedAt: new Date(Date.now() - 86_400_000),
      })
      .where(eq(schema.cards.id, cardId));

    const ahead = await buildQueue(db, userId, deckId, 60, { ahead: true });
    assert.equal(ahead.cards.length, 1);
    assert.equal(ahead.ahead, true);
    // The real due counts stay honest — nothing is actually due.
    assert.equal(ahead.counts.total, 0);
  });

  it("will not review ahead past the horizon", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);
    const [cardId] = await makeCards(db, deckId, userId, [{ front: "q", back: "a" }]);

    await db
      .update(schema.cards)
      .set({
        state: "review",
        intervalDays: 90,
        dueAt: new Date(Date.now() + 90 * 86_400_000),
        lastReviewedAt: new Date(Date.now() - 86_400_000),
      })
      .where(eq(schema.cards.id, cardId));

    const ahead = await buildQueue(db, userId, deckId, 60, { ahead: true });
    assert.equal(ahead.cards.length, 0, "a card 90 days out is not 'early', it is irrelevant");
    assert.equal(ahead.ahead, false);
  });

  it("does not re-serve a card already studied today", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);
    const [cardId] = await makeCards(db, deckId, userId, [{ front: "q", back: "a" }]);

    // Easy graduates it to roughly four days out — inside the ahead horizon —
    // but it was answered just now, so an early session must skip it.
    await answerCard(db, { userId, cardId, rating: 4 });

    const ahead = await buildQueue(db, userId, deckId, 60, { ahead: true });
    assert.equal(ahead.cards.length, 0);
  });

  it("ends a review-ahead session instead of looping forever", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);
    const [cardId] = await makeCards(db, deckId, userId, [{ front: "q", back: "a" }]);

    await db
      .update(schema.cards)
      .set({
        state: "review",
        intervalDays: 2,
        dueAt: new Date(Date.now() + 2 * 86_400_000),
        lastReviewedAt: new Date(Date.now() - 86_400_000),
      })
      .where(eq(schema.cards.id, cardId));

    const first = await buildQueue(db, userId, deckId, 60, { ahead: true });
    assert.equal(first.cards.length, 1);

    // "Hard" barely moves the interval, so termination cannot rely on the card
    // leaving the horizon — it relies on it having been studied today.
    await answerCard(db, { userId, cardId: first.cards[0].id, rating: 2 });

    const second = await buildQueue(db, userId, deckId, 60, { ahead: true });
    assert.equal(second.cards.length, 0, "the session must terminate");
  });

  it("never serves new cards early beyond the daily cap", async () => {
    const userId = await makeUser(db, { newCardsPerDay: 1 });
    const deckId = await makeDeck(db, userId);
    const ids = await makeCards(db, deckId, userId, [
      { front: "q1", back: "a1" },
      { front: "q2", back: "a2" },
    ]);
    await answerCard(db, { userId, cardId: ids[0], rating: 4 });

    const ahead = await buildQueue(db, userId, deckId, 60, { ahead: true });
    // The remaining new card is still capped; only the graduated one is early.
    assert.ok(!ahead.cards.some((c) => c.id === ids[1]), "cap must still hold");
  });

  it("reports when the next card is due on an empty queue", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);
    const [cardId] = await makeCards(db, deckId, userId, [{ front: "q", back: "a" }]);

    await answerCard(db, { userId, cardId, rating: 4 }); // Due in ~4 days.

    const queue = await buildQueue(db, userId, deckId);
    assert.equal(queue.cards.length, 0);
    assert.ok(queue.nextDueAt, "should say when to come back");
    assert.ok(new Date(queue.nextDueAt).getTime() > Date.now());
  });
});

describe("answering", () => {
  it("persists scheduling, the review log and the daily rollup together", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);
    const [cardId] = await makeCards(db, deckId, userId, [{ front: "q", back: "a" }]);

    const res = await answerCard(db, { userId, cardId, rating: 3, elapsedMs: 4200 });
    assert.equal(res.card.state, "learning");

    const card = await db.query.cards.findFirst({ where: eq(schema.cards.id, cardId) });
    assert.ok(card);
    assert.equal(card.state, "learning");
    assert.equal(card.reps, 1);
    assert.equal(card.totalReviews, 1);
    assert.equal(card.correctReviews, 1);
    assert.ok(card.lastReviewedAt);

    const [review] = await db.select().from(schema.reviews);
    assert.equal(review.rating, 3);
    assert.equal(review.correct, true);
    assert.equal(review.stateBefore, "new");
    assert.equal(review.elapsedMs, 4200);
    assert.equal(review.localDay, today());

    const [daily] = await db.select().from(schema.dailyStats);
    assert.equal(daily.reviewCount, 1);
    assert.equal(daily.correctCount, 1);
  });

  it("accumulates the daily rollup across answers", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);
    const ids = await makeCards(db, deckId, userId, [
      { front: "q1", back: "a1" },
      { front: "q2", back: "a2" },
      { front: "q3", back: "a3" },
    ]);

    await answerCard(db, { userId, cardId: ids[0], rating: 3 });
    await answerCard(db, { userId, cardId: ids[1], rating: 1 });
    await answerCard(db, { userId, cardId: ids[2], rating: 4 });

    const [daily] = await db.select().from(schema.dailyStats);
    assert.equal(daily.reviewCount, 3);
    assert.equal(daily.correctCount, 2, "Again does not count as correct");
  });

  it("records a lapse and drops ease when a review card fails", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);
    const [cardId] = await makeCards(db, deckId, userId, [{ front: "q", back: "a" }]);

    await db
      .update(schema.cards)
      .set({ state: "review", intervalDays: 10, ease: 2.5, reps: 5 })
      .where(eq(schema.cards.id, cardId));

    await answerCard(db, { userId, cardId, rating: 1 });

    const card = await db.query.cards.findFirst({ where: eq(schema.cards.id, cardId) });
    assert.equal(card?.state, "relearning");
    assert.equal(card?.lapses, 1);
    assert.ok(Math.abs((card?.ease ?? 0) - 2.3) < 1e-5);
    assert.equal(card?.correctReviews, 0);
  });

  it("suspends a card that becomes a leech", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);
    const [cardId] = await makeCards(db, deckId, userId, [{ front: "q", back: "a" }]);

    await db
      .update(schema.cards)
      .set({ state: "review", intervalDays: 5, ease: 1.3, lapses: 7 })
      .where(eq(schema.cards.id, cardId));

    const res = await answerCard(db, { userId, cardId, rating: 1 });
    assert.equal(res.becameLeech, true);

    const card = await db.query.cards.findFirst({ where: eq(schema.cards.id, cardId) });
    assert.equal(card?.suspended, true);
  });

  it("refuses to answer a card owned by someone else", async () => {
    const alice = await makeUser(db);
    const bob = await makeUser(db);
    const bobDeck = await makeDeck(db, bob);
    const [bobCard] = await makeCards(db, bobDeck, bob, [{ front: "q", back: "a" }]);

    await assert.rejects(
      () => answerCard(db, { userId: alice, cardId: bobCard, rating: 3 }),
      /Card not found/,
    );
  });

  it("refuses to answer a suspended card", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);
    const [cardId] = await makeCards(db, deckId, userId, [{ front: "q", back: "a" }]);
    await db.update(schema.cards).set({ suspended: true }).where(eq(schema.cards.id, cardId));

    await assert.rejects(() => answerCard(db, { userId, cardId, rating: 3 }), /suspended/);
  });
});

describe("streaks", () => {
  it("marks the day complete only once the whole queue is cleared", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);
    const ids = await makeCards(db, deckId, userId, [
      { front: "q1", back: "a1" },
      { front: "q2", back: "a2" },
    ]);

    // Easy graduates a card straight out of the queue.
    const first = await answerCard(db, { userId, cardId: ids[0], rating: 4 });
    assert.equal(first.dayCompleted, false, "one card is still outstanding");
    assert.equal(first.streak, 0);

    const second = await answerCard(db, { userId, cardId: ids[1], rating: 4 });
    assert.equal(second.dayCompleted, true);
    assert.equal(second.streak, 1);
  });

  it("does not count a day where cards remain in learning", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);
    const [cardId] = await makeCards(db, deckId, userId, [{ front: "q", back: "a" }]);

    // "Good" leaves the card in a learning step, due again in ten minutes.
    const res = await answerCard(db, { userId, cardId, rating: 3 });
    assert.equal(res.dayCompleted, false);
  });

  it("counts consecutive completed days and finds the longest run", async () => {
    const userId = await makeUser(db);
    const t = today();
    const shift = (days: number) =>
      new Date(Date.parse(`${t}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

    await db.insert(schema.dailyStats).values([
      { userId, day: shift(-4), reviewCount: 5, completed: true },
      { userId, day: shift(-3), reviewCount: 5, completed: true },
      // Gap on -2.
      { userId, day: shift(-1), reviewCount: 5, completed: true },
      { userId, day: t, reviewCount: 5, completed: true },
    ]);

    const streak = await getStreak(db, userId);
    assert.equal(streak.current, 2);
    assert.equal(streak.longest, 2);
    assert.equal(streak.includesToday, true);
  });

  it("keeps yesterday's streak alive before today is studied", async () => {
    const userId = await makeUser(db);
    const t = today();
    const yesterday = new Date(Date.parse(`${t}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

    await db
      .insert(schema.dailyStats)
      .values([{ userId, day: yesterday, reviewCount: 3, completed: true }]);

    const streak = await getStreak(db, userId);
    assert.equal(streak.current, 1);
    assert.equal(streak.includesToday, false);
  });
});

describe("statistics", () => {
  it("aggregates totals, per-deck buckets and the rating spread", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId, "Dune");
    const ids = await makeCards(db, deckId, userId, [
      { front: "q1", back: "a1" },
      { front: "q2", back: "a2" },
      { front: "q3", back: "a3" },
    ]);

    await answerCard(db, { userId, cardId: ids[0], rating: 3, elapsedMs: 2000 });
    await answerCard(db, { userId, cardId: ids[1], rating: 1, elapsedMs: 4000 });
    await answerCard(db, { userId, cardId: ids[2], rating: 4, elapsedMs: 3000 });

    const stats = await getOverview(db, userId, 30);

    assert.equal(stats.totals.cards, 3);
    assert.equal(stats.totals.reviews, 3);
    assert.equal(stats.totals.reviewsToday, 3);
    assert.ok(Math.abs((stats.totals.accuracy ?? 0) - 2 / 3) < 1e-6);
    assert.ok(Math.abs((stats.totals.avgSecondsPerCard ?? 0) - 3) < 1e-6);

    assert.equal(stats.decks.length, 1);
    assert.equal(stats.decks[0].name, "Dune");
    assert.equal(stats.decks[0].totalCards, 3);

    const spread = Object.fromEntries(stats.ratingSpread.map((r) => [r.rating, r.n]));
    assert.equal(spread[1], 1);
    assert.equal(spread[3], 1);
    assert.equal(spread[4], 1);

    // History is gap-filled through to today.
    assert.equal(stats.history.length, 30);
    assert.equal(stats.history[stats.history.length - 1].day, today());
    assert.equal(stats.history[stats.history.length - 1].reviews, 3);
  });

  it("reports an empty deck as zero rather than null", async () => {
    const userId = await makeUser(db);
    await makeDeck(db, userId, "Empty");

    const stats = await getOverview(db, userId, 7);
    assert.equal(stats.decks.length, 1);
    assert.equal(stats.decks[0].totalCards, 0);
    assert.equal(stats.decks[0].accuracy, null);
  });

  it("buckets cards into new, learning, young and mature", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);
    const ids = await makeCards(db, deckId, userId, [
      { front: "new", back: "a" },
      { front: "learning", back: "a" },
      { front: "young", back: "a" },
      { front: "mature", back: "a" },
    ]);

    await db.update(schema.cards).set({ state: "learning" }).where(eq(schema.cards.id, ids[1]));
    await db
      .update(schema.cards)
      .set({ state: "review", intervalDays: 5 })
      .where(eq(schema.cards.id, ids[2]));
    await db
      .update(schema.cards)
      .set({ state: "review", intervalDays: 45 })
      .where(eq(schema.cards.id, ids[3]));

    const stats = await getOverview(db, userId, 7);
    const deck = stats.decks[0];
    assert.equal(deck.newCards, 1);
    assert.equal(deck.learning, 1);
    assert.equal(deck.young, 1);
    assert.equal(deck.mature, 1);
  });

  it("surfaces trouble cards in the per-deck view", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);
    const [goodCard, badCard] = await makeCards(db, deckId, userId, [
      { front: "easy one", back: "a" },
      { front: "hard one", back: "b" },
    ]);

    await db
      .update(schema.cards)
      .set({ totalReviews: 10, correctReviews: 9 })
      .where(eq(schema.cards.id, goodCard));
    await db
      .update(schema.cards)
      .set({ totalReviews: 10, correctReviews: 3, lapses: 4 })
      .where(eq(schema.cards.id, badCard));

    const stats = await getDeckStats(db, userId, deckId);
    assert.ok(stats);
    assert.equal(stats.troubleCards.length, 1);
    assert.equal(stats.troubleCards[0].front, "hard one");
    assert.ok(Math.abs((stats.troubleCards[0].accuracy ?? 0) - 0.3) < 1e-6);
  });

  it("returns null for a deck the user does not own", async () => {
    const alice = await makeUser(db);
    const bob = await makeUser(db);
    const bobDeck = await makeDeck(db, bob);

    assert.equal(await getDeckStats(db, alice, bobDeck), null);
  });
});

describe("AI suggestion storage", () => {
  it("rejects a duplicate suggestion for the same deck", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);

    const row = {
      deckId,
      userId,
      front: "Who is Chani?",
      back: "A Fremen woman",
      dedupeKey: "who is chani?|a fremen woman",
    };

    await db.insert(schema.cardSuggestions).values(row);
    const second = await db
      .insert(schema.cardSuggestions)
      .values(row)
      .onConflictDoNothing()
      .returning();

    assert.equal(second.length, 0, "the unique index should swallow the repeat");
    assert.equal((await db.select().from(schema.cardSuggestions)).length, 1);
  });

  it("allows the same suggestion in a different deck", async () => {
    const userId = await makeUser(db);
    const deckA = await makeDeck(db, userId, "A");
    const deckB = await makeDeck(db, userId, "B");

    const base = { userId, front: "q", back: "a", dedupeKey: "q|a" };
    await db.insert(schema.cardSuggestions).values({ ...base, deckId: deckA });
    await db.insert(schema.cardSuggestions).values({ ...base, deckId: deckB });

    assert.equal((await db.select().from(schema.cardSuggestions)).length, 2);
  });
});

describe("card variants", () => {
  it("stores variants against a content hash and clears them with the card", async () => {
    const userId = await makeUser(db);
    const deckId = await makeDeck(db, userId);
    const [cardId] = await makeCards(db, deckId, userId, [{ front: "q", back: "a" }]);

    await db.insert(schema.cardVariants).values([
      { cardId, text: "variant one", sourceHash: "hash1" },
      { cardId, text: "variant two", sourceHash: "hash1" },
    ]);

    const pool = await db
      .select()
      .from(schema.cardVariants)
      .where(
        and(eq(schema.cardVariants.cardId, cardId), eq(schema.cardVariants.sourceHash, "hash1")),
      );
    assert.equal(pool.length, 2);
    assert.equal(pool[0].timesShown, 0);

    await db.delete(schema.cards).where(eq(schema.cards.id, cardId));
    assert.equal((await db.select().from(schema.cardVariants)).length, 0);
  });
});
