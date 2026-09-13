"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, EmptyState, ErrorNote, Skeleton, cn } from "@/components/ui";
import { accuracyTone, formatPct, getJson } from "@/lib/client";

interface DayPoint {
  day: string;
  reviews: number;
  correct: number;
  accuracy: number | null;
  completed: boolean;
}

interface DeckStat {
  deckId: string;
  name: string;
  color: string;
  totalCards: number;
  newCards: number;
  learning: number;
  young: number;
  mature: number;
  suspended: number;
  totalReviews: number;
  accuracy: number | null;
  dueNow: number;
}

interface Overview {
  streak: { current: number; longest: number; includesToday: boolean };
  totals: {
    decks: number;
    cards: number;
    reviews: number;
    accuracy: number | null;
    reviewsToday: number;
    accuracyToday: number | null;
    studyDays: number;
    avgSecondsPerCard: number | null;
  };
  history: DayPoint[];
  ratingSpread: { rating: number; n: number }[];
  decks: DeckStat[];
}

const RATING_META: Record<number, { label: string; className: string }> = {
  1: { label: "Again", className: "bg-bad" },
  2: { label: "Hard", className: "bg-warn" },
  3: { label: "Good", className: "bg-accent" },
  4: { label: "Easy", className: "bg-good" },
};

