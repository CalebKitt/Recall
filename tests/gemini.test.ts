import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { GeminiError, rewordPrompts } from "../src/lib/gemini.ts";

/**
 * The model fallback chain, with Gemini replaced by a scripted fetch.
 *
 * These pin down behaviour that depends on Google's capacity and model
 * lifecycle, neither of which a live test can reproduce on demand: an
 * overloaded model, a retired model, and a model that rejects the thinking
 * setting.
 */

const PRIMARY = "gemini-3.6-flash";
const FALLBACK = "gemini-3.5-flash-lite";

interface Call {
  model: string;
  body: { generationConfig: { thinkingConfig?: { thinkingLevel: string } } };
}

const realFetch = globalThis.fetch;
let calls: Call[];

/** Queue responses; each fetch consumes the next one. */
function script(...responses: Response[]) {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const model = decodeURIComponent(String(url).split("/models/")[1].split(":")[0]);
    calls.push({ model, body: JSON.parse(String(init?.body)) });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected extra Gemini call");
    return next;
  }) as typeof fetch;
}

const ok = (payload: unknown) =>
  new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
    { status: 200 },
  );

const fail = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), { status });

const reword = () =>
  rewordPrompts({ apiKey: "test-key", front: "What element has the symbol Na?", back: "Sodium", count: 2 });

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("Gemini model fallback", () => {
  it("uses the primary model with a low thinking level", async () => {
    script(ok({ variants: ["Which element does Na stand for?", "Na is the symbol of which element?"] }));

    const out = await reword();

    assert.equal(out.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, PRIMARY);
    assert.equal(calls[0].body.generationConfig.thinkingConfig?.thinkingLevel, "low");
  });

  it("falls back to the lite model when the primary is overloaded", async () => {
    script(
      fail(503, "This model is currently experiencing high demand."),
      ok({ variants: ["Name the element with symbol Na."] }),
    );

    const out = await reword();

    assert.deepEqual(out, ["Name the element with symbol Na."]);
    assert.deepEqual(calls.map((c) => c.model), [PRIMARY, FALLBACK]);
    // Lite models get no thinking setting; they default to minimal anyway.
    assert.equal(calls[1].body.generationConfig.thinkingConfig, undefined);
  });

  it("falls back when the primary is rate limited", async () => {
    script(fail(429, "Resource exhausted"), ok({ variants: ["Na is which element?"] }));

    await reword();
    assert.deepEqual(calls.map((c) => c.model), [PRIMARY, FALLBACK]);
  });

  it("falls back when the primary model has been retired", async () => {
    // The exact failure that prompted this: a 404 for a model withdrawn from new keys.
    script(
      fail(404, "This model models/gemini-2.5-flash is no longer available to new users."),
      ok({ variants: ["Na is which element?"] }),
    );

    const out = await reword();
    assert.equal(out.length, 1);
    assert.deepEqual(calls.map((c) => c.model), [PRIMARY, FALLBACK]);
  });

  it("retries without the thinking setting when a model rejects it", async () => {
    script(
      fail(400, "thinking_level is not supported for this model."),
      ok({ variants: ["Na is which element?"] }),
    );

    await reword();

    assert.deepEqual(calls.map((c) => c.model), [PRIMARY, PRIMARY]);
    assert.equal(calls[0].body.generationConfig.thinkingConfig?.thinkingLevel, "low");
    assert.equal(calls[1].body.generationConfig.thinkingConfig, undefined);
  });

  it("does not try another model when the API key is rejected", async () => {
    // A bad key fails identically on every model; falling back would only
    // double the wait before the user sees the real problem.
    script(fail(400, "API key not valid. Please pass a valid API key."));

    await assert.rejects(reword(), (err: unknown) => {
      assert.ok(err instanceof GeminiError);
      assert.equal(err.status, 400);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it("reports the last error when every model is unavailable", async () => {
    script(fail(503, "high demand"), fail(503, "high demand"));

    await assert.rejects(reword(), (err: unknown) => {
      assert.ok(err instanceof GeminiError);
      assert.equal(err.status, 503);
      return true;
    });
    assert.deepEqual(calls.map((c) => c.model), [PRIMARY, FALLBACK]);
  });
});

describe("rewording safeguards", () => {
  it("drops variants that leak the answer or repeat the original", async () => {
    script(
      ok({
        variants: [
          "Which element is Na? (Sodium)",
          "What element has the symbol Na?",
          "Identify the element whose symbol is Na.",
        ],
      }),
    );

    const out = await reword();
    assert.deepEqual(out, ["Identify the element whose symbol is Na."]);
  });
});
