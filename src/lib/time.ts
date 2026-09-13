/**
 * Timezone-aware calendar helpers.
 *
 * Streaks and "cards done today" are calendar-day concepts, and a user in
 * Auckland must not lose a streak because the server thinks it is still
 * yesterday in UTC. Every day boundary in the app is resolved through here
 * using the user's stored IANA timezone.
 */

const DAY_MS = 86_400_000;

/** True if the runtime recognises the zone; guards against junk in the DB. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function safeZone(tz: string | null | undefined): string {
  return tz && isValidTimeZone(tz) ? tz : "UTC";
}

/** Local calendar day for an instant, as `YYYY-MM-DD`. */
export function localDay(instant: Date, tz: string): string {
  // en-CA formats as YYYY-MM-DD, which is exactly the shape we store.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: safeZone(tz),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** Offset of `tz` from UTC at `instant`, in milliseconds (east of UTC positive). */
function zoneOffsetMs(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone(tz),
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // Intl renders midnight as hour 24 in some engines; normalise it.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant at which `day` (a `YYYY-MM-DD` string) begins in `tz`.
 *
 * Resolved iteratively because the offset itself depends on the instant — one
 * correction pass settles it except across a DST transition, where the second
 * pass converges.
 */
export function dayStartUtc(day: string, tz: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  let guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  for (let i = 0; i < 2; i++) {
    const offset = zoneOffsetMs(guess, tz);
    const corrected = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offset);
    if (corrected.getTime() === guess.getTime()) break;
    guess = corrected;
  }
  return guess;
}

/** Start of the user's current local day, as a UTC instant. */
export function todayStartUtc(tz: string, now: Date = new Date()): Date {
  return dayStartUtc(localDay(now, tz), tz);
}

/** Shift a `YYYY-MM-DD` string by whole days, staying in calendar space. */
export function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d) + delta * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / DAY_MS);
}

/**
 * Longest run of completed days ending today (or yesterday).
 *
 * Yesterday counts as the anchor so that a streak is not shown as broken
 * partway through a day the user has not studied yet — it only breaks once
 * that grace day passes.
 *
 * @param completedDays Set of `YYYY-MM-DD` strings the user finished.
 * @param today The user's current local day.
 */
export function computeStreak(
  completedDays: Set<string>,
  today: string,
): { current: number; includesToday: boolean } {
  const includesToday = completedDays.has(today);
  let anchor = today;
  if (!includesToday) {
    const yesterday = addDays(today, -1);
    if (!completedDays.has(yesterday)) return { current: 0, includesToday: false };
    anchor = yesterday;
  }

  let count = 0;
  let cursor = anchor;
  while (completedDays.has(cursor)) {
    count++;
    cursor = addDays(cursor, -1);
  }
  return { current: count, includesToday };
}

/** Best (longest ever) run of completed days. */
export function computeLongestStreak(completedDays: Set<string>): number {
  const sorted = [...completedDays].sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of sorted) {
    run = prev !== null && daysBetween(prev, day) === 1 ? run + 1 : 1;
    prev = day;
    if (run > best) best = run;
  }
  return best;
}
