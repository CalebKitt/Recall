import { requireUserId } from "@/lib/auth";
import { json, notFound, route } from "@/lib/api";
import { getDeckStats } from "@/lib/stats";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Params) => {
  const userId = await requireUserId();
  const { id } = await params;

  const stats = await getDeckStats(db, userId, id);
  if (!stats) throw notFound("Deck not found");

  return json(stats);
});
