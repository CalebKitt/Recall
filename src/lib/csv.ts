/**
 * RFC 4180 CSV parsing and serialisation, with a few pragmatic extensions:
 *
 *  - delimiter auto-detection (comma / tab / semicolon), so Anki's TSV exports
 *    import without the user having to convert anything first;
 *  - flexible header matching, so "Question"/"Term"/"Front" all work;
 *  - headerless files, where the first two columns are taken as front/back.
 */

export type Delimiter = "," | "\t" | ";";

/**
 * Guess the delimiter by counting candidates outside quoted regions on the
 * first few lines. Whichever appears most consistently wins.
 */
export function detectDelimiter(text: string): Delimiter {
  const candidates: Delimiter[] = [",", "\t", ";"];
  const sample = text.slice(0, 64_000);
  let best: Delimiter = ",";
  let bestScore = -1;

  for (const delim of candidates) {
    const rows = parseDelimited(sample, delim).slice(0, 20);
    if (rows.length === 0) continue;
    const widths = rows.map((r) => r.length);
    const maxWidth = Math.max(...widths);
    if (maxWidth < 2) continue;
    // Prefer the delimiter giving the widest, most uniform table.
    const uniform = widths.filter((w) => w === maxWidth).length / widths.length;
    const score = maxWidth * uniform;
    if (score > bestScore) {
      bestScore = score;
      best = delim;
    }
  }
  return best;
}

/** Full RFC 4180 state machine: quoted fields, doubled quotes, CRLF, embedded newlines. */
export function parseDelimited(text: string, delimiter: Delimiter = ","): string[][] {
  // Strip a UTF-8 BOM, which Excel loves to prepend.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAnyChar = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // Skip the escaped pair.
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === "") {
      inQuotes = true;
      sawAnyChar = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
      sawAnyChar = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      // Drop blank lines rather than emitting phantom empty cards.
      if (!(row.length === 1 && row[0] === "")) rows.push(row);
      row = [];
      field = "";
      sawAnyChar = false;
    } else {
      field += ch;
      sawAnyChar = true;
    }
  }

  if (field !== "" || row.length > 0 || sawAnyChar) {
    row.push(field);
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
  }

  return rows;
}

/** Quote a field only when it needs it, matching what spreadsheets expect. */
function escapeField(value: string, delimiter: Delimiter): string {
  const s = value ?? "";
  if (s.includes('"') || s.includes(delimiter) || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function stringifyCsv(rows: (string | number | boolean | null)[][], delimiter: Delimiter = ","): string {
  return rows
    .map((row) => row.map((cell) => escapeField(cell === null ? "" : String(cell), delimiter)).join(delimiter))
    .join("\r\n");
}

/* ------------------------------------------------------------------ *
 * Card-specific mapping
 * ------------------------------------------------------------------ */

export interface ParsedCardRow {
  front: string;
  back: string;
  hint: string;
  tags: string[];
  /** Present only when re-importing a file this app exported. */
  scheduling?: {
    state: string;
    intervalDays: number;
    ease: number;
    reps: number;
    lapses: number;
    dueAt: string | null;
    totalReviews: number;
    correctReviews: number;
  };
}

export const EXPORT_HEADER = [
  "front",
  "back",
  "hint",
  "tags",
  "state",
  "interval_days",
  "ease",
  "reps",
  "lapses",
  "due_at",
  "total_reviews",
  "correct_reviews",
] as const;

const ALIASES: Record<string, string[]> = {
  front: ["front", "question", "term", "prompt", "q", "word", "side1", "text"],
  back: ["back", "answer", "definition", "meaning", "a", "side2", "translation"],
  hint: ["hint", "note", "notes", "extra", "context", "example"],
  tags: ["tags", "tag", "category", "categories", "deck"],
  state: ["state", "status"],
  interval_days: ["interval_days", "interval", "ivl"],
  ease: ["ease", "ease_factor", "factor"],
  reps: ["reps", "repetitions", "reviews"],
  lapses: ["lapses", "lapse"],
  due_at: ["due_at", "due", "due_date"],
  total_reviews: ["total_reviews", "total"],
  correct_reviews: ["correct_reviews", "correct"],
};

const normalise = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, "_");

/** Map header cells to canonical field names; returns null when no header is present. */
function mapHeader(cells: string[]): Record<string, number> | null {
  const found: Record<string, number> = {};
  cells.forEach((cell, idx) => {
    const key = normalise(cell);
    for (const [canonical, aliases] of Object.entries(ALIASES)) {
      if (aliases.includes(key) && !(canonical in found)) found[canonical] = idx;
    }
  });
  // A header is only credible if it at least identifies the front of the card.
  return "front" in found || "back" in found ? found : null;
}

const num = (v: string | undefined, fallback: number): number => {
  const n = Number((v ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
};

export interface ImportParseResult {
  cards: ParsedCardRow[];
  delimiter: Delimiter;
  hadHeader: boolean;
  /** Rows dropped because they had no usable front/back, with line numbers. */
  skipped: { line: number; reason: string }[];
}

export function parseCardsCsv(text: string, delimiter?: Delimiter): ImportParseResult {
  const delim = delimiter ?? detectDelimiter(text);
  const rows = parseDelimited(text, delim);
  const skipped: { line: number; reason: string }[] = [];

  if (rows.length === 0) {
    return { cards: [], delimiter: delim, hadHeader: false, skipped };
  }

  const header = mapHeader(rows[0]);
  const dataRows = header ? rows.slice(1) : rows;
  const offset = header ? 2 : 1; // 1-based line numbers for user-facing errors.

  const cards: ParsedCardRow[] = [];

  dataRows.forEach((cells, i) => {
    const line = i + offset;
    const at = (field: string, fallbackIdx: number): string => {
      const idx = header ? header[field] : fallbackIdx;
      if (idx === undefined || idx < 0) return "";
      return (cells[idx] ?? "").trim();
    };

    const front = at("front", 0);
    const back = at("back", 1);

    if (!front && !back) {
      skipped.push({ line, reason: "empty row" });
      return;
    }
    if (!front || !back) {
      skipped.push({ line, reason: front ? "missing answer" : "missing question" });
      return;
    }

    const rawTags = at("tags", 3);
    const tags = rawTags
      ? rawTags
          .split(/[,;|\s]+/)
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

    const card: ParsedCardRow = { front, back, hint: at("hint", 2), tags };

    // Only treat scheduling columns as authoritative when a header named them.
    if (header && ("state" in header || "interval_days" in header)) {
      const dueRaw = at("due_at", -1);
      card.scheduling = {
        state: at("state", -1) || "new",
        intervalDays: num(at("interval_days", -1), 0),
        ease: num(at("ease", -1), 2.5),
        reps: num(at("reps", -1), 0),
        lapses: num(at("lapses", -1), 0),
        dueAt: dueRaw && !Number.isNaN(Date.parse(dueRaw)) ? dueRaw : null,
        totalReviews: num(at("total_reviews", -1), 0),
        correctReviews: num(at("correct_reviews", -1), 0),
      };
    }

    cards.push(card);
  });

  return { cards, delimiter: delim, hadHeader: Boolean(header), skipped };
}
