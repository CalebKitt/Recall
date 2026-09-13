"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, EmptyState, ErrorNote, Skeleton, cn, useToast } from "@/components/ui";
import { getJson, postJson, relativeTime } from "@/lib/client";
import { RATING_LABELS, type Rating } from "@/lib/srs";
import { notifyStreakChanged } from "@/components/Nav";

interface QueueCard {
  id: string;
  deckId: string;
  deckName: string;
  front: string;
  back: string;
  hint: string;
  state: "new" | "learning" | "review" | "relearning";
  totalReviews: number;
  correctReviews: number;
  intervals: Record<string, string>;
}

interface QueueResponse {
  cards: QueueCard[];
  counts: { newCards: number; learning: number; review: number; total: number };
  nextDueAt: string | null;
  /** True when the queue is showing cards that are not actually due yet. */
  ahead: boolean;
  streak: { current: number; longest: number; includesToday: boolean };
  aiRewordEnabled: boolean;
}

interface AnswerResponse {
  streak: number;
  dayCompleted: boolean;
  counts: { newCards: number; learning: number; review: number; total: number };
  becameLeech: boolean;
  card: { dueAt: string };
}

interface RewordResponse {
  text: string;
  isVariant: boolean;
  /** Which cached wording was served; sent back when asking for a different one. */
  variantId?: string;
  reason?: string;
  error?: string;
}

const RATING_STYLES: Record<Rating, string> = {
  1: "bg-bad-soft text-bad hover:brightness-95",
  2: "bg-warn-soft text-warn hover:brightness-95",
  3: "bg-accent text-accent-text hover:opacity-90",
  4: "bg-good-soft text-good hover:brightness-95",
};

const STATE_LABEL: Record<QueueCard["state"], { text: string; tone: "accent" | "warn" | "good" }> = {
  new: { text: "New", tone: "accent" },
  learning: { text: "Learning", tone: "warn" },
  relearning: { text: "Relearning", tone: "warn" },
  review: { text: "Review", tone: "good" },
};

/** Cards beyond the current one whose wording is prepared in advance. */
const PREFETCH_AHEAD = 2;
/**
 * Longest a card is held waiting for its AI wording. After this the original
 * wording is shown; a card is never held indefinitely on a slow model.
 */
const REWORD_WAIT_LIMIT_MS = 30_000;
/**
 * A grade is only accepted this long after the answer was revealed, so a single
 * held or double-tapped Space cannot reveal a card and grade it in one go.
 */
const GRADE_AFTER_REVEAL_MS = 350;

export default function StudyPage() {
  return (
    <Suspense fallback={<Skeleton className="h-80" />}>
      <StudySession />
    </Suspense>
  );
}

