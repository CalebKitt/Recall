// A valid 32-byte key, set before importing anything that reads it.
process.env.ENCRYPTION_KEY = "5".repeat(64);

import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createTestDb, makeUser, schema } from "./helpers/testDb.ts";
import { decryptSecret, encryptSecret, maskSecret } from "../src/lib/crypto.ts";
import { getSettings, resolveGeminiKey } from "../src/lib/settings.ts";
import type { Db } from "../src/lib/db/types.ts";

/**
 * Per-user Gemini keys.
 *
 * The app is multi-tenant, so these cover the properties that matter once
 * strangers are signing in: a key is unreadable at rest, a user's own key is
 * preferred over the shared server key, and one user's key is never handed to
 * another.
 */

let db: Db;
let close: () => Promise<void>;
const serverKeyBefore = process.env.GEMINI_API_KEY;

before(async () => {
  ({ db, close } = await createTestDb());
});

after(async () => {
  await close();
});

afterEach(() => {
  if (serverKeyBefore === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = serverKeyBefore;
});

describe("secret storage", () => {
  it("round-trips a key", () => {
    const secret = "AIzaSyExample-Key_1234567890";
    assert.equal(decryptSecret(encryptSecret(secret)), secret);
  });

  it("produces different ciphertext each time", () => {
    // A fresh nonce per encryption; identical keys must not look identical.
    const a = encryptSecret("same-key");
    const b = encryptSecret("same-key");
    assert.notEqual(a, b);
    assert.equal(decryptSecret(a), decryptSecret(b));
  });

  it("refuses tampered or malformed payloads instead of throwing", () => {
    const payload = encryptSecret("AIzaSecret");
    const [iv, ct, tag] = payload.split(":");
    assert.equal(decryptSecret(`${iv}:${ct}x:${tag}`), null, "tampered ciphertext");
    assert.equal(decryptSecret("garbage"), null);
    assert.equal(decryptSecret(""), null);
    assert.equal(decryptSecret(null), null);
  });

  it("masks a key for display without revealing the middle", () => {
    const masked = maskSecret("AIzaSyABCDEFGHIJKLMNOP");
    assert.ok(masked.startsWith("AIza"));
    assert.ok(masked.endsWith("MNOP"));
    assert.ok(!masked.includes("EFGHIJ"));
  });
});

describe("which key gets used", () => {
  it("uses the user's own key when they have one", async () => {
    process.env.GEMINI_API_KEY = "server-side-key";
    const userId = await makeUser(db);
    await db
      .update(schema.userSettings)
      .set({ geminiApiKey: encryptSecret("personal-key") })
      .where(eq(schema.userSettings.userId, userId));

    const resolved = await resolveGeminiKey(db, userId);
    assert.equal(resolved?.apiKey, "personal-key", "personal key must win");
    assert.equal(resolved?.source, "user");
  });

  it("falls back to the server key when the user has none", async () => {
    process.env.GEMINI_API_KEY = "server-side-key";
    const userId = await makeUser(db);

    const resolved = await resolveGeminiKey(db, userId);
    assert.equal(resolved?.apiKey, "server-side-key");
    assert.equal(resolved?.source, "server");
  });

  it("returns nothing when neither key exists", async () => {
    delete process.env.GEMINI_API_KEY;
    const userId = await makeUser(db);

    assert.equal(await resolveGeminiKey(db, userId), null);
  });

  it("never hands one user's key to another", async () => {
    delete process.env.GEMINI_API_KEY;
    const alice = await makeUser(db);
    const bob = await makeUser(db);

    await db
      .update(schema.userSettings)
      .set({ geminiApiKey: encryptSecret("alice-key") })
      .where(eq(schema.userSettings.userId, alice));

    assert.equal((await resolveGeminiKey(db, alice))?.apiKey, "alice-key");
    assert.equal(await resolveGeminiKey(db, bob), null, "Bob must not inherit Alice's key");
  });

  it("stores the key encrypted, not as plain text", async () => {
    const userId = await makeUser(db);
    await db
      .update(schema.userSettings)
      .set({ geminiApiKey: encryptSecret("AIzaPlainSecret") })
      .where(eq(schema.userSettings.userId, userId));

    const row = await getSettings(db, userId);
    assert.ok(row.geminiApiKey);
    assert.ok(!row.geminiApiKey.includes("AIzaPlainSecret"), "column must not hold the raw key");
    assert.equal(decryptSecret(row.geminiApiKey), "AIzaPlainSecret");
  });

  it("treats a cleared key as absent", async () => {
    delete process.env.GEMINI_API_KEY;
    const userId = await makeUser(db);
    await db
      .update(schema.userSettings)
      .set({ geminiApiKey: encryptSecret("temporary") })
      .where(eq(schema.userSettings.userId, userId));
    assert.ok(await resolveGeminiKey(db, userId));

    // What the "Remove key" button does.
    await db
      .update(schema.userSettings)
      .set({ geminiApiKey: null })
      .where(eq(schema.userSettings.userId, userId));

    assert.equal(await resolveGeminiKey(db, userId), null);
  });

  it("new users start with no key and AI rewording off", async () => {
    const userId = await makeUser(db);
    const settings = await getSettings(db, userId);
    assert.equal(settings.geminiApiKey, null);
    assert.equal(settings.aiRewordEnabled, false);
  });
});
