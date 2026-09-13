"use client";

import { useRef, useState } from "react";
import { Button, ErrorNote, Textarea, Toggle, cn, useToast } from "@/components/ui";
import { api } from "@/lib/client";
import type { Deck } from "@/app/(app)/decks/[id]/page";

interface ImportResult {
  imported: number;
  duplicates: number;
  replaced: number;
  skipped: { line: number; reason: string }[];
  delimiter: string;
  hadHeader: boolean;
  keptScheduling: boolean;
}

export function TransferTab({ deck, onImported }: { deck: Deck; onImported: () => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [pasted, setPasted] = useState("");
  const [replace, setReplace] = useState(false);
  const [keepScheduling, setKeepScheduling] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragging, setDragging] = useState(false);

  const [exportScheduling, setExportScheduling] = useState(true);
  const [exportTsv, setExportTsv] = useState(false);

  const importQuery = () => {
    const p = new URLSearchParams();
    if (replace) p.set("mode", "replace");
    if (!keepScheduling) p.set("scheduling", "0");
    return p.toString() ? `?${p}` : "";
  };

  const runImport = async (body: BodyInit, isFile: boolean) => {
    if (replace && !confirm(`Replace every card in “${deck.name}”? This cannot be undone.`)) return;

    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api<ImportResult>(`/api/decks/${deck.id}/import${importQuery()}`, {
        method: "POST",
        body,
        headers: isFile ? undefined : { "content-type": "text/csv" },
      });
      setResult(res);
      if (res.imported > 0) {
        toast(`Imported ${res.imported} card${res.imported === 1 ? "" : "s"}`, "success");
        onImported();
      } else {
        toast("Nothing new was imported", "info");
      }
      setPasted("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const importFile = (file: File) => {
    const form = new FormData();
    form.append("file", file);
    void runImport(form, true);
  };

  const exportUrl = `/api/decks/${deck.id}/export?${new URLSearchParams({
    ...(exportScheduling ? {} : { scheduling: "0" }),
    ...(exportTsv ? { format: "tsv" } : {}),
  })}`;

  return (
    <div className="space-y-4">
      {/* ---------------- Import ---------------- */}
      <section className="card-surface space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold text-text">Import cards</h2>
          <p className="mt-0.5 text-xs text-muted">
            CSV or TSV. The delimiter and column names are detected automatically — a header row of{" "}
            <code className="rounded bg-surface-2 px-1 py-0.5">front,back</code> works, and so do{" "}
            <code className="rounded bg-surface-2 px-1 py-0.5">Question/Answer</code> or{" "}
            <code className="rounded bg-surface-2 px-1 py-0.5">Term/Definition</code>. With no header,
            the first two columns are used.
          </p>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) importFile(file);
          }}
          className={cn(
            "flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition",
            dragging ? "border-accent bg-accent-soft" : "border-border",
          )}
        >
          <span className="text-2xl opacity-40" aria-hidden="true">
            ↥
          </span>
          <p className="text-sm text-muted">Drop a .csv or .tsv file here</p>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importFile(file);
            }}
          />
          <Button size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            Choose a file
          </Button>
        </div>

        <div className="space-y-2">
          <label className="block text-[13px] font-medium text-text">…or paste rows directly</label>
          <Textarea
            value={pasted}
            rows={4}
            disabled={busy}
            placeholder={"front,back\nWho is Paul Atreides?,The heir to House Atreides\nWho is Duncan Idaho?,Swordmaster of House Atreides"}
            onChange={(e) => setPasted(e.target.value)}
            className="font-mono text-xs"
          />
          <Button
            size="sm"
            disabled={busy || !pasted.trim()}
            loading={busy && Boolean(pasted.trim())}
            onClick={() => void runImport(pasted, false)}
          >
            Import pasted rows
          </Button>
        </div>

        <div className="space-y-3 border-t border-border pt-3">
          <Toggle
            checked={keepScheduling}
            onChange={setKeepScheduling}
            label="Keep scheduling data if present"
            description="Restores due dates and ease from a file this app exported. Turn off to import everything as brand-new cards."
          />
          <Toggle
            checked={replace}
            onChange={setReplace}
            label="Replace the deck"
            description="Deletes every existing card in this deck before importing. You'll be asked to confirm."
          />
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}

        {result && (
          <div className="space-y-1.5 rounded-lg bg-surface-2 px-3.5 py-3 text-xs">
            <p className="font-medium text-text">
              Imported {result.imported} card{result.imported === 1 ? "" : "s"}
              {result.replaced > 0 && ` · replaced ${result.replaced}`}
            </p>
            {result.duplicates > 0 && (
              <p className="text-muted">{result.duplicates} skipped as duplicates of existing cards.</p>
            )}
            {result.skipped.length > 0 && (
              <p className="text-muted">
                {result.skipped.length} row{result.skipped.length === 1 ? "" : "s"} skipped (
                {result.skipped
                  .slice(0, 3)
                  .map((s) => `line ${s.line}: ${s.reason}`)
                  .join("; ")}
                {result.skipped.length > 3 ? "…" : ""}).
              </p>
            )}
            <p className="text-muted">
              Read as {result.delimiter === "tab" ? "tab-separated" : `“${result.delimiter}”-separated`}
              {result.hadHeader ? " with a header row" : " with no header row"}
              {result.keptScheduling ? ", scheduling preserved" : ""}.
            </p>
          </div>
        )}
      </section>

      {/* ---------------- Export ---------------- */}
      <section className="card-surface space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold text-text">Export deck</h2>
          <p className="mt-0.5 text-xs text-muted">
            Downloads every card in this deck. With scheduling included, the file is a full backup —
            re-importing it restores your progress exactly.
          </p>
        </div>

        <div className="space-y-3">
          <Toggle
            checked={exportScheduling}
            onChange={setExportScheduling}
            label="Include scheduling and accuracy"
            description="Turn off for a clean question/answer file to share with someone else."
          />
          <Toggle
            checked={exportTsv}
            onChange={setExportTsv}
            label="Tab-separated (.tsv)"
            description="Use this if you're importing into Anki."
          />
        </div>

        <a href={exportUrl} download>
          <Button variant="primary" size="sm">
            Download {exportTsv ? ".tsv" : ".csv"}
          </Button>
        </a>
      </section>
    </div>
  );
}
