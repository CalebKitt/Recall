"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { accuracyTone, del, formatPct, getJson, patchJson, postJson, relativeTime } from "@/lib/client";

interface CardRow {
  id: string;
  front: string;
  back: string;
  hint: string;
  tags: string[];
  state: "new" | "learning" | "review" | "relearning";
  dueAt: string;
  intervalDays: number;
  ease: number;
  lapses: number;
  totalReviews: number;
  correctReviews: number;
  suspended: boolean;
}

type Sort = "created" | "due" | "accuracy" | "lapses";

const SORTS: { id: Sort; label: string }[] = [
  { id: "created", label: "Added" },
  { id: "due", label: "Due" },
  { id: "accuracy", label: "Weakest" },
  { id: "lapses", label: "Most lapses" },
];

export function CardsTab({
  deckId,
  onCountChange,
  onChanged,
}: {
  deckId: string;
  onCountChange: (n: number) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [cards, setCards] = useState<CardRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("created");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CardRow | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ sort });
      if (query.trim()) params.set("q", query.trim());
      const res = await getJson<{ cards: CardRow[]; total: number }>(
        `/api/decks/${deckId}/cards?${params}`,
      );
      setCards(res.cards);
      setTotal(res.total);
      // Report the unfiltered size, not the search result count.
      if (!query.trim()) onCountChange(res.total);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [deckId, query, sort, onCountChange]);

  // Debounce so typing in the search box does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void load(), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  const remove = async (card: CardRow) => {
    if (!confirm(`Delete this card?\n\n${card.front}`)) return;
    try {
      await del(`/api/cards/${card.id}`);
      toast("Card deleted", "success");
      void load();
      onChanged();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const toggleSuspend = async (card: CardRow) => {
    try {
      await patchJson(`/api/cards/${card.id}`, { suspended: !card.suspended });
      toast(card.suspended ? "Card resumed" : "Card suspended", "success");
      void load();
      onChanged();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          placeholder="Search cards…"
          onChange={(e) => setQuery(e.target.value)}
          className="w-full sm:max-w-xs"
        />

        <div className="no-scrollbar flex gap-1 overflow-x-auto">
          {SORTS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSort(s.id)}
              className={cn(
                "whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium transition",
                sort === s.id ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted hover:text-text",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        <Button variant="primary" size="sm" className="ml-auto" onClick={() => setAdding(true)}>
          Add card
        </Button>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {cards === null ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : cards.length === 0 ? (
        <EmptyState
          icon="▤"
          title={query ? "No matches" : "No cards yet"}
          description={
            query
              ? "Nothing in this deck matches that search."
              : "Add a card by hand, import a CSV, or let AI suggest some from the tabs above."
          }
          action={
            !query ? (
              <Button variant="primary" onClick={() => setAdding(true)}>
                Add your first card
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="space-y-2">
            {cards.map((card) => (
              <CardRowItem
                key={card.id}
                card={card}
                onEdit={() => setEditing(card)}
                onDelete={() => void remove(card)}
                onToggleSuspend={() => void toggleSuspend(card)}
              />
            ))}
          </div>

          {cards.length < total && (
            <p className="text-center text-xs text-muted">
              Showing {cards.length} of {total}. Refine your search to narrow the list.
            </p>
          )}
        </>
      )}

      <CardEditorModal
        deckId={deckId}
        open={adding}
        onClose={() => setAdding(false)}
        onSaved={() => {
          void load();
          onChanged();
        }}
      />

      <CardEditorModal
        deckId={deckId}
        card={editing ?? undefined}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
          onChanged();
        }}
      />
    </div>
  );
}

function CardRowItem({
  card,
  onEdit,
  onDelete,
  onToggleSuspend,
}: {
  card: CardRow;
  onEdit: () => void;
  onDelete: () => void;
  onToggleSuspend: () => void;
}) {
  const accuracy = card.totalReviews > 0 ? card.correctReviews / card.totalReviews : null;
  const tone = accuracyTone(accuracy);

  return (
    <div className={cn("card-surface p-3.5", card.suspended && "opacity-60")}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="line-clamp-2 text-sm font-medium text-text">{card.front}</p>
          <p className="line-clamp-2 text-sm text-muted">{card.back}</p>

          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {card.suspended && <Badge tone="bad">Suspended</Badge>}
            {card.state === "new" ? (
              <Badge tone="accent">New</Badge>
            ) : (
              <Badge tone="muted">due {relativeTime(card.dueAt)}</Badge>
            )}
            {card.totalReviews > 0 && (
              <Badge tone={tone === "muted" ? "muted" : tone}>
                {formatPct(accuracy)} · {card.totalReviews}
              </Badge>
            )}
            {card.lapses > 0 && <Badge tone="warn">{card.lapses} lapses</Badge>}
            {card.tags.map((t) => (
              <Badge key={t} tone="muted">
                #{t}
              </Badge>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
          <Button variant="ghost" size="sm" onClick={onEdit} aria-label="Edit card">
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleSuspend}
            aria-label={card.suspended ? "Resume card" : "Suspend card"}
            title={card.suspended ? "Put this card back in rotation" : "Stop showing this card"}
          >
            {card.suspended ? "Resume" : "Pause"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDelete} aria-label="Delete card" className="text-bad">
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

function CardEditorModal({
  deckId,
  card,
  open,
  onClose,
  onSaved,
}: {
  deckId: string;
  card?: CardRow;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [front, setFront] = useState("");
  const [back, setBack] = useState("");
  const [hint, setHint] = useState("");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addAnother, setAddAnother] = useState(true);
  const frontRef = useRef<HTMLTextAreaElement>(null);

  const isEdit = Boolean(card);

  useEffect(() => {
    if (!open) return;
    setFront(card?.front ?? "");
    setBack(card?.back ?? "");
    setHint(card?.hint ?? "");
    setTags(card?.tags.join(" ") ?? "");
    setError(null);
  }, [open, card]);

  const parsedTags = useMemo(
    () => tags.split(/[\s,]+/).map((t) => t.replace(/^#/, "").trim()).filter(Boolean).slice(0, 20),
    [tags],
  );

  const save = async () => {
    if (!front.trim() || !back.trim()) {
      setError("Both the question and the answer are required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = { front: front.trim(), back: back.trim(), hint: hint.trim(), tags: parsedTags };
      if (isEdit && card) {
        await patchJson(`/api/cards/${card.id}`, payload);
        toast("Card updated", "success");
        onSaved();
        onClose();
      } else {
        await postJson(`/api/decks/${deckId}/cards`, payload);
        toast("Card added", "success");
        onSaved();
        if (addAnother) {
          // Keep tags so a run of related cards is quick to enter.
          setFront("");
          setBack("");
          setHint("");
          frontRef.current?.focus();
        } else {
          onClose();
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? "Edit card" : "Add card"}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {error && <ErrorNote>{error}</ErrorNote>}

        <Field label="Question (front)">
          {(id) => (
            <Textarea
              id={id}
              ref={frontRef}
              value={front}
              rows={2}
              autoFocus
              placeholder="Who is the Emperor's Truthsayer?"
              onChange={(e) => setFront(e.target.value)}
              onKeyDown={(e) => {
                // Ctrl/Cmd+Enter saves from anywhere in the form.
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void save();
                }
              }}
            />
          )}
        </Field>

        <Field label="Answer (back)">
          {(id) => (
            <Textarea
              id={id}
              value={back}
              rows={2}
              placeholder="Gaius Helen Mohiam"
              onChange={(e) => setBack(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void save();
                }
              }}
            />
          )}
        </Field>

        <Field label="Hint" hint="Optional. Shown with the answer, and used as context for AI rewording.">
          {(id) => <Input id={id} value={hint} onChange={(e) => setHint(e.target.value)} />}
        </Field>

        <Field label="Tags" hint="Space or comma separated.">
          {(id) => (
            <Input id={id} value={tags} placeholder="bene-gesserit house-atreides" onChange={(e) => setTags(e.target.value)} />
          )}
        </Field>

        <div className="flex flex-wrap items-center justify-end gap-3 pt-1">
          {!isEdit && (
            <label className="mr-auto flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={addAnother}
                onChange={(e) => setAddAnother(e.target.checked)}
                className="size-3.5 accent-[var(--accent)]"
              />
              Keep adding
            </label>
          )}
          <Button type="button" variant="ghost" onClick={onClose}>
            {isEdit ? "Cancel" : "Done"}
          </Button>
          <Button type="submit" variant="primary" loading={saving}>
            {isEdit ? "Save changes" : "Add card"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
