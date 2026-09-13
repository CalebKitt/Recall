"use client";

import { useEffect, useState } from "react";
import {
  Button,
  ErrorNote,
  Field,
  Input,
  Skeleton,
  Toggle,
  useToast,
} from "@/components/ui";
import { browserTimeZone, getJson, patchJson } from "@/lib/client";

interface Settings {
  aiRewordEnabled: boolean;
  timezone: string;
  newCardsPerDay: number;
  maxReviewsPerDay: number;
  hasPersonalKey: boolean;
  personalKeyPreview: string | null;
  hasServerKey: boolean;
  aiAvailable: boolean;
}

export default function SettingsPage() {
  const toast = useToast();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);

  useEffect(() => {
    getJson<{ settings: Settings }>("/api/settings")
      .then((r) => setSettings(r.settings))
      .catch((e) => setError(e.message));
  }, []);

  /** Optimistic patch — revert and report if the server refuses. */
  const update = async (patch: Partial<Settings>, successMessage?: string) => {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, ...patch });
    try {
      const res = await patchJson<{ settings: Settings }>("/api/settings", patch);
      setSettings(res.settings);
      if (successMessage) toast(successMessage, "success");
    } catch (e) {
      setSettings(previous);
      toast((e as Error).message, "error");
    }
  };

  const saveKey = async () => {
    setSavingKey(true);
    setKeyError(null);
    try {
      const res = await patchJson<{ settings: Settings }>("/api/settings", {
        geminiApiKey: keyInput.trim(),
      });
      setSettings(res.settings);
      setKeyInput("");
      toast(keyInput.trim() ? "API key saved and verified" : "API key removed", "success");
    } catch (e) {
      setKeyError((e as Error).message);
    } finally {
      setSavingKey(false);
    }
  };

  if (error) return <ErrorNote>{error}</ErrorNote>;

  if (!settings) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-40" />
        <Skeleton className="h-52" />
      </div>
    );
  }

  const browserTz = browserTimeZone();

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold tracking-tight text-text sm:text-2xl">Settings</h1>

      {/* ---------------- AI ---------------- */}
      <section className="card-surface space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold text-text">AI rewording</h2>
          <p className="mt-0.5 text-xs text-muted">
            When this is on, each question is rephrased before it&apos;s shown, so you recall the
            material rather than pattern-matching a familiar sentence. The answer never changes.
          </p>
        </div>

        <Toggle
          checked={settings.aiRewordEnabled}
          disabled={!settings.aiAvailable}
          onChange={(v) => void update({ aiRewordEnabled: v }, v ? "AI rewording on" : "AI rewording off")}
          label="Reword questions during study"
          description={
            settings.aiAvailable
              ? "Variations are generated in batches and cached, so studying stays fast."
              : "Add a Gemini API key below to enable this."
          }
        />

        {settings.aiRewordEnabled && settings.aiAvailable && (
          <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
            During study you&apos;ll see a{" "}
            <span className="font-semibold text-accent">✦ reworded</span> tag on rephrased questions.
            Tap it to compare against the original wording.
          </p>
        )}
      </section>

      {/* ---------------- API key ---------------- */}
      <section className="card-surface space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold text-text">Gemini API key</h2>
          <p className="mt-0.5 text-xs text-muted">
            Used for rewording and card suggestions. Get a free key at{" "}
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent underline underline-offset-2"
            >
              aistudio.google.com/apikey
            </a>
            . It&apos;s encrypted before being stored and is never shown again after saving.
          </p>
        </div>

        <div className="rounded-lg bg-surface-2 px-3 py-2.5 text-xs">
          {settings.hasPersonalKey ? (
            <p className="text-text">
              Using your personal key{" "}
              <code className="rounded bg-surface px-1.5 py-0.5">{settings.personalKeyPreview}</code>
            </p>
          ) : settings.hasServerKey ? (
            <p className="text-muted">
              Using the server&apos;s shared key. Add your own below to use your own quota instead.
            </p>
          ) : (
            <p className="text-muted">
              No key configured — AI features are unavailable until you add one.
            </p>
          )}
        </div>

        {keyError && <ErrorNote>{keyError}</ErrorNote>}

        <Field
          label={settings.hasPersonalKey ? "Replace your key" : "Add your key"}
          hint="The key is checked against Gemini before it's saved."
        >
          {(id) => (
            <Input
              id={id}
              type="password"
              value={keyInput}
              autoComplete="off"
              placeholder="AIza…"
              onChange={(e) => setKeyInput(e.target.value)}
            />
          )}
        </Field>

        <div className="flex flex-wrap justify-end gap-2">
          {settings.hasPersonalKey && (
            <Button
              variant="ghost"
              onClick={() => {
                if (confirm("Remove your personal Gemini key?")) {
                  setKeyInput("");
                  void patchJson<{ settings: Settings }>("/api/settings", { geminiApiKey: "" })
                    .then((r) => {
                      setSettings(r.settings);
                      toast("API key removed", "success");
                    })
                    .catch((e) => toast((e as Error).message, "error"));
                }
              }}
            >
              Remove key
            </Button>
          )}
          <Button variant="primary" loading={savingKey} disabled={!keyInput.trim()} onClick={() => void saveKey()}>
            Save key
          </Button>
        </div>
      </section>

      {/* ---------------- Study limits ---------------- */}
      <section className="card-surface space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold text-text">Daily limits</h2>
          <p className="mt-0.5 text-xs text-muted">
            Caps apply per deck, per day. They keep a big import from turning into an unmanageable
            queue.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <NumberSetting
            label="New cards per day"
            hint="How many unseen cards to introduce."
            value={settings.newCardsPerDay}
            min={0}
            max={9999}
            onSave={(v) => void update({ newCardsPerDay: v }, "Limit updated")}
          />
          <NumberSetting
            label="Maximum reviews per day"
            hint="0 means no limit."
            value={settings.maxReviewsPerDay}
            min={0}
            max={99999}
            onSave={(v) => void update({ maxReviewsPerDay: v }, "Limit updated")}
          />
        </div>
      </section>

      {/* ---------------- Timezone ---------------- */}
      <section className="card-surface space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold text-text">Timezone</h2>
          <p className="mt-0.5 text-xs text-muted">
            Decides when your day rolls over — which is what streaks and daily limits are counted
            against.
          </p>
        </div>

        <Field label="Your timezone">
          {(id) => (
            <Input
              id={id}
              value={settings.timezone}
              onChange={(e) => setSettings({ ...settings, timezone: e.target.value })}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== settings.timezone) void update({ timezone: v }, "Timezone updated");
              }}
            />
          )}
        </Field>

        {settings.timezone !== browserTz && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-warn-soft px-3 py-2.5">
            <p className="text-xs text-warn">
              This device reports <strong>{browserTz}</strong>.
            </p>
            <Button size="sm" onClick={() => void update({ timezone: browserTz }, "Timezone updated")}>
              Use {browserTz}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

/** Number input that only commits on blur or Enter, so partial typing is safe. */
function NumberSetting({
  label,
  hint,
  value,
  min,
  max,
  onSave,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onSave: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(Math.max(Math.trunc(n), min), max);
    setDraft(String(clamped));
    if (clamped !== value) onSave(clamped);
  };

  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      )}
    </Field>
  );
}
