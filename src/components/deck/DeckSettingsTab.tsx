"use client";

import { useState } from "react";
import { Button, ErrorNote, Field, Input, Textarea, cn, useToast } from "@/components/ui";
import { del, patchJson } from "@/lib/client";
import { DECK_COLORS, swatchClass } from "@/lib/colors";
import type { Deck } from "@/app/(app)/decks/[id]/page";

export function DeckSettingsTab({
  deck,
  onSaved,
  onDeleted,
}: {
  deck: Deck;
  onSaved: (deck: Deck) => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(deck.name);
  const [topic, setTopic] = useState(deck.topic);
  const [description, setDescription] = useState(deck.description);
  const [color, setColor] = useState(deck.color);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");

  const dirty =
    name !== deck.name ||
    topic !== deck.topic ||
    description !== deck.description ||
    color !== deck.color;

  const save = async () => {
    if (!name.trim()) {
      setError("The deck needs a name");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await patchJson<{ deck: Deck }>(`/api/decks/${deck.id}`, {
        name: name.trim(),
        topic: topic.trim(),
        description: description.trim(),
        color,
      });
      onSaved(res.deck);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const destroy = async () => {
    setDeleting(true);
    try {
      await del(`/api/decks/${deck.id}`);
      onDeleted();
    } catch (e) {
      toast((e as Error).message, "error");
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="card-surface space-y-4 p-4">
        <h2 className="text-sm font-semibold text-text">Deck details</h2>

        {error && <ErrorNote>{error}</ErrorNote>}

        <Field label="Name">
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>

        <Field
          label="Topic"
          hint="What this deck is about, as precisely as you can put it. This is what AI suggestions build on."
        >
          {(id) => (
            <Input
              id={id}
              value={topic}
              placeholder="Characters in Frank Herbert's Dune (1965)"
              onChange={(e) => setTopic(e.target.value)}
            />
          )}
        </Field>

        <Field label="Description">
          {(id) => (
            <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
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
                  color === c
                    ? "ring-2 ring-offset-2 ring-accent ring-offset-surface"
                    : "opacity-60 hover:opacity-100",
                )}
              />
            ))}
          </div>
        </div>

        <div className="flex justify-end">
          <Button variant="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
            Save changes
          </Button>
        </div>
      </section>

      <section className="card-surface space-y-3 border-bad/30 p-4">
        <div>
          <h2 className="text-sm font-semibold text-bad">Delete this deck</h2>
          <p className="mt-0.5 text-xs text-muted">
            Removes the deck, every card in it, and their review history. This cannot be undone —
            export the deck first if you might want it back.
          </p>
        </div>

        <Field label={`Type the deck name to confirm`}>
          {(id) => (
            <Input
              id={id}
              value={confirmText}
              placeholder={deck.name}
              onChange={(e) => setConfirmText(e.target.value)}
            />
          )}
        </Field>

        <div className="flex justify-end">
          <Button
            variant="danger"
            loading={deleting}
            disabled={confirmText.trim() !== deck.name}
            onClick={() => void destroy()}
          >
            Delete deck permanently
          </Button>
        </div>
      </section>
    </div>
  );
}