function StudySession() {
  const params = useSearchParams();
  const deckId = params.get("deck");
  const reviewAhead = params.get("ahead") === "1";
  const toast = useToast();

  const [queue, setQueue] = useState<QueueCard[]>([]);
  const [index, setIndex] = useState(0);
  const [meta, setMeta] = useState<QueueResponse | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Final wording per card id. A card's entry is written once and never
   * replaced, which is what guarantees a card on screen never changes.
   */
  const [prompts, setPrompts] = useState<Record<string, RewordResponse>>({});
  const [showOriginal, setShowOriginal] = useState(false);
  const [rewording, setRewording] = useState(false);
  /** Card ids with a rewording request in flight, so none is requested twice. */
  const inFlight = useRef<Set<string>>(new Set());

  const [session, setSession] = useState({ answered: 0, correct: 0 });
  const [finished, setFinished] = useState<{ dayCompleted: boolean; streak: number } | null>(null);

  const shownAt = useRef<number>(Date.now());
  /** When the answer was revealed, used for the grading cooldown. */
  const revealedAt = useRef<number>(0);
  const card = queue[index] ?? null;

  /* ---------------- queue loading ---------------- */

  const queueUrl = useMemo(() => {
    const p = new URLSearchParams();
    if (deckId) p.set("deckId", deckId);
    if (reviewAhead) p.set("ahead", "1");
    const qs = p.toString();
    return qs ? `/api/study/queue?${qs}` : "/api/study/queue";
  }, [deckId, reviewAhead]);

  const loadQueue = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!opts.silent) setLoading(true);
      setError(null);
      try {
        const data = await getJson<QueueResponse>(queueUrl);
        setMeta(data);
        setQueue(data.cards);
        setIndex(0);
        setRevealed(false);
        setShowOriginal(false);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [queueUrl],
  );

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  /* ---------------- AI rewording ---------------- */

  /** Record a card's wording once; any later result for that card is dropped. */
  const settlePrompt = useCallback((id: string, value: RewordResponse) => {
    setPrompts((prev) => (prev[id] ? prev : { ...prev, [id]: value }));
  }, []);

  const fetchReword = useCallback(
    async (targetId: string) => {
      if (inFlight.current.has(targetId)) return;
      inFlight.current.add(targetId);
      try {
        const res = await postJson<RewordResponse>("/api/study/reword", { cardId: targetId });
        settlePrompt(targetId, res);
      } catch (e) {
        // Settle on the card's own wording; a failure never blocks the review.
        settlePrompt(targetId, { text: "", isVariant: false, error: (e as Error).message });
      } finally {
        inFlight.current.delete(targetId);
      }
    },
    [settlePrompt],
  );

  // Prepare the current card and the next few, so that by the time the reader
  // reaches a card its wording is usually already settled and there is no wait.
  useEffect(() => {
    if (!meta?.aiRewordEnabled) return;
    for (const c of queue.slice(index, index + PREFETCH_AHEAD + 1)) {
      if (!prompts[c.id]) void fetchReword(c.id);
    }
  }, [index, queue, meta?.aiRewordEnabled, prompts, fetchReword]);

  /** True while the current card is held back waiting for its final wording. */
  const waitingForWording = Boolean(meta?.aiRewordEnabled && card && !prompts[card.id]);

  // Cap the hold. Past the limit the original wording is settled for this card,
  // and settlePrompt drops the late AI result, so the card still never changes.
  useEffect(() => {
    if (!waitingForWording || !card) return;
    const id = card.id;
    const timer = setTimeout(
      () => settlePrompt(id, { text: "", isVariant: false, error: "timeout" }),
      REWORD_WAIT_LIMIT_MS,
    );
    return () => clearTimeout(timer);
  }, [waitingForWording, card, settlePrompt]);

  const prompt = card ? prompts[card.id] : undefined;
  const usingVariant = Boolean(prompt?.isVariant && !showOriginal);
  const displayedFront = usingVariant && prompt?.text ? prompt.text : (card?.front ?? "");

  /**
   * Swap in a different wording at the reader's request.
   *
   * Automatic rewording deliberately never replaces a question already on
   * screen; this does, because the change is the point of pressing the button.
   */
  const rewordAgain = useCallback(async () => {
    if (!card || rewording) return;
    setRewording(true);
    try {
      const res = await postJson<RewordResponse>("/api/study/reword", {
        cardId: card.id,
        refresh: true,
        currentVariantId: prompt?.variantId,
      });
      setPrompts((prev) => ({ ...prev, [card.id]: res }));
      setShowOriginal(false);
      if (res.error) toast(res.error, "error");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setRewording(false);
    }
  }, [card, rewording, prompt?.variantId, toast]);

  /* ---------------- answering ---------------- */

  const reveal = useCallback(() => {
    if (!revealed && card && !waitingForWording) {
      revealedAt.current = Date.now();
      setRevealed(true);
    }
  }, [revealed, card, waitingForWording]);

  const answer = useCallback(
    async (rating: Rating) => {
      if (!card || submitting || !revealed) return;
      setSubmitting(true);

      try {
        const res = await postJson<AnswerResponse>("/api/study/answer", {
          cardId: card.id,
          rating,
          elapsedMs: Math.min(Date.now() - shownAt.current, 3_600_000),
          usedAiVariant: usingVariant,
        });

        setSession((s) => ({ answered: s.answered + 1, correct: s.correct + (rating > 1 ? 1 : 0) }));
        setMeta((m) => (m ? { ...m, counts: res.counts } : m));
        notifyStreakChanged();

        if (res.becameLeech) {
          toast("That card has lapsed 8 times — it's been suspended so it stops interrupting you.", "error");
        }

        // "Again" and "Hard" on a learning card mean it comes back this session.
        const repeatSoon = rating === 1;
        const remaining = queue.slice(index + 1);
        const nextQueue = repeatSoon ? [...remaining, card] : remaining;

        if (nextQueue.length === 0) {
          const refreshed = await getJson<QueueResponse>(queueUrl);
          if (refreshed.cards.length === 0) {
            setFinished({ dayCompleted: res.dayCompleted, streak: res.streak });
            setQueue([]);
            setMeta(refreshed);
          } else {
            setMeta(refreshed);
            setQueue(refreshed.cards);
            setIndex(0);
          }
        } else {
          setQueue(nextQueue);
          setIndex(0);
        }

        setRevealed(false);
        setShowOriginal(false);
        shownAt.current = Date.now();
      } catch (e) {
        toast((e as Error).message, "error");
      } finally {
        setSubmitting(false);
      }
    },
    [card, submitting, revealed, usingVariant, queue, index, queueUrl, toast],
  );

  // Time on card starts when the card appears, not while its wording is being
  // prepared, so AI latency does not inflate the seconds-per-card statistic.
  useEffect(() => {
    if (!waitingForWording) shownAt.current = Date.now();
  }, [card?.id, waitingForWording]);

  /* ---------------- keyboard ---------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Holding a key repeats it; without this a single press would reveal the
      // answer and then immediately grade the card.
      if (e.repeat) return;

      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      // A focused button already receives its own click from Space and Enter.
      // Acting here too would run two actions for one press — which is what
      // made Space misbehave after the buttons had been clicked with a mouse.
      // instanceof guard: a synthetic event can target window or document,
      // neither of which has closest(). A real keypress targets an element.
      if (target instanceof Element && target.closest("button, a")) return;

      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (!revealed) {
          reveal();
          return;
        }
        if (Date.now() - revealedAt.current < GRADE_AFTER_REVEAL_MS) return;
        void answer(3);
        return;
      }
      if (revealed && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        void answer(Number(e.key) as Rating);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [revealed, reveal, answer]);

  /* ---------------- render ---------------- */

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <ErrorNote>{error}</ErrorNote>
        <Button onClick={() => void loadQueue()}>Try again</Button>
      </div>
    );
  }

  if (finished || !card) {
    return (
      <DoneScreen
        deckId={deckId}
        session={session}
        finished={finished}
        nextDueAt={meta?.nextDueAt ?? null}
        streak={finished?.streak ?? meta?.streak.current ?? 0}
        wasAhead={meta?.ahead ?? false}
      />
    );
  }

  const counts = meta?.counts;
  const stateInfo = STATE_LABEL[card.state];

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      {/* Header: where you are and what's left */}
      <div className="flex flex-wrap items-center gap-2">
        <Link href={deckId ? `/decks/${card.deckId}` : "/decks"} className="text-sm text-muted hover:text-text">
          ← {deckId ? card.deckName : "All decks"}
        </Link>
        <div className="ml-auto flex items-center gap-1.5">
          {counts && counts.newCards > 0 && <Badge tone="accent">{counts.newCards}</Badge>}
          {counts && counts.learning > 0 && <Badge tone="warn">{counts.learning}</Badge>}
          {counts && counts.review > 0 && <Badge tone="good">{counts.review}</Badge>}
          {session.answered > 0 && (
            <span className="ml-1 text-xs text-muted tabular-nums">
              {session.correct}/{session.answered} this session
            </span>
          )}
        </div>
      </div>

      {meta?.ahead && (
        <p className="rounded-lg bg-warn-soft px-3.5 py-2 text-xs text-warn">
          Reviewing early — none of these are due yet. Answering still reschedules them, so this
          will push their next review further out.
        </p>
      )}

      {waitingForWording ? (
        <WordingPlaceholder />
      ) : (
        <>
        {/* The card */}
        <div
          className="card-surface flex min-h-[22rem] flex-col sm:min-h-[26rem]"
          onClick={() => !revealed && reveal()}
          role={!revealed ? "button" : undefined}
          tabIndex={!revealed ? 0 : undefined}
        >
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <Badge tone={stateInfo.tone}>{stateInfo.text}</Badge>
            {!deckId && <span className="truncate text-xs text-muted">{card.deckName}</span>}
            {card.totalReviews > 0 && (
              <span className="text-[11px] text-muted tabular-nums">
                {Math.round((card.correctReviews / card.totalReviews) * 100)}% correct
              </span>
            )}
            {meta?.aiRewordEnabled && (
              <div className="ml-auto flex items-center gap-1.5">
                {prompt?.isVariant ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowOriginal((v) => !v);
                    }}
                    className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent transition hover:opacity-80"
                    title="This question was rephrased by AI. Click to see the original."
                  >
                    {showOriginal ? "showing original" : "✦ reworded"}
                  </button>
                ) : prompt?.error ? (
                  <span
                    className="text-[11px] text-muted"
                    title={
                      prompt.error === "timeout"
                        ? "AI rewording took too long, so the original wording is shown."
                        : `AI rewording unavailable: ${prompt.error}`
                    }
                  >
                    original wording
                  </span>
                ) : null}

                {prompt?.isVariant && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void rewordAgain();
                    }}
                    disabled={rewording}
                    title="Ask for a different wording of this question"
                    aria-label="Reword this question again"
                    className="rounded-full px-2 py-0.5 text-[11px] font-semibold text-muted transition hover:bg-surface-2 hover:text-text disabled:opacity-50"
                  >
                    {rewording ? "rewording…" : "↻ reword"}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-1 flex-col items-center justify-center gap-5 px-5 py-8 text-center">
            <p className="text-xl font-medium leading-snug text-text sm:text-2xl">{displayedFront}</p>

            {revealed && (
              <div className="animate-reveal w-full space-y-3 border-t border-border pt-5">
                <p className="text-lg text-text sm:text-xl">{card.back}</p>
                {card.hint && <p className="text-sm text-muted">{card.hint}</p>}
              </div>
            )}
          </div>

          {!revealed && (
            <div className="px-4 pb-5 text-center text-xs text-muted">
              Tap the card or press <kbd className="rounded bg-surface-2 px-1.5 py-0.5">space</kbd> to reveal
            </div>
          )}
        </div>
        </>
      )}

      {/* Answer buttons */}
      {waitingForWording ? (
        <Button variant="primary" size="lg" className="w-full" disabled>
          Show answer
        </Button>
      ) : revealed ? (
        <div className="grid grid-cols-4 gap-2">
          {([1, 2, 3, 4] as Rating[]).map((r) => (
            <button
              key={r}
              disabled={submitting}
              onClick={() => void answer(r)}
              className={cn(
                "flex flex-col items-center gap-0.5 rounded-xl px-2 py-3 font-semibold transition disabled:opacity-50",
                RATING_STYLES[r],
              )}
            >
              <span className="text-sm">{RATING_LABELS[r]}</span>
              <span className="text-[11px] font-medium opacity-75 tabular-nums">{card.intervals[r]}</span>
            </button>
          ))}
        </div>
      ) : (
        <Button variant="primary" size="lg" className="w-full" onClick={reveal}>
          Show answer
        </Button>
      )}

      <div className="flex items-center justify-between text-[11px] text-muted">
        <span className="hidden sm:inline">Keys: space reveals, then 1–4 grades (space = Good)</span>
        <Link href={`/decks/${card.deckId}`} className="hover:text-text">
          Edit this deck
        </Link>
      </div>
    </div>
  );
}

