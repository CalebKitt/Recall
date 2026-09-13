import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addDays,
  computeLongestStreak,
  computeStreak,
  dayStartUtc,
  daysBetween,
  isValidTimeZone,
  localDay,
  safeZone,
} from "../src/lib/time.ts";

describe("timezone handling", () => {
  it("recognises real zones and rejects junk", () => {
    assert.equal(isValidTimeZone("America/New_York"), true);
    assert.equal(isValidTimeZone("Pacific/Auckland"), true);
    assert.equal(isValidTimeZone("Not/AZone"), false);
    assert.equal(isValidTimeZone(""), false);
  });

  it("falls back to UTC for unusable values", () => {
    assert.equal(safeZone(null), "UTC");
    assert.equal(safeZone("Not/AZone"), "UTC");
    assert.equal(safeZone("Europe/Berlin"), "Europe/Berlin");
  });

  it("resolves the local day across the date line", () => {
    // 23:30 UTC on the 1st is already the 2nd in Auckland, still the 1st in NY.
    const instant = new Date("2026-03-01T23:30:00.000Z");
    assert.equal(localDay(instant, "UTC"), "2026-03-01");
    assert.equal(localDay(instant, "Pacific/Auckland"), "2026-03-02");
    assert.equal(localDay(instant, "America/New_York"), "2026-03-01");
  });

  it("resolves the local day just after midnight UTC", () => {
    const instant = new Date("2026-03-02T00:30:00.000Z");
    assert.equal(localDay(instant, "UTC"), "2026-03-02");
    // Still the previous evening in New York.
    assert.equal(localDay(instant, "America/New_York"), "2026-03-01");
  });
});

describe("dayStartUtc", () => {
  it("returns midnight UTC for UTC", () => {
    assert.equal(dayStartUtc("2026-03-01", "UTC").toISOString(), "2026-03-01T00:00:00.000Z");
  });

  it("accounts for a fixed offset", () => {
    // Auckland is UTC+13 on 1 March (daylight saving).
    assert.equal(
      dayStartUtc("2026-03-01", "Pacific/Auckland").toISOString(),
      "2026-02-28T11:00:00.000Z",
    );
  });

  it("round-trips: the start of a day is inside that day", () => {
    for (const tz of ["UTC", "America/New_York", "Pacific/Auckland", "Asia/Kolkata"]) {
      for (const day of ["2026-01-15", "2026-03-08", "2026-07-04", "2026-11-01"]) {
        assert.equal(localDay(dayStartUtc(day, tz), tz), day, `${day} in ${tz}`);
      }
    }
  });

  it("handles a US spring-forward day, where 02:00 does not exist", () => {
    // 8 March 2026 is the US DST transition.
    const start = dayStartUtc("2026-03-08", "America/New_York");
    assert.equal(localDay(start, "America/New_York"), "2026-03-08");
  });
});

describe("calendar arithmetic", () => {
  it("adds and subtracts days across month and year ends", () => {
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2028-02-28", 1), "2028-02-29", "2028 is a leap year");
  });

  it("measures distance between days", () => {
    assert.equal(daysBetween("2026-03-01", "2026-03-08"), 7);
    assert.equal(daysBetween("2026-03-08", "2026-03-01"), -7);
    assert.equal(daysBetween("2026-03-01", "2026-03-01"), 0);
  });
});

describe("computeStreak", () => {
  const days = (...list: string[]) => new Set(list);

  it("counts a run ending today", () => {
    const set = days("2026-03-01", "2026-03-02", "2026-03-03");
    const r = computeStreak(set, "2026-03-03");
    assert.equal(r.current, 3);
    assert.equal(r.includesToday, true);
  });

  it("keeps the streak alive on a day not yet studied", () => {
    // Today is not done, but yesterday was — the streak is intact until midnight.
    const set = days("2026-03-01", "2026-03-02");
    const r = computeStreak(set, "2026-03-03");
    assert.equal(r.current, 2);
    assert.equal(r.includesToday, false);
  });

  it("breaks once the grace day passes", () => {
    const set = days("2026-03-01", "2026-03-02");
    const r = computeStreak(set, "2026-03-04");
    assert.equal(r.current, 0);
  });

  it("ignores completed days on the far side of a gap", () => {
    const set = days("2026-01-01", "2026-01-02", "2026-03-02", "2026-03-03");
    assert.equal(computeStreak(set, "2026-03-03").current, 2);
  });

  it("returns zero with no history", () => {
    assert.equal(computeStreak(new Set(), "2026-03-03").current, 0);
  });

  it("counts a single day", () => {
    assert.equal(computeStreak(days("2026-03-03"), "2026-03-03").current, 1);
  });
});

describe("computeLongestStreak", () => {
  it("finds the longest run among several", () => {
    const set = new Set([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-02-01",
      "2026-02-02",
      "2026-02-03",
      "2026-02-04",
      "2026-03-01",
    ]);
    assert.equal(computeLongestStreak(set), 4);
  });

  it("is zero with no history and one for a single day", () => {
    assert.equal(computeLongestStreak(new Set()), 0);
    assert.equal(computeLongestStreak(new Set(["2026-03-01"])), 1);
  });

  it("spans a month boundary", () => {
    const set = new Set(["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);
    assert.equal(computeLongestStreak(set), 4);
  });
});
