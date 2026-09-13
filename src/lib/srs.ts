/**
 * Anki-flavoured SM-2 scheduler.
 *
 * Everything here is a pure function of (card state, rating, now) so the
 * behaviour can be unit-tested without a database. `scheduleCard` returns the
 * fields to persist; `previewIntervals` produces the "1m / 10m / 1d / 4d"
 * labels shown on the answer buttons before the user commits.
 */

export type CardState = "new" | "learning" | "review" | "relearning";

/** 1 = Again, 2 = Hard, 3 = Good, 4 = Easy. */
export type Rating = 1 | 2 | 3 | 4;

export const RATINGS: Rating[] = [1, 2, 3, 4];
export const RATING_LABELS: Record<Rating, string> = {
  1: "Again",
  2: "Hard",
  3: "Good",
  4: "Easy",
};

export interface SchedulingState {
  state: CardState;
  learningStep: number;
  /** Days. Only meaningful for review/relearning cards. */
  intervalDays: number;
  ease: number;
  reps: number;
  lapses: number;
}

export interface SrsConfig {
  /** Learning ladder in minutes, walked by consecutive "Good" answers. */
  learningStepsMinutes: number[];
  /** Ladder used after a lapse. */
  relearningStepsMinutes: number[];
  /** Interval (days) given when a card graduates with "Good". */
  graduatingIntervalDays: number;
  /** Interval (days) given when a learning card is answered "Easy". */
  easyIntervalDays: number;
  /** Multiplier applied on "Hard" for review cards. */
  hardMultiplier: number;
  /** Extra multiplier applied on "Easy" for review cards. */
  easyBonus: number;
  /** Fraction of the old interval kept after a lapse (Anki's "new interval"). */
  lapseIntervalMultiplier: number;
  /** Floor for the ease factor. */
  minEase: number;
  /** Ceiling for any interval, in days. */
  maximumIntervalDays: number;
  /** Lapse count at which a card is auto-suspended as a "leech". */
  leechThreshold: number;
}

export const DEFAULT_SRS_CONFIG: SrsConfig = {
  learningStepsMinutes: [1, 10],
  relearningStepsMinutes: [10],
  graduatingIntervalDays: 1,
  easyIntervalDays: 4,
  hardMultiplier: 1.2,
  easyBonus: 1.3,
  lapseIntervalMultiplier: 0,
  minEase: 1.3,
  maximumIntervalDays: 36500,
  leechThreshold: 8,
};

export interface ScheduleResult extends SchedulingState {
  dueAt: Date;
  /** True when this answer pushed the card past the leech threshold. */
  becameLeech: boolean;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Anki spreads due dates slightly so that cards learned together do not clump
 * forever. Fuzz only applies to intervals of 2+ days.
 */
export function fuzzInterval(days: number, rng: () => number = Math.random): number {
  if (days < 2.5) return days;
  let pct: number;
  if (days < 7) pct = 0.25;
  else if (days < 30) pct = 0.15;
  else pct = 0.05;
  const spread = days * pct;
  // Keep at least a full day of jitter range on longer intervals.
  const delta = (rng() * 2 - 1) * Math.max(spread, 1);
  return Math.max(1, days + delta);
}

function minutesFromNow(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * MINUTE_MS);
}

function daysFromNow(now: Date, days: number): Date {
  return new Date(now.getTime() + days * DAY_MS);
}

/**
 * Advance a card's scheduling state by one answer.
 *
 * @param card  Current scheduling state.
 * @param rating User's self-assessment, 1-4.
 * @param now   Review timestamp (injected so tests are deterministic).
 * @param rng   Source of fuzz randomness (injected for the same reason).
 */
