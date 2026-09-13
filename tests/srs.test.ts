import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_SRS_CONFIG,
  formatInterval,
  fuzzInterval,
  newCardState,
  previewIntervals,
  scheduleCard,
  type SchedulingState,
} from "../src/lib/srs.ts";

/** Fixed clock and rng so every assertion is deterministic. */
const NOW = new Date("2026-03-01T12:00:00.000Z");
const noFuzz = () => 0.5;

const minutesLater = (result: { dueAt: Date }) => (result.dueAt.getTime() - NOW.getTime()) / 60_000;
const daysLater = (result: { dueAt: Date }) => (result.dueAt.getTime() - NOW.getTime()) / 86_400_000;

const reviewCard = (overrides: Partial<SchedulingState> = {}): SchedulingState => ({
  state: "review",
  learningStep: 0,
  intervalDays: 10,
  ease: 2.5,
  reps: 5,
  lapses: 0,
  ...overrides,
});

describe("new and learning cards", () => {
  it("puts a new card on the first learning step when answered Again", () => {
    const r = scheduleCard(newCardState(), 1, NOW, DEFAULT_SRS_CONFIG, noFuzz);
    assert.equal(r.state, "learning");
    assert.equal(r.learningStep, 0);
    assert.equal(minutesLater(r), 1);
  });

  it("walks up the learning ladder on Good", () => {
    const first = scheduleCard(newCardState(), 3, NOW, DEFAULT_SRS_CONFIG, noFuzz);
    assert.equal(first.state, "learning");
    assert.equal(first.learningStep, 1);
    assert.equal(minutesLater(first), 10);

    // A second Good from the last step graduates the card.
    const second = scheduleCard(first, 3, NOW, DEFAULT_SRS_CONFIG, noFuzz);
    assert.equal(second.state, "review");
    assert.equal(second.learningStep, 0);
    assert.equal(daysLater(second), DEFAULT_SRS_CONFIG.graduatingIntervalDays);
  });

  it("graduates immediately on Easy", () => {
    const r = scheduleCard(newCardState(), 4, NOW, DEFAULT_SRS_CONFIG, noFuzz);
    assert.equal(r.state, "review");
    assert.equal(daysLater(r), DEFAULT_SRS_CONFIG.easyIntervalDays);
  });

  it("repeats the current step on Hard without advancing it", () => {
    const atStepOne: SchedulingState = { ...newCardState(), state: "learning", learningStep: 1 };
    const r = scheduleCard(atStepOne, 2, NOW, DEFAULT_SRS_CONFIG, noFuzz);
    assert.equal(r.state, "learning");
    assert.equal(r.learningStep, 1);
    assert.equal(minutesLater(r), 15); // 10 minute step * 1.5
  });

  it("counts every answer as a rep", () => {
    const r = scheduleCard(newCardState(), 1, NOW, DEFAULT_SRS_CONFIG, noFuzz);
    assert.equal(r.reps, 1);
  });
});

describe("review cards", () => {
  it("multiplies the interval by the ease factor on Good", () => {
    const r = scheduleCard(reviewCard(), 3, NOW, DEFAULT_SRS_CONFIG, noFuzz);
    assert.equal(r.state, "review");
    assert.equal(r.intervalDays, 25); // 10 * 2.5
    assert.equal(r.ease, 2.5, "Good leaves ease unchanged");
  });

  it("applies the hard multiplier and drops ease on Hard", () => {
    const r = scheduleCard(reviewCard(), 2, NOW, DEFAULT_SRS_CONFIG, noFuzz);
    assert.equal(Math.round(r.intervalDays), 12); // 10 * 1.2
    assert.ok(Math.abs(r.ease - 2.35) < 1e-6);
  });

  it("adds the easy bonus and raises ease on Easy", () => {
    const r = scheduleCard(reviewCard(), 4, NOW, DEFAULT_SRS_CONFIG, noFuzz);
    assert.ok(Math.abs(r.ease - 2.65) < 1e-6);
    // 10 * 2.65 * 1.3
    assert.ok(Math.abs(r.intervalDays - 34.45) < 0.01);
  });

  it("lapses into relearning on Again", () => {
    const r = scheduleCard(reviewCard(), 1, NOW, DEFAULT_SRS_CONFIG, noFuzz);
    assert.equal(r.state, "relearning");
    assert.equal(r.lapses, 1);
    assert.ok(Math.abs(r.ease - 2.3) < 1e-6);
    assert.equal(r.intervalDays, 1, "interval collapses to the one day floor");
    assert.equal(minutesLater(r), 10, "due on the first relearning step");
  });

  it("never lets ease fall below the configured floor", () => {
    let card = reviewCard({ ease: 1.35 });
    for (let i = 0; i < 5; i++) {
      const r = scheduleCard(card, 2, NOW, DEFAULT_SRS_CONFIG, noFuzz);
      card = { ...card, ease: r.ease };
    }
    assert.equal(card.ease, DEFAULT_SRS_CONFIG.minEase);
  });

  it("caps the interval at the configured maximum", () => {
    const r = scheduleCard(reviewCard({ intervalDays: 30_000, ease: 2.5 }), 4, NOW, DEFAULT_SRS_CONFIG, noFuzz);
    assert.ok(r.intervalDays <= DEFAULT_SRS_CONFIG.maximumIntervalDays);
  });
});

