import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { userSettings } from "@/lib/db/schema";
import { requireUserId } from "@/lib/auth";
import { badRequest, json, route } from "@/lib/api";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { getSettings, hasServerKey } from "@/lib/settings";
import { isValidTimeZone } from "@/lib/time";
import { verifyApiKey } from "@/lib/gemini";

export const dynamic = "force-dynamic";

const patchBody = z.object({
  aiRewordEnabled: z.boolean().optional(),
  timezone: z.string().trim().max(64).optional(),
  newCardsPerDay: z.number().int().min(0).max(9999).optional(),
  maxReviewsPerDay: z.number().int().min(0).max(99999).optional(),
  /** Empty string clears the stored key; omit the field to leave it unchanged. */
  geminiApiKey: z.string().trim().max(500).optional(),
});

/** Settings never expose the stored key — only a masked preview of it. */
function present(row: Awaited<ReturnType<typeof getSettings>>) {
  const key = decryptSecret(row.geminiApiKey);
  return {
    aiRewordEnabled: row.aiRewordEnabled,
    timezone: row.timezone,
    newCardsPerDay: row.newCardsPerDay,
    maxReviewsPerDay: row.maxReviewsPerDay,
    hasPersonalKey: Boolean(key),
    personalKeyPreview: key ? maskSecret(key) : null,
    hasServerKey: hasServerKey(),
    aiAvailable: Boolean(key) || hasServerKey(),
  };
}

export const GET = route(async () => {
  const userId = await requireUserId();
  return json({ settings: present(await getSettings(db, userId)) });
});

export const PATCH = route(async (req: Request) => {
  const userId = await requireUserId();
  await getSettings(db, userId); // Ensure the row exists before updating it.

  const input = patchBody.parse(await req.json());
  const patch: Partial<typeof userSettings.$inferInsert> = { updatedAt: new Date() };

  if (input.aiRewordEnabled !== undefined) patch.aiRewordEnabled = input.aiRewordEnabled;
  if (input.newCardsPerDay !== undefined) patch.newCardsPerDay = input.newCardsPerDay;
  if (input.maxReviewsPerDay !== undefined) patch.maxReviewsPerDay = input.maxReviewsPerDay;

  if (input.timezone !== undefined) {
    if (!isValidTimeZone(input.timezone)) throw badRequest(`Unknown timezone: ${input.timezone}`);
    patch.timezone = input.timezone;
  }

  if (input.geminiApiKey !== undefined) {
    if (input.geminiApiKey === "") {
      patch.geminiApiKey = null;
    } else {
      // Verify before storing so a typo is caught here, not mid-review.
      const valid = await verifyApiKey(input.geminiApiKey).catch(() => false);
      if (!valid) {
        throw badRequest("Gemini rejected that API key. Check it and try again.");
      }
      patch.geminiApiKey = encryptSecret(input.geminiApiKey);
    }
  }

  const [row] = await db
    .update(userSettings)
    .set(patch)
    .where(eq(userSettings.userId, userId))
    .returning();

  return json({ settings: present(row) });
});
