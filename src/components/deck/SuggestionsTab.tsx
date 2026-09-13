"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, ErrorNote, Input, Skeleton, cn, useToast } from "@/components/ui";
import { del, getJson, postJson } from "@/lib/client";
import type { Deck } from "@/app/(app)/decks/[id]/page";

interface Suggestion {
  id: string;
  front: string;
  back: string;
  rationale: string;
}

interface SettingsResponse {
  settings: { aiAvailable: boolean };
}

/**
 * AI-suggested cards for a deck.
 *
 * Suggestions are generated server-side, deduped against the deck's existing
 * cards, and held in a pending state until the user accepts or rejects each
 * one. Accepting can also edit the text in place first.
 */
export function SuggestionsTab({
  deck,
  onAccepted,
  onCountChange,
}: {
  deck: Deck;
  onAccepted: () => void;
  onCountChange: (n: number) => void;
}) {
  const toast = useToast();
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<string | null>(null);
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await getJson<{ suggestions: Suggestion[] }>(`/api/decks/${deck.id}/suggestions`);
      setSuggestions(res.suggestions);
      onCountChange(res.suggestions.length);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [deck.id, onCountChange]);

  useEffect(() => {
    void load();
    getJson<SettingsResponse>("/api/settings")
      .then((s) => setAiAvailable(s.settings.aiAvailable))
      .catch(() => setAiAvailable(null));
  }, [load]);

  const generate = async (count: number) => {
    setGenerating(true);
    setError(null);
    try {
      const res = await postJson<{ suggestions: Suggestion[]; scope: string; filtered: number }>(
        `/api/decks/${deck.id}/suggestions`,
        { count },
      );
      setScope(res.scope || null);
      await load();

      if (res.suggestions.length === 0) {
        toast(
          res.filtered > 0
            ? "Everything suggested was already in your deck — try again for different angles."
            : "No new suggestions came back. Try again, or add a few more cards for context.",
          "info",
        );
      } else {
        toast(`${res.suggestions.length} suggestions ready`, "success");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const decide = async (
    suggestion: Suggestion,
    action: "accept" | "reject",
    edited?: { front: string; back: string },
  ) => {
    setBusyIds((prev) => new Set(prev).add(suggestion.id));
    try {
      await postJson(`/api/suggestions/${suggestion.id}`, { action, ...edited });
      setSuggestions((prev) => {
        const next = (prev ?? []).filter((s) => s.id !== suggestion.id);
        onCountChange(next.length);
        return next;
      });
      if (action === "accept") {
        onAccepted();
        toast("Card added to the deck", "success");
      }
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(suggestion.id);
        return next;
      });
    }
  };

  const acceptAll = async () => {
    const pending = suggestions ?? [];
    for (const s of pending) {
      await decide(s, "accept");
    }
  };

  const clearAll = async () => {
    if (!confirm("Dismiss all pending suggestions?")) return;
    try {
      await del(`/api/decks/${deck.id}/suggestions`);
      setSuggestions([]);
      onCountChange(0);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  if (aiAvailable === false) {
    return (
      <EmptyState
        icon="✦"
        title="No Gemini API key yet"
        description="AI suggestions need a Gemini API key. Add one in Settings — the free tier is plenty for this."
        action={
          <Link href="/settings">
            <Button variant="primary">Open settings</Button>
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="card-surface space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text">Suggest more cards</h2>
            <p className="mt-0.5 text-xs text-muted">
              AI reads your existing cards, works out the deck&apos;s subject, and proposes cards on
              that same subject that don&apos;t repeat what you already have.
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" loading={generating} onClick={() => void generate(5)}>
              Suggest 5
            </Button>
            <Button variant="primary" size="sm" loading={generating} onClick={() => void generate(10)}>
              Suggest 10
            </Button>
          </div>
        </div>

        {!deck.topic && (
          <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
            Tip: setting a specific <strong className="text-text">topic</strong> in the Settings tab
            (for example “Characters in Frank Herbert&apos;s Dune”) makes suggestions noticeably sharper.
          </p>
        )}

        {scope && (
          <p className="text-xs text-muted">
            Inferred subject: <span className="text-text">{scope}</span>
          </p>
        )}
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {generating && suggestions?.length === 0 && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      )}

      {suggestions === null ? (
        <Skeleton className="h-24" />
      ) : suggestions.length === 0 ? (
        !generating && (
          <EmptyState
            icon="✦"
            title="No pending suggestions"
            description="Generate some above. Anything you reject is remembered, so you won't see the same idea twice."
          />
        )
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-muted">
              {suggestions.length} pending suggestion{suggestions.length === 1 ? "" : "s"}
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => void clearAll()}>
                Dismiss all
              </Button>
              <Button size="sm" onClick={() => void acceptAll()}>
                Accept all
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            {suggestions.map((s) => (
              <SuggestionRow
                key={s.id}
                suggestion={s}
                busy={busyIds.has(s.id)}
                onAccept={(edited) => void decide(s, "accept", edited)}
                onReject={() => void decide(s, "reject")}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SuggestionRow({
  suggestion,
  busy,
  onAccept,
  onReject,
}: {
  suggestion: Suggestion;
  busy: boolean;
  onAccept: (edited?: { front: string; back: string }) => void;
  onReject: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [front, setFront] = useState(suggestion.front);
  const [back, setBack] = useState(suggestion.back);

  const dirty = front !== suggestion.front || back !== suggestion.back;

  return (
    <div className={cn("card-surface p-3.5 transition", busy && "opacity-50")}>
      {editing ? (
        <div className="space-y-2">
          <Input value={front} onChange={(e) => setFront(e.target.value)} placeholder="Question" />
          <Input value={back} onChange={(e) => setBack(e.target.value)} placeholder="Answer" />
        </div>
      ) : (
        <div className="space-y-1">
          <p className="text-sm font-medium text-text">{front}</p>
          <p className="text-sm text-muted">{back}</p>
        </div>
      )}

      {suggestion.rationale && !editing && (
        <p className="mt-2 border-l-2 border-border pl-2.5 text-xs italic text-muted">
          {suggestion.rationale}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !front.trim() || !back.trim()}
          onClick={() => onAccept(dirty ? { front: front.trim(), back: back.trim() } : undefined)}
        >
          Add{dirty ? " edited" : ""}
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing((v) => !v)}>
          {editing ? "Preview" : "Edit"}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onReject} className="ml-auto">
          Reject
        </Button>
      </div>
    </div>
  );
}
