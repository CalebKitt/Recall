import { requireUserId } from "@/lib/auth";
import { json, route } from "@/lib/api";
import { buildQueue, getStreak } from "@/lib/study";
import { getSettings } from "@/lib/settings";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** The next batch of cards to study, for one deck or across every deck. */
export const GET = route(async (req: Request) => {
  const userId = await requireUserId();
  const url = new URL(req.url);
  const deckId = url.searchParams.get("deckId");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 60) || 60, 200);
  // "Review early": pull cards due over the next few days when nothing is due.
  const ahead = url.searchParams.get("ahead") === "1";

  const [queue, streak, settings] = await Promise.all([
    buildQueue(db, userId, deckId, limit, { ahead }),
    getStreak(db, userId),
    getSettings(db, userId),
  ]);

  return json({
    ...queue,
    streak: { current: streak.current, longest: streak.longest, includesToday: streak.includesToday },
    aiRewordEnabled: settings.aiRewordEnabled,
  });
});
