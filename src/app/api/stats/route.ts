import { requireUserId } from "@/lib/auth";
import { json, route } from "@/lib/api";
import { getOverview } from "@/lib/stats";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  const userId = await requireUserId();
  const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get("days") ?? 60) || 60, 7), 365);
  return json(await getOverview(db, userId, days));
});
