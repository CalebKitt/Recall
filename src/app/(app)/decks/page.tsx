"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Modal,
  Skeleton,
  Textarea,
  cn,
  useToast,
} from "@/components/ui";
import { DECK_COLORS, stripeClass, swatchClass } from "@/lib/colors";
import { getJson, postJson } from "@/lib/client";

interface DeckRow {
  id: string;
  name: string;
  description: string;
  topic: string;
  color: string;
  cardCount: number;
  counts: { newCards: number; learning: number; review: number; total: number };
}

export default function DecksPage() {
  const toast = useToast();
  const [decks, setDecks] = useState<DeckRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    setError(null);
    getJson<{ decks: DeckRow[] }>("/api/decks")
      .then((d) => setDecks(d.decks))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  const totalDue = decks?.reduce((sum, d) => sum + d.counts.total, 0) ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-text sm:text-2xl">Your decks</h1>
          <p className="mt-0.5 text-sm text-muted">
            {decks === null
              ? "Loading…"
              : totalDue > 0
                ? `${totalDue} card${totalDue === 1 ? "" : "s"} ready to review`
                : decks.length > 0
                  ? "You're all caught up for today"
                  : "Create a deck to get started"}
          </p>
        </div>

        <div className="flex gap-2">
          {totalDue > 0 && (
            <Link href="/study">
              <Button variant="primary">Study all</Button>
            </Link>
          )}
          <Button variant={totalDue > 0 ? "secondary" : "primary"} onClick={() => setCreating(true)}>
            New deck
          </Button>
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {decks === null ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : decks.length === 0 ? (
        <EmptyState
          icon="▤"
          title="No decks yet"
          description="Create your first deck, then add cards by hand, import a CSV, or let AI suggest some."
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              Create a deck
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {decks.map((deck) => (
            <DeckCard key={deck.id} deck={deck} />
          ))}
        </div>
      )}

      <CreateDeckModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(deck) => {
          setCreating(false);
          toast(`Created “${deck.name}”`, "success");
          load();
        }}
      />
    </div>
  );
}

function DeckCard({ deck }: { deck: DeckRow }) {
  const { newCards, learning, review, total } = deck.counts;

  return (
    <div className="card-surface relative overflow-hidden">
      <div
        className={cn("absolute inset-x-0 top-0 h-1 bg-gradient-to-r to-transparent", stripeClass(deck.color))}
        aria-hidden="true"
      />
      <div className="flex h-full flex-col gap-3 p-4 pt-5">
        <div className="flex items-start gap-2.5">
          <span className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", swatchClass(deck.color))} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <Link href={`/decks/${deck.id}`} className="block truncate font-semibold text-text hover:text-accent">
              {deck.name}
            </Link>
            <p className="mt-0.5 line-clamp-2 text-xs text-muted">
              {deck.description || deck.topic || `${deck.cardCount} card${deck.cardCount === 1 ? "" : "s"}`}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {newCards > 0 && <Badge tone="accent">{newCards} new</Badge>}
          {learning > 0 && <Badge tone="warn">{learning} learning</Badge>}
          {review > 0 && <Badge tone="good">{review} due</Badge>}
          {total === 0 && <Badge tone="muted">Caught up</Badge>}
          <span className="ml-auto text-[11px] text-muted tabular-nums">{deck.cardCount} cards</span>
        </div>

        <div className="mt-auto flex gap-2 pt-1">
          <Button
            variant={total > 0 ? "primary" : "secondary"}
            size="sm"
            className="flex-1"
            disabled={deck.cardCount === 0}
            onClick={() =>
              (window.location.href =
                total > 0 ? `/study?deck=${deck.id}` : `/study?deck=${deck.id}&ahead=1`)
            }
          >
            {total > 0 ? `Study ${total}` : "Review early"}
          </Button>
          <Link href={`/decks/${deck.id}`} className="flex-1">
            <Button variant="secondary" size="sm" className="w-full">
              Edit
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

function CreateDeckModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (deck: DeckRow) => void;
}) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<string>("indigo");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setTopic("");
      setDescription("");
      setColor(DECK_COLORS[Math.floor(Math.random() * DECK_COLORS.length)]);
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim()) {
      setError("Give the deck a name");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await postJson<{ deck: DeckRow }>("/api/decks", {
        name: name.trim(),
        topic: topic.trim(),
        description: description.trim(),
        color,
      });
      onCreated(res.deck);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New deck">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {error && <ErrorNote>{error}</ErrorNote>}

        <Field label="Name">
          {(id) => (
            <Input
              id={id}
              value={name}
              autoFocus
              placeholder="Characters in Dune"
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>

        <Field
          label="Topic"
          hint="Optional, but it makes AI card suggestions far more precise. Be specific."
        >
          {(id) => (
            <Input
              id={id}
              value={topic}
              placeholder="Major and minor characters from Frank Herbert's Dune (1965)"
              onChange={(e) => setTopic(e.target.value)}
            />
          )}
        </Field>

        <Field label="Description" hint="Optional note for yourself.">
          {(id) => (
            <Textarea
              id={id}
              value={description}
              rows={2}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>

        <div className="space-y-1.5">
          <span className="block text-[13px] font-medium text-text">Colour</span>
          <div className="flex flex-wrap gap-2">
            {DECK_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={cn(
                  "size-7 rounded-full transition",
                  swatchClass(c),
                  color === c ? "ring-2 ring-offset-2 ring-accent ring-offset-surface" : "opacity-60 hover:opacity-100",
                )}
              />
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving}>
            Create deck
          </Button>
        </div>
      </form>
    </Modal>
  );
}
