import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { UnauthorizedError } from "./auth";
import { GeminiError } from "./gemini";
import { HttpError } from "./errors";

export { HttpError, badRequest, notFound, conflict } from "./errors";

/**
 * Wrap a route handler so every error becomes a predictable JSON response.
 * Unexpected errors are logged server-side and reported generically, so
 * internals never leak to the client.
 */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse | Response>,
) {
  return async (...args: Args): Promise<NextResponse | Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        return NextResponse.json({ error: "Not signed in" }, { status: 401 });
      }
      if (err instanceof HttpError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      if (err instanceof ZodError) {
        const first = err.errors[0];
        const path = first?.path.join(".");
        return NextResponse.json(
          { error: path ? `${path}: ${first.message}` : (first?.message ?? "Invalid request") },
          { status: 400 },
        );
      }
      if (err instanceof GeminiError) {
        // Surface the model's own message: it is usually actionable
        // ("API key not valid", "quota exceeded").
        return NextResponse.json({ error: err.message }, { status: 502 });
      }

      console.error("[api] unhandled error:", err);
      const message =
        err instanceof Error && /ENCRYPTION_KEY|DATABASE_URL/.test(err.message)
          ? err.message // Config errors are for the operator; show them plainly.
          : "Something went wrong on our end.";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  };
}

export function json<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}
