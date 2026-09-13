import { redirect } from "next/navigation";
import { auth, enabledProviders } from "@/lib/auth";
import { SignInButtons } from "./SignInButtons";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  OAuthAccountNotLinked:
    "That email is already registered with a different sign-in provider. Use the one you signed up with.",
  AccessDenied: "Sign-in was cancelled or access was denied.",
  Configuration:
    "Sign-in is not configured correctly. Check the provider credentials in your environment file.",
  Verification: "That sign-in link has expired. Please try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect("/decks");

  const { error, callbackUrl } = await searchParams;
  const message = error ? (ERRORS[error] ?? "Could not sign you in. Please try again.") : null;

  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" className="mx-auto mb-4 size-14 rounded-2xl" />
          <h1 className="text-2xl font-semibold tracking-tight text-text">Recall</h1>
          <p className="mt-2 text-sm text-muted">
            Spaced repetition that adapts the wording, so you learn the material — not the question.
          </p>
        </div>

        <div className="card-surface p-6">
          {message && (
            <div className="mb-4 rounded-lg border border-bad/30 bg-bad-soft px-3.5 py-2.5 text-sm text-bad">
              {message}
            </div>
          )}

          {enabledProviders.length === 0 ? (
            <div className="space-y-3 text-sm">
              <p className="font-medium text-text">No sign-in provider is configured.</p>
              <p className="text-muted">
                Add <code className="rounded bg-surface-2 px-1 py-0.5 text-xs">AUTH_GOOGLE_ID</code> and{" "}
                <code className="rounded bg-surface-2 px-1 py-0.5 text-xs">AUTH_GOOGLE_SECRET</code> to
                your <code className="rounded bg-surface-2 px-1 py-0.5 text-xs">.env.local</code>, then
                restart the server. See the README for the full walkthrough.
              </p>
            </div>
          ) : (
            <SignInButtons providers={enabledProviders} callbackUrl={callbackUrl ?? "/decks"} />
          )}
        </div>

        <p className="mt-6 text-center text-xs text-muted">
          Your decks sync to your account, so you can study from any device.
        </p>
      </div>
    </main>
  );
}