export default function StatsPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState(60);

  useEffect(() => {
    setData(null);
    getJson<Overview>(`/api/stats?days=${range}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [range]);

  if (error) return <ErrorNote>{error}</ErrorNote>;

  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-52" />
      </div>
    );
  }

  if (data.totals.cards === 0) {
    return (
      <EmptyState
        icon="◔"
        title="No statistics yet"
        description="Once you create a deck and start reviewing, your accuracy, streak and activity show up here."
        action={
          <Link href="/decks">
            <Button variant="primary">Create a deck</Button>
          </Link>
        }
      />
    );
  }

  const { streak, totals } = data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-text sm:text-2xl">Statistics</h1>
        <div className="flex gap-1">
          {[30, 60, 180].map((d) => (
            <button
              key={d}
              onClick={() => setRange(d)}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs font-medium transition",
                range === d ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted hover:text-text",
              )}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Headline tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Current streak"
          value={streak.current === 0 ? "—" : `${streak.current}`}
          suffix={streak.current > 0 ? (streak.current === 1 ? "day" : "days") : undefined}
          accent={streak.includesToday ? "streak" : "muted"}
          icon="🔥"
          footnote={
            streak.includesToday
              ? "Today is done"
              : streak.current > 0
                ? "Finish today to extend it"
                : "Clear your queue to start"
          }
        />
        <StatTile
          label="Best streak"
          value={`${streak.longest}`}
          suffix={streak.longest === 1 ? "day" : "days"}
          footnote={`${totals.studyDays} day${totals.studyDays === 1 ? "" : "s"} studied`}
        />
        <StatTile
          label="Overall accuracy"
          value={formatPct(totals.accuracy)}
          accent={accuracyTone(totals.accuracy)}
          footnote={`${totals.reviews.toLocaleString()} reviews`}
        />
        <StatTile
          label="Today"
          value={`${totals.reviewsToday}`}
          suffix="cards"
          footnote={
            totals.accuracyToday !== null
              ? `${formatPct(totals.accuracyToday)} correct`
              : "Nothing yet today"
          }
        />
      </div>

      {/* Activity */}
      <section className="card-surface space-y-4 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-text">Activity</h2>
          <p className="text-xs text-muted">
            Bar height is reviews per day. A dot marks a day you cleared the whole queue.
          </p>
        </div>
        <ActivityChart history={data.history} />
      </section>

      {/* Answer spread */}
      {totals.reviews > 0 && (
        <section className="card-surface space-y-3 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-text">How you answer</h2>
            {totals.avgSecondsPerCard !== null && (
              <p className="text-xs text-muted">
                {totals.avgSecondsPerCard.toFixed(1)}s average per card
              </p>
            )}
          </div>
          <RatingSpread spread={data.ratingSpread} total={totals.reviews} />
        </section>
      )}

      {/* Per-deck */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-text">By deck</h2>
        <div className="space-y-2">
          {data.decks.map((deck) => (
            <DeckStatRow key={deck.deckId} deck={deck} />
          ))}
        </div>
      </section>
    </div>
  );
}

function StatTile({
  label,
  value,
  suffix,
  footnote,
  accent = "muted",
  icon,
}: {
  label: string;
  value: string;
  suffix?: string;
  footnote?: string;
  accent?: "muted" | "good" | "warn" | "bad" | "streak";
  icon?: string;
}) {
  const accents: Record<string, string> = {
    muted: "text-text",
    good: "text-good",
    warn: "text-warn",
    bad: "text-bad",
    streak: "text-streak",
  };

  return (
    <div className="card-surface p-3.5">
      <p className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
        {icon && (
          <span className={cn(accent === "muted" && "grayscale opacity-50")} aria-hidden="true">
            {icon}
          </span>
        )}
        {label}
      </p>
      <p className={cn("mt-1.5 text-2xl font-semibold tabular-nums", accents[accent])}>
        {value}
        {suffix && <span className="ml-1 text-sm font-medium text-muted">{suffix}</span>}
      </p>
      {footnote && <p className="mt-0.5 text-[11px] text-muted">{footnote}</p>}
    </div>
  );
}

/**
 * Reviews-per-day bar chart.
 *
 * Drawn as plain divs rather than SVG so it reflows naturally at any width and
 * stays legible on a phone.
 */
function ActivityChart({ history }: { history: DayPoint[] }) {
  const max = Math.max(1, ...history.map((h) => h.reviews));
  const totalReviews = history.reduce((s, h) => s + h.reviews, 0);

  if (totalReviews === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted">
        No reviews in this period yet.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex h-32 items-end gap-[2px]">
        {history.map((h) => {
          const heightPct = h.reviews === 0 ? 0 : Math.max(6, (h.reviews / max) * 100);
          return (
            // h-full is required: the bar's percentage height resolves against
            // this wrapper, which would otherwise be auto-sized to zero.
            <div key={h.day} className="group relative flex h-full flex-1 flex-col items-center justify-end gap-1">
              {h.completed && (
                <span className="size-1 shrink-0 rounded-full bg-streak" aria-hidden="true" />
              )}
              <div
                className={cn(
                  "w-full rounded-sm transition",
                  h.reviews === 0 ? "h-px bg-border" : "bg-accent/70 group-hover:bg-accent",
                )}
                style={h.reviews > 0 ? { height: `${heightPct}%` } : undefined}
              />
              {/* Hover detail — desktop only, since there is no hover on touch. */}
              <div className="pointer-events-none absolute bottom-full z-10 mb-1 hidden whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 text-[11px] shadow-lg group-hover:block">
                <span className="font-medium text-text">{h.day}</span>
                <br />
                <span className="text-muted">
                  {h.reviews} review{h.reviews === 1 ? "" : "s"}
                  {h.accuracy !== null && ` · ${formatPct(h.accuracy)}`}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex justify-between text-[11px] text-muted">
        <span>{history[0]?.day}</span>
        <span className="tabular-nums">{totalReviews.toLocaleString()} reviews</span>
        <span>{history[history.length - 1]?.day}</span>
      </div>
    </div>
  );
}

function RatingSpread({ spread, total }: { spread: { rating: number; n: number }[]; total: number }) {
  const byRating = useMemo(() => {
    const map = new Map(spread.map((s) => [s.rating, s.n]));
    return [1, 2, 3, 4].map((r) => ({ rating: r, n: map.get(r) ?? 0 }));
  }, [spread]);

  return (
    <div className="space-y-2.5">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-2">
        {byRating.map(({ rating, n }) =>
          n === 0 ? null : (
            <div
              key={rating}
              className={RATING_META[rating].className}
              style={{ width: `${(n / total) * 100}%` }}
              title={`${RATING_META[rating].label}: ${n}`}
            />
          ),
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {byRating.map(({ rating, n }) => (
          <span key={rating} className="flex items-center gap-1.5 text-xs text-muted">
            <span className={cn("size-2 rounded-full", RATING_META[rating].className)} aria-hidden="true" />
            {RATING_META[rating].label}
            <span className="tabular-nums text-text">{total > 0 ? formatPct(n / total) : "—"}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function DeckStatRow({ deck }: { deck: DeckStat }) {
  const segments = [
    { n: deck.newCards, className: "bg-accent", label: "new" },
    { n: deck.learning, className: "bg-warn", label: "learning" },
    { n: deck.young, className: "bg-good/50", label: "young" },
    { n: deck.mature, className: "bg-good", label: "mature" },
    { n: deck.suspended, className: "bg-border", label: "suspended" },
  ];
  const total = Math.max(1, deck.totalCards);

  return (
    <Link href={`/decks/${deck.deckId}`} className="card-surface block p-3.5 transition hover:border-accent">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{deck.name}</span>
        {deck.dueNow > 0 && <Badge tone="good">{deck.dueNow} due</Badge>}
        <Badge tone={deck.accuracy === null ? "muted" : accuracyTone(deck.accuracy)}>
          {formatPct(deck.accuracy)}
        </Badge>
      </div>

      <div className="mt-2.5 flex h-1.5 overflow-hidden rounded-full bg-surface-2">
        {segments.map((s) =>
          s.n === 0 ? null : (
            <div
              key={s.label}
              className={s.className}
              style={{ width: `${(s.n / total) * 100}%` }}
              title={`${s.n} ${s.label}`}
            />
          ),
        )}
      </div>

      <p className="mt-2 text-[11px] text-muted tabular-nums">
        {deck.totalCards} cards · {deck.mature} mature · {deck.newCards} new ·{" "}
        {deck.totalReviews.toLocaleString()} reviews
      </p>
    </Link>
  );
}
