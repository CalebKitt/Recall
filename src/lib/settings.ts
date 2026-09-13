import { eq } from "drizzle-orm";
import type { Db } from "./db/types";
import { userSettings, type UserSettings } from "./db/schema";
import { decryptSecret } from "./crypto";

/** Read a user's settings, creating the default row on first access. */
export async function getSettings(db: Db, userId: string): Promise<UserSettings> {
  const existing = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  if (existing) return existing;

  const [created] = await db
    .insert(userSettings)
    .values({ userId })
    .onConflictDoNothing()
    .returning();

  if (created) return created;

  // Lost an insert race with a concurrent request; the row now exists.
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  if (!row) throw new Error("Could not create user settings");
  return row;
}

export type KeySource = "user" | "server";

export interface ResolvedKey {
  apiKey: string;
  source: KeySource;
}

/**
 * Pick the Gemini key to use: the user's own key wins, otherwise the shared
 * server key. Returns null when neither is available, which callers surface as
 * an actionable message rather than a crash.
 */
export async function resolveGeminiKey(db: Db, userId: string): Promise<ResolvedKey | null> {
  const settings = await getSettings(db, userId);
  const personal = decryptSecret(settings.geminiApiKey);
  if (personal) return { apiKey: personal, source: "user" };

  const server = process.env.GEMINI_API_KEY?.trim();
  if (server) return { apiKey: server, source: "server" };

  return null;
}

export function hasServerKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}
