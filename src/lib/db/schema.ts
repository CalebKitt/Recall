import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

/* ------------------------------------------------------------------ *
 * Auth.js core tables
 * ------------------------------------------------------------------ */

export const users = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { mode: "date", withTimezone: true }),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [primaryKey({ columns: [account.provider, account.providerAccountId] })],
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
  },
  (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })],
);

/* ------------------------------------------------------------------ *
 * Application tables
 * ------------------------------------------------------------------ */

/**
 * Per-user preferences. Created lazily on first read (see lib/settings.ts).
 * `geminiApiKey` is stored AES-256-GCM encrypted, never as plaintext.
 */
export const userSettings = pgTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Master switch for AI question rewording during study. */
  aiRewordEnabled: boolean("ai_reword_enabled").notNull().default(false),
  /** Encrypted personal Gemini key; falls back to the server key when null. */
  geminiApiKey: text("gemini_api_key"),
  /** IANA zone, e.g. "America/New_York". Drives day boundaries for streaks. */
  timezone: text("timezone").notNull().default("UTC"),
  /** Max brand-new cards introduced per deck per day. */
  newCardsPerDay: integer("new_cards_per_day").notNull().default(20),
  /** Max review (non-new) cards per deck per day. 0 = unlimited. */
  maxReviewsPerDay: integer("max_reviews_per_day").notNull().default(200),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const decks = pgTable(
  "deck",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Free-text hint that steers AI suggestions, e.g. "Characters in Dune". */
    topic: text("topic").notNull().default(""),
    color: text("color").notNull().default("indigo"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("deck_user_idx").on(t.userId)],
);

/** Card scheduling lifecycle, mirroring Anki's queue states. */
export const CARD_STATES = ["new", "learning", "review", "relearning"] as const;
export type CardState = (typeof CARD_STATES)[number];

export const cards = pgTable(
  "card",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deckId: uuid("deck_id")
      .notNull()
      .references(() => decks.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    front: text("front").notNull(),
    back: text("back").notNull(),
    /** Optional extra context shown after answering; also fed to the rewriter. */
    hint: text("hint").notNull().default(""),
    tags: text("tags").array().notNull().default([]),

    // --- SM-2 scheduling state ---
    state: text("state").$type<CardState>().notNull().default("new"),
    /** Index into the configured learning/relearning step ladder. */
    learningStep: integer("learning_step").notNull().default(0),
    /** Current inter-review interval in days (review/relearning cards). */
    intervalDays: real("interval_days").notNull().default(0),
    /** SM-2 ease factor; 2.5 is the standard starting value. */
    ease: real("ease").notNull().default(2.5),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull().defaultNow(),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    suspended: boolean("suspended").notNull().default(false),

    // --- Aggregate accuracy counters (denormalised for cheap stats) ---
    totalReviews: integer("total_reviews").notNull().default(0),
    correctReviews: integer("correct_reviews").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("card_deck_idx").on(t.deckId),
    // The study queue query filters by user + due date, so index the pair.
    index("card_due_idx").on(t.userId, t.dueAt),
  ],
);

/** Immutable log of every answer; the source of truth for all statistics. */
export const reviews = pgTable(
  "review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    deckId: uuid("deck_id")
      .notNull()
      .references(() => decks.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 1 = again, 2 = hard, 3 = good, 4 = easy. */
    rating: integer("rating").notNull(),
    /** rating > 1. Stored explicitly so accuracy queries stay trivial. */
    correct: boolean("correct").notNull(),
    stateBefore: text("state_before").$type<CardState>().notNull(),
    intervalBefore: real("interval_before").notNull(),
    intervalAfter: real("interval_after").notNull(),
    easeAfter: real("ease_after").notNull(),
    elapsedMs: integer("elapsed_ms").notNull().default(0),
    /** True when the prompt shown was an AI-reworded variant. */
    usedAiVariant: boolean("used_ai_variant").notNull().default(false),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Local calendar day (user's timezone) this review belongs to. */
    localDay: date("local_day").notNull(),
  },
  (t) => [
    index("review_user_day_idx").on(t.userId, t.localDay),
    index("review_card_idx").on(t.cardId),
    index("review_deck_idx").on(t.deckId),
  ],
);

/**
 * One row per user per local calendar day. `completed` marks a day where the
 * user emptied their entire due queue — that is what the streak counts.
 */
export const dailyStats = pgTable(
  "daily_stat",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    reviewCount: integer("review_count").notNull().default(0),
    correctCount: integer("correct_count").notNull().default(0),
    /** Set once the due queue across all decks hits zero on this day. */
    completed: boolean("completed").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

/**
 * Cached AI rewordings of a card's prompt. Generating on every single review
 * would be slow and burn quota, so variants are produced in batches and
 * rotated by least-recently-shown.
 */
export const cardVariants = pgTable(
  "card_variant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    /** Hash of front+back+hint; variants are invalidated when the card changes. */
    sourceHash: text("source_hash").notNull(),
    timesShown: integer("times_shown").notNull().default(0),
    lastShownAt: timestamp("last_shown_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("variant_card_idx").on(t.cardId, t.sourceHash)],
);

/**
 * AI-proposed cards awaiting the user's accept/reject decision. Rejections are
 * kept (status = "rejected") so the same idea is not suggested twice.
 */
export const cardSuggestions = pgTable(
  "card_suggestion",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deckId: uuid("deck_id")
      .notNull()
      .references(() => decks.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    front: text("front").notNull(),
    back: text("back").notNull(),
    /** Model's justification for why this fits the deck without overlapping. */
    rationale: text("rationale").notNull().default(""),
    status: text("status").$type<"pending" | "accepted" | "rejected">().notNull().default("pending"),
    /** Lowercased/normalised `back` used to dedupe against existing cards. */
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("suggestion_deck_idx").on(t.deckId, t.status),
    uniqueIndex("suggestion_dedupe_idx").on(t.deckId, t.dedupeKey),
  ],
);

/** Lightweight audit of AI calls, for debugging and quota visibility. */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"reword" | "suggest">().notNull(),
    model: text("model").notNull(),
    ok: boolean("ok").notNull(),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_usage_user_idx").on(t.userId, t.createdAt)],
);

export type Deck = typeof decks.$inferSelect;
export type Card = typeof cards.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type UserSettings = typeof userSettings.$inferSelect;
export type CardSuggestion = typeof cardSuggestions.$inferSelect;