export function scheduleCard(
  card: SchedulingState,
  rating: Rating,
  now: Date = new Date(),
  config: SrsConfig = DEFAULT_SRS_CONFIG,
  rng: () => number = Math.random,
): ScheduleResult {
  const reps = card.reps + 1;
  let { state, learningStep, intervalDays, ease, lapses } = card;

  const learningSteps = config.learningStepsMinutes.length
    ? config.learningStepsMinutes
    : [10];
  const relearningSteps = config.relearningStepsMinutes.length
    ? config.relearningStepsMinutes
    : [10];

  let dueAt: Date;

  if (state === "new" || state === "learning") {
    const steps = learningSteps;
    switch (rating) {
      case 1:
        state = "learning";
        learningStep = 0;
        intervalDays = 0;
        dueAt = minutesFromNow(now, steps[0]);
        break;
      case 2: {
        state = "learning";
        // Hard repeats the current step, slightly stretched.
        const stepIdx = clamp(learningStep, 0, steps.length - 1);
        intervalDays = 0;
        dueAt = minutesFromNow(now, steps[stepIdx] * 1.5);
        break;
      }
      case 3: {
        const next = learningStep + 1;
        if (next >= steps.length) {
          // Graduated.
          state = "review";
          learningStep = 0;
          intervalDays = fuzzInterval(config.graduatingIntervalDays, rng);
          dueAt = daysFromNow(now, intervalDays);
        } else {
          state = "learning";
          learningStep = next;
          intervalDays = 0;
          dueAt = minutesFromNow(now, steps[next]);
        }
        break;
      }
      case 4:
        state = "review";
        learningStep = 0;
        intervalDays = fuzzInterval(config.easyIntervalDays, rng);
        dueAt = daysFromNow(now, intervalDays);
        break;
    }
  } else if (state === "review") {
    switch (rating) {
      case 1: {
        // Lapse: drop into relearning and shrink the interval.
        lapses += 1;
        ease = clamp(ease - 0.2, config.minEase, 5);
        intervalDays = Math.max(1, intervalDays * config.lapseIntervalMultiplier);
        state = "relearning";
        learningStep = 0;
        dueAt = minutesFromNow(now, relearningSteps[0]);
        break;
      }
      case 2:
        ease = clamp(ease - 0.15, config.minEase, 5);
        intervalDays = fuzzInterval(
          Math.min(intervalDays * config.hardMultiplier, config.maximumIntervalDays),
          rng,
        );
        dueAt = daysFromNow(now, intervalDays);
        break;
      case 3:
        intervalDays = fuzzInterval(
          Math.min(intervalDays * ease, config.maximumIntervalDays),
          rng,
        );
        dueAt = daysFromNow(now, intervalDays);
        break;
      case 4:
        ease = clamp(ease + 0.15, config.minEase, 5);
        intervalDays = fuzzInterval(
          Math.min(intervalDays * ease * config.easyBonus, config.maximumIntervalDays),
          rng,
        );
        dueAt = daysFromNow(now, intervalDays);
        break;
    }
  } else {
    // relearning
    const steps = relearningSteps;
    switch (rating) {
      case 1:
        learningStep = 0;
        dueAt = minutesFromNow(now, steps[0]);
        break;
      case 2: {
        const stepIdx = clamp(learningStep, 0, steps.length - 1);
        dueAt = minutesFromNow(now, steps[stepIdx] * 1.5);
        break;
      }
      case 3: {
        const next = learningStep + 1;
        if (next >= steps.length) {
          state = "review";
          learningStep = 0;
          intervalDays = Math.max(1, intervalDays);
          dueAt = daysFromNow(now, intervalDays);
        } else {
          learningStep = next;
          dueAt = minutesFromNow(now, steps[next]);
        }
        break;
      }
      case 4:
        state = "review";
        learningStep = 0;
        intervalDays = Math.max(1, intervalDays) + 1;
        dueAt = daysFromNow(now, intervalDays);
        break;
    }
  }

  intervalDays = Math.min(intervalDays, config.maximumIntervalDays);

  return {
    state,
    learningStep,
    intervalDays,
    ease,
    reps,
    lapses,
    dueAt,
    becameLeech: lapses >= config.leechThreshold && lapses > card.lapses,
  };
}

/** Human-readable delay, matching Anki's compact style. */
export function formatInterval(msFromNow: number): string {
  const mins = msFromNow / MINUTE_MS;
  if (mins < 1) return "<1m";
  if (mins < 60) return `${Math.round(mins)}m`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  const months = days / 30.44;
  if (months < 12) return `${months.toFixed(months < 10 ? 1 : 0)}mo`;
  return `${(days / 365.25).toFixed(1)}y`;
}

/**
 * Labels for the four answer buttons. Computed with a fixed rng so the preview
 * matches the eventual scheduling closely (fuzz aside) and never flickers.
 */
export function previewIntervals(
  card: SchedulingState,
  now: Date = new Date(),
  config: SrsConfig = DEFAULT_SRS_CONFIG,
): Record<Rating, string> {
  const noFuzz = () => 0.5;
  const out = {} as Record<Rating, string>;
  for (const r of RATINGS) {
    const res = scheduleCard(card, r, now, config, noFuzz);
    out[r] = formatInterval(res.dueAt.getTime() - now.getTime());
  }
  return out;
}

/** A brand-new card's starting scheduling state. */
export function newCardState(ease = 2.5): SchedulingState {
  return {
    state: "new",
    learningStep: 0,
    intervalDays: 0,
    ease,
    reps: 0,
    lapses: 0,
  };
}
