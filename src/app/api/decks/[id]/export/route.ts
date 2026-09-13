import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { cards, decks } from "@/lib/db/schema";
import { requireUserId } from "@/lib/auth";
import { notFound, route } from "@/lib/api";
import { EXPORT_HEADER, stringifyCsv, type Delimiter } from "@/lib/csv";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Make the deck name safe for a Content-Disposition filename. */
function safeFilename(name: string): string {
  const cleaned = name.replace(/[^\w\s.-]/g, "").trim().replace(/\s+/g, "-");
  return (cleaned || "deck").slice(0, 60);
}

/**
 * Download a deck as CSV.
 *
 * `?scheduling=0` emits just question/answer/hint/tags, which is what you want
 * when sharing a deck. The default includes scheduling columns so an export is
 * a true backup that round-trips through import without losing progress.
 */
export const GET = route(async (req: Request, { params }: Params) => {
  const userId = await requireUserId();
  const { id } = await params;

  const deck = await db.query.decks.findFirst({
    where: and(eq(decks.id, id), eq(decks.userId, userId)),
  });
  if (!deck) throw notFound("Deck not found");

  const url = new URL(req.url);
  const includeScheduling = url.searchParams.get("scheduling") !== "0";
  const delimiter: Delimiter = url.searchParams.get("format") === "tsv" ? "\t" : ",";

  const rows = await db
    .select()
    .from(cards)
    .where(and(eq(cards.deckId, id), eq(cards.userId, userId)))
    // Cards inserted in one batch share a createdAt, so break the tie on id to
    // keep repeated exports byte-identical.
    .orderBy(asc(cards.createdAt), asc(cards.id));

  const header = includeScheduling ? [...EXPORT_HEADER] : EXPORT_HEADER.slice(0, 4);

  const body = rows.map((c) => {
    const base = [c.front, c.back, c.hint, c.tags.join(" ")];
    if (!includeScheduling) return base;
    return [
      ...base,
      c.state,
      c.intervalDays.toFixed(4),
      c.ease.toFixed(4),
      c.reps,
      c.lapses,
      c.dueAt.toISOString(),
      c.totalReviews,
      c.correctReviews,
    ];
  });

  const csv = stringifyCsv([header, ...body], delimiter);
  const ext = delimiter === "\t" ? "tsv" : "csv";

  return new Response("﻿" + csv, {
    headers: {
      // The BOM makes Excel open UTF-8 correctly instead of mangling accents.
      "content-type": `text/${ext === "tsv" ? "tab-separated-values" : "csv"}; charset=utf-8`,
      "content-disposition": `attachment; filename="${safeFilename(deck.name)}.${ext}"`,
      "cache-control": "no-store",
    },
  });
});