describe("relearning cards", () => {
  const relearning = (): SchedulingState => ({
    state: "relearning",
    learningStep: 0,
    intervalDays: 3,
    ease: 2.3,
    reps: 8,
    lapses: 1,
  });

  it("returns to review on Good once the ladder is finished", () => {
    const r = scheduleCard(relearning(), 3, NOW, DEFAULT_SRS_CONFIG, noFuzz);
    assert.equal(r.state, "review");
    assert.equal(daysLater(r), 3);
  });

  it("restarts the ladder on Again without adding another lapse", () => {
    const r = scheduleCard(relearning(), 1, NOW, DEFAULT_SRS_CONFIG, noFuzz);
    assert.equal(r.state, "relearning");
    assert.equal(r.learningStep, 0);
    assert.equal(r.lapses, 1, "a lapse is only counted when leaving the review state");
  });

  it("returns to review with a bonus day on Easy", () => {
    const r = scheduleCard(relearning(), 4, NOW, DEFAULT_SRS_CONFIG, noFuzz);
    assert.equal(r.state, "review");
    assert.equal(r.intervalDays, 4);
  });
});

describe("leeches", () => {
  it("flags a card once it passes the lapse threshold", () => {
    const nearLeech = reviewCard({ lapses: DEFAULT_SRS_CONFIG.leechThreshold - 1 });
    const r = scheduleCard(nearLeech, 1, NOW, DEFAULT_SRS_CONFIG, noFuzz);
    assert.equal(r.lapses, DEFAULT_SRS_CONFIG.leechThreshold);
    assert.equal(r.becameLeech, true);
  });

  it("does not re-flag on a successful answer", () => {
    const leech = reviewCard({ lapses: DEFAULT_SRS_CONFIG.leechThreshold + 2 });
    const r = scheduleCard(leech, 3, NOW, DEFAULT_SRS_CONFIG, noFuzz);
    assert.equal(r.becameLeech, false);
  });
});

describe("fuzz", () => {
  it("leaves short intervals untouched", () => {
    assert.equal(fuzzInterval(1, () => 0), 1);
    assert.equal(fuzzInterval(2, () => 1), 2);
  });

  it("stays within the expected band and never goes below a day", () => {
    for (const days of [5, 20, 100, 1000]) {
      for (const roll of [0, 0.25, 0.5, 0.75, 1]) {
        const out = fuzzInterval(days, () => roll);
        assert.ok(out >= 1, `${days}d fuzzed below one day`);
        assert.ok(out <= days * 1.3 + 1, `${days}d fuzzed too far up: ${out}`);
        assert.ok(out >= days * 0.7 - 1, `${days}d fuzzed too far down: ${out}`);
      }
    }
  });
});

describe("interval formatting and previews", () => {
  it("formats across each unit boundary", () => {
    assert.equal(formatInterval(30_000), "<1m");
    assert.equal(formatInterval(10 * 60_000), "10m");
    assert.equal(formatInterval(3 * 3_600_000), "3h");
    assert.equal(formatInterval(5 * 86_400_000), "5d");
    assert.equal(formatInterval(400 * 86_400_000), "1.1y");
  });

  it("previews all four buttons for a new card", () => {
    const preview = previewIntervals(newCardState(), NOW);
    assert.equal(preview[1], "1m");
    assert.equal(preview[3], "10m");
    assert.equal(preview[4], "4d");
  });

  it("previews without mutating the card it was given", () => {
    const card = newCardState();
    const snapshot = { ...card };
    previewIntervals(card, NOW);
    assert.deepEqual(card, snapshot);
  });
});
