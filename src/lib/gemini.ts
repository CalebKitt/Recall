/**
 * Gemini client, spoken over plain REST so there is no SDK to drift.
 *
 * Both entry points ({@link rewordPrompts}, {@link suggestCards}) ask for
 * structured JSON via `responseSchema`, which removes the usual "model wrapped
 * its answer in prose" failure mode.
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// Google retires model versions for new API keys, so keep the default in this
// one place; GEMINI_MODEL overrides it without a code change.
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
/**
 * Tried when the primary model is overloaded (503), rate limited (429), times
 * out, or has been retired (404). A lite model is used because it is fast and
 * is usually served from separate capacity, so it tends to be available when
 * the primary is not.
 */
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite";
const TIMEOUT_MS = 20_000;

export class GeminiError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
    this.retryable = retryable;
  }
}

/** JSON-Schema subset that Gemini's `responseSchema` accepts. */
type SchemaNode = {
  type: "OBJECT" | "ARRAY" | "STRING" | "NUMBER" | "BOOLEAN";
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: string[];
  description?: string;
};

interface GenerateOptions {
  apiKey: string;
  system: string;
  user: string;
  schema: SchemaNode;
  temperature?: number;
  model?: string;
  /**
   * Ask for a low thinking level. Rewording and card suggestions are simple
   * tasks, and a thinking model's default effort makes each call take many
   * seconds for no benefit here.
   */
  lowThinking?: boolean;
}

async function generateJson<T>({
  apiKey,
  system,
  user,
  schema,
  temperature = 1,
  model = DEFAULT_MODEL,
  lowThinking = false,
}: GenerateOptions): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Header auth keeps the key out of the URL (and out of any proxy logs).
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          temperature,
          responseMimeType: "application/json",
          responseSchema: schema,
          ...(lowThinking ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new GeminiError("Gemini request timed out", undefined, true);
    }
    throw new GeminiError(`Could not reach Gemini: ${(err as Error).message}`, undefined, true);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let detail = body.slice(0, 400);
    try {
      detail = JSON.parse(body)?.error?.message ?? detail;
    } catch {
      /* keep the raw snippet */
    }
    const retryable = res.status === 429 || res.status >= 500;
    const friendly =
      res.status === 400 || res.status === 403
        ? `Gemini rejected the API key or request (${res.status}): ${detail}`
        : `Gemini error ${res.status}: ${detail}`;
    throw new GeminiError(friendly, res.status, retryable);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };

  if (data.promptFeedback?.blockReason) {
    throw new GeminiError(`Gemini blocked the request (${data.promptFeedback.blockReason})`);
  }

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) {
    const reason = data.candidates?.[0]?.finishReason;
    throw new GeminiError(
      reason ? `Gemini returned no content (${reason})` : "Gemini returned an empty response",
      undefined,
      true,
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GeminiError("Gemini returned malformed JSON", undefined, true);
  }
}

/**
 * Try the primary model, then the fallback, moving on when a model is
 * unavailable rather than failing the request outright.
 *
 * - Overloaded, rate limited, timed out, or retired (404) -> next model.
 * - The model rejects the thinking setting (400 mentioning thinking) -> retry
 *   the same model without it, so a model that lacks the option still works.
 * - Anything else (bad key, blocked content) -> throw immediately; another
 *   model would fail the same way.
 */
async function generateWithFallback<T>(
  opts: Omit<GenerateOptions, "model" | "lowThinking"> & { model?: string },
): Promise<T> {
  const primary = opts.model ?? DEFAULT_MODEL;
  const models = [...new Set([primary, FALLBACK_MODEL])];
  let lastError: unknown;

  for (const model of models) {
    // Only the primary gets the thinking setting; lite models are fast anyway.
    let lowThinking = model === primary;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await generateJson<T>({ ...opts, model, lowThinking });
      } catch (err) {
        lastError = err;
        if (!(err instanceof GeminiError)) throw err;

        if (err.status === 400 && lowThinking && /thinking/i.test(err.message)) {
          lowThinking = false;
          continue; // Same model, without the thinking setting.
        }
        if (err.retryable || err.status === 404) break; // Next model.
        throw err;
      }
    }
  }

  throw lastError;
}

/* ------------------------------------------------------------------ *
 * Rewording
 * ------------------------------------------------------------------ */

const REWORD_SYSTEM = `You rewrite flashcard questions so a learner cannot pass by memorising the surface wording of the prompt.

Hard rules:
1. The correct answer must remain EXACTLY the same. Never change what is being asked for.
2. Never include the answer, or any distinctive part of it, in the question.
3. Keep the same difficulty. Do not add hints, and do not remove information the learner needs.
4. Vary sentence structure, framing, and vocabulary — not just one or two synonyms. Rephrase as a direct question, a fill-in-the-blank, a scenario, or a definition-to-term prompt where it fits naturally.
5. Preserve any technical term that IS the thing being tested.
6. Keep each variant under 200 characters and write in the same language as the original.

Return only the JSON described by the schema.`;

const REWORD_SCHEMA: SchemaNode = {
  type: "OBJECT",
  properties: {
    variants: {
      type: "ARRAY",
      description: "Reworded versions of the question.",
      items: { type: "STRING" },
    },
  },
  required: ["variants"],
};

