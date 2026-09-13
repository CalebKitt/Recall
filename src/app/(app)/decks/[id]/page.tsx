"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, ErrorNote, Skeleton, cn, useToast } from "@/components/ui";
import { getJson } from "@/lib/client";
import { swatchClass } from "@/lib/colors";
import { CardsTab } from "@/components/deck/CardsTab";
import { SuggestionsTab } from "@/components/deck/SuggestionsTab";
import { TransferTab } from "@/components/deck/TransferTab";
import { DeckSettingsTab } from "@/components/deck/DeckSettingsTab";

export interface Deck {
  id: string;
  name: string;
  description: string;
  topic: string;
  color: string;
}

interface DeckResponse {
  deck: Deck;
  counts: { newCards: number; learning: number; review: number; total: number };
}

const TABS = [
  { id: "cards", label: "Cards" },
  { id: "suggestions", label: "AI suggestions" },
  { id: "transfer", label: "Import / Export" },
  { id: "settings", label: "Settings" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function DeckPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();

  const [data, setData] = useState<DeckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("cards");
  const [cardCount, setCardCount] = useState<number | null>(null);
  const [pendingSuggestions, setPendingSuggestions] = useState(0);

  const load = useCallback(() => {
    setError(null);
    getJson<DeckResponse>(`/api/decks/${id}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(load, [load]);

  // Suggestion count drives the tab badge, so keep it fresh alongside the deck.
  const refreshSuggestionCount = useCallback(() => {
    getJson<{ suggestions: unknown[] }>(`/api/decks/${id}/suggestions`)
      .then((r) => setPendingSuggestions(r.suggestions.length))
      .catch(() => {});
  }, [id]);

  useEffect(refreshSuggestionCount, [refreshSuggestionCount]);

  if (error) {
    return (
      <div className="space-y-4">
        <ErrorNote>{error}</ErrorNote>
        <Link href="/decks">
          <Button>Back to decks</Button>
        </Link>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const { deck, counts } = data;

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <Link href="/decks" className="text-sm text-muted hover:text-text">
          ← All decks
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className={cn("mt-2 size-3 shrink-0 rounded-full", swatchClass(deck.color))} aria-hidden="true" />
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold tracking-tight text-text sm:text-2xl">
                {deck.name}
              </h1>
              <p className="mt-0.5 text-sm text-muted">
                {cardCount !== null ? `${cardCount} card${cardCount === 1 ? "" : "s"}` : "…"}
                {counts.total > 0 && ` · ${counts.total} due now`}
              </p>
            </div>
          </div>

          <Link
            href={
              counts.total > 0
                ? `/study?deck=${deck.id}`
                : `/study?deck=${deck.id}&ahead=1`
            }
          >
            <Button variant="primary" disabled={cardCount === 0}>
              {counts.total > 0 ? `Study ${counts.total}` : "Review early"}
            </Button>
          </Link>
        </div>
      </div>

      {/* Tabs — horizontally scrollable on narrow screens */}
      <div className="no-scrollbar -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex w-max gap-1 border-b border-border pb-px sm:w-full">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "relative whitespace-nowrap rounded-t-lg px-3.5 py-2 text-sm font-medium transition",
                tab === t.id
                  ? "text-accent after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent"
                  : "text-muted hover:text-text",
              )}
            >
              {t.label}
              {t.id === "suggestions" && pendingSuggestions > 0 && (
                <Badge tone="accent" className="ml-1.5">
                  {pendingSuggestions}
                </Badge>
              )}
            </button>
          ))}
        </div>
      </div>

      {tab === "cards" && (
        <CardsTab deckId={deck.id} onCountChange={setCardCount} onChanged={load} />
      )}

      {tab === "suggestions" && (
        <SuggestionsTab
          deck={deck}
          onAccepted={() => {
            load();
            refreshSuggestionCount();
            setCardCount((c) => (c === null ? c : c + 1));
          }}
          onCountChange={setPendingSuggestions}
        />
      )}

      {tab === "transfer" && (
        <TransferTab
          deck={deck}
          onImported={() => {
            load();
            setTab("cards");
          }}
        />
      )}

      {tab === "settings" && (
        <DeckSettingsTab
          deck={deck}
          onSaved={(updated) => {
            setData((d) => (d ? { ...d, deck: updated } : d));
            toast("Deck updated", "success");
          }}
          onDeleted={() => {
            toast(`Deleted “${deck.name}”`, "success");
            router.push("/decks");
          }}
        />
      )}
    </div>
  );
}