function DoneScreen({
  deckId,
  session,
  finished,
  nextDueAt,
  streak,
  wasAhead,
}: {
  deckId: string | null;
  session: { answered: number; correct: number };
  finished: { dayCompleted: boolean; streak: number } | null;
  nextDueAt: string | null;
  streak: number;
  wasAhead: boolean;
}) {
  const accuracy = session.answered > 0 ? Math.round((session.correct / session.answered) * 100) : null;

  const summary = useMemo(() => {
    if (session.answered === 0) {
      if (wasAhead) {
        return nextDueAt
          ? `Nothing is due, and nothing falls due in the next few days either. Your next card comes up ${relativeTime(nextDueAt)}.`
          : "Nothing is due, and there is nothing close enough to review early.";
      }
      return nextDueAt
        ? `Nothing is due right now. Your next card comes up ${relativeTime(nextDueAt)}.`
        : "Nothing is due right now.";
    }
    return `You answered ${session.answered} card${session.answered === 1 ? "" : "s"}${
      accuracy !== null ? ` with ${accuracy}% accuracy` : ""
    }.`;
  }, [session, accuracy, nextDueAt, wasAhead]);

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <div className="card-surface flex flex-col items-center gap-4 px-6 py-12 text-center">
        <div className={cn("text-5xl", finished?.dayCompleted && "animate-pop")} aria-hidden="true">
          {finished?.dayCompleted ? "🔥" : session.answered > 0 ? "✓" : "☕"}
        </div>

        <div className="space-y-1.5">
          <h1 className="text-xl font-semibold text-text">
            {finished?.dayCompleted ? "Day complete" : session.answered > 0 ? "Session finished" : "All caught up"}
          </h1>
          <p className="text-sm text-muted">{summary}</p>
        </div>

        {finished?.dayCompleted && streak > 0 && (
          <div className="rounded-xl bg-warn-soft px-5 py-3">
            <p className="text-sm font-semibold text-streak">
              {streak} day streak
              {streak === 1 ? " started" : " and counting"}
            </p>
            <p className="mt-0.5 text-xs text-muted">
              Clear your queue again tomorrow to keep it going.
            </p>
          </div>
        )}

        {!finished?.dayCompleted && session.answered > 0 && (
          <p className="max-w-xs text-xs text-muted">
            Cards in other decks are still due. Finish everything today to extend your streak.
          </p>
        )}

        <div className="flex flex-wrap justify-center gap-2 pt-1">
          <Link href="/decks">
            <Button variant="primary">Back to decks</Button>
          </Link>
          {deckId && (
            <Link href={`/decks/${deckId}`}>
              <Button variant="secondary">Edit deck</Button>
            </Link>
          )}
          <Link href="/stats">
            <Button variant="secondary">View stats</Button>
          </Link>
        </div>
      </div>

      {session.answered === 0 && !nextDueAt && (
        <EmptyState
          icon="▤"
          title="Nothing scheduled"
          description="Add cards to a deck, or import a CSV, and they'll show up here right away."
          action={
            <Link href="/decks">
              <Button variant="primary">Go to decks</Button>
            </Link>
          }
        />
      )}
    </div>
  );
}

/**
 * Shown in place of the card while its AI wording is prepared, so the question
 * appears exactly once, already in its final form.
 */
function WordingPlaceholder() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="card-surface flex min-h-[22rem] flex-col items-center justify-center gap-6 px-5 py-8 text-center sm:min-h-[26rem]"
    >
      <div className="flex items-center gap-1.5" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="wording-dot size-2.5 rounded-full bg-accent"
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
      </div>
      <div className="w-full max-w-sm space-y-2.5" aria-hidden="true">
        <div className="wording-shimmer mx-auto h-5 w-4/5 rounded-md" />
        <div className="wording-shimmer mx-auto h-5 w-3/5 rounded-md" />
      </div>
      <p className="text-sm text-muted">
        <span className="text-accent">✦</span> Rewording this question…
      </p>
    </div>
  );
}