export async function rewordPrompts(args: {
  apiKey: string;
  front: string;
  back: string;
  hint?: string;
  deckName?: string;
  count?: number;
  model?: string;
}): Promise<string[]> {
  const count = Math.min(Math.max(args.count ?? 3, 1), 6);
  const user = [
    args.deckName ? `Deck: ${args.deckName}` : null,
    `Question: ${args.front}`,
    `Answer (must stay correct, never reveal): ${args.back}`,
    args.hint ? `Extra context: ${args.hint}` : null,
    "",
    `Write ${count} distinct rewordings of the question.`,
  ]
    .filter(Boolean)
    .join("\n");

  const data = await generateWithFallback<{ variants: string[] }>({
    apiKey: args.apiKey,
    system: REWORD_SYSTEM,
    user,
    schema: REWORD_SCHEMA,
    temperature: 1.15,
    model: args.model,
  });

  const answer = args.back.trim().toLowerCase();
  return (data.variants ?? [])
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0 && v.length <= 400)
    // Guard rule 2 ourselves rather than trusting the model to obey it.
    .filter((v) => answer.length < 4 || !v.toLowerCase().includes(answer))
    .filter((v) => v.toLowerCase() !== args.front.trim().toLowerCase())
    .slice(0, count);
}

/* ------------------------------------------------------------------ *
 * Card suggestions
 * ------------------------------------------------------------------ */

const SUGGEST_SYSTEM = `You extend a flashcard deck with new cards that belong to the SAME subject as the existing ones, without repeating anything already covered.

Method:
1. Infer the deck's precise scope from the existing cards. Be specific: "characters in Dune", not "science fiction". If the cards are all characters from one book, suggest OTHER characters from THAT SAME book.
2. Propose cards that a learner studying this exact material would also need.
3. Do NOT restate, invert, or paraphrase any existing card. A new card must test a genuinely different fact.
4. Only assert things you are confident are true. If you are unsure of a fact, leave it out rather than guessing.
5. Match the existing cards' style, length, and language.
6. In "rationale", state in one short sentence why it fits the deck and what makes it distinct from the existing cards.

Return only the JSON described by the schema.`;

const SUGGEST_SCHEMA: SchemaNode = {
  type: "OBJECT",
  properties: {
    scope: {
      type: "STRING",
      description: "The specific subject you inferred for this deck.",
    },
    cards: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          front: { type: "STRING", description: "The question." },
          back: { type: "STRING", description: "The answer." },
          rationale: { type: "STRING", description: "Why it fits and how it differs." },
        },
        required: ["front", "back", "rationale"],
      },
    },
  },
  required: ["scope", "cards"],
};

export interface SuggestedCard {
  front: string;
  back: string;
  rationale: string;
}

export async function suggestCards(args: {
  apiKey: string;
  deckName: string;
  description?: string;
  topic?: string;
  existing: { front: string; back: string }[];
  /** Fronts previously rejected by the user; never suggest these again. */
  rejected?: string[];
  count?: number;
  model?: string;
}): Promise<{ scope: string; cards: SuggestedCard[] }> {
  const count = Math.min(Math.max(args.count ?? 8, 1), 20);

  // Cap the context so a 5,000-card deck cannot blow the request size.
  const sample = args.existing.slice(0, 120);
  const user = [
    `Deck name: ${args.deckName}`,
    args.topic ? `Stated topic: ${args.topic}` : null,
    args.description ? `Description: ${args.description}` : null,
    "",
    `Existing cards (${args.existing.length} total${
      args.existing.length > sample.length ? `, showing ${sample.length}` : ""
    }):`,
    sample.map((c, i) => `${i + 1}. Q: ${c.front} | A: ${c.back}`).join("\n") || "(none yet)",
    args.rejected?.length
      ? `\nAlready rejected by the user — do not suggest these or anything equivalent:\n${args.rejected
          .slice(0, 60)
          .map((r) => `- ${r}`)
          .join("\n")}`
      : null,
    "",
    `Suggest ${count} new cards.`,
  ]
    .filter(Boolean)
    .join("\n");

  const data = await generateWithFallback<{ scope: string; cards: SuggestedCard[] }>({
    apiKey: args.apiKey,
    system: SUGGEST_SYSTEM,
    user,
    schema: SUGGEST_SCHEMA,
    temperature: 1.0,
    model: args.model,
  });

  const cards = (data.cards ?? [])
    .filter((c) => c && typeof c.front === "string" && typeof c.back === "string")
    .map((c) => ({
      front: c.front.trim(),
      back: c.back.trim(),
      rationale: (c.rationale ?? "").trim(),
    }))
    .filter((c) => c.front && c.back)
    .slice(0, count);

  return { scope: (data.scope ?? "").trim(), cards };
}

/**
 * Check that a key works, when someone saves their own in Settings.
 *
 * Deliberately asks whether the key can list models at all, rather than probing
 * one model: a perfectly good key whose project lacks access to the current
 * default would otherwise be rejected on save, even though the fallback model
 * would have served it fine. The single-model probe stays as a backstop for
 * keys allowed to call a model but not to list them.
 */
export async function verifyApiKey(apiKey: string, model = DEFAULT_MODEL): Promise<boolean> {
  const headers = { "x-goog-api-key": apiKey };

  try {
    const listed = await fetch(`${API_BASE}?pageSize=1`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (listed.ok) return true;
    // 401/403 mean the key itself is bad; no other request will do better.
    if (listed.status === 401 || listed.status === 403) return false;
  } catch {
    // Network trouble: fall through and try the model probe before giving up.
  }

  const res = await fetch(`${API_BASE}/${encodeURIComponent(model)}`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  return res.ok;
}

export const geminiModel = DEFAULT_MODEL;
