"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { Button, Spinner } from "@/components/ui";

interface ProviderInfo {
  id: string;
  name: string;
}

function ProviderIcon({ id }: { id: string }) {
  if (id === "google") {
    return (
      <svg viewBox="0 0 24 24" className="size-[18px]" aria-hidden="true">
        <path
          fill="#4285F4"
          d="M23.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.55-5.17 3.55-8.87Z"
        />
        <path
          fill="#34A853"
          d="M12 24c3.24 0 5.96-1.08 7.95-2.91l-3.88-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.28v3.09A12 12 0 0 0 12 24Z"
        />
        <path
          fill="#FBBC05"
          d="M5.27 14.29a7.2 7.2 0 0 1 0-4.58V6.62H1.28a12 12 0 0 0 0 10.76l3.99-3.09Z"
        />
        <path
          fill="#EA4335"
          d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.62l3.99 3.09C6.22 6.86 8.87 4.75 12 4.75Z"
        />
      </svg>
    );
  }
  // Microsoft's four-square logo.
  return (
    <svg viewBox="0 0 23 23" className="size-[18px]" aria-hidden="true">
      <path fill="#F25022" d="M1 1h10v10H1z" />
      <path fill="#7FBA00" d="M12 1h10v10H12z" />
      <path fill="#00A4EF" d="M1 12h10v10H1z" />
      <path fill="#FFB900" d="M12 12h10v10H12z" />
    </svg>
  );
}

export function SignInButtons({
  providers,
  callbackUrl,
}: {
  providers: ProviderInfo[];
  callbackUrl: string;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [devEmail, setDevEmail] = useState("dev@localhost");

  const oauth = providers.filter((p) => p.id !== "dev-login");
  const hasDevLogin = providers.some((p) => p.id === "dev-login");

  return (
    <div className="space-y-2.5">
      {oauth.map((p) => (
        <Button
          key={p.id}
          size="lg"
          variant="secondary"
          className="w-full"
          loading={false}
          disabled={pending !== null}
          onClick={() => {
            setPending(p.id);
            // Full-page redirect; the pending state persists until it happens.
            void signIn(p.id, { callbackUrl });
          }}
        >
          {pending === p.id ? <Spinner className="size-[18px]" /> : <ProviderIcon id={p.id} />}
          <span>Continue with {p.name}</span>
        </Button>
      ))}

      {hasDevLogin && (
        <div className="space-y-2.5">
          {oauth.length > 0 && (
            <div className="flex items-center gap-3 py-1">
              <span className="h-px flex-1 bg-border" />
              <span className="text-[11px] uppercase tracking-wide text-muted">or</span>
              <span className="h-px flex-1 bg-border" />
            </div>
          )}

          <form
            className="space-y-2.5 rounded-lg border border-dashed border-border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              setPending("dev-login");
              void signIn("dev-login", { email: devEmail, callbackUrl });
            }}
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide text-warn">
              Development sign-in
            </p>
            <p className="text-xs text-muted">
              Local only — no password, no OAuth setup. Disabled automatically in production
              builds.
            </p>
            <input
              type="email"
              value={devEmail}
              onChange={(e) => setDevEmail(e.target.value)}
              aria-label="Development account email"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
            />
            <Button type="submit" size="md" className="w-full" disabled={pending !== null}>
              {pending === "dev-login" ? <Spinner className="size-4" /> : null}
              Sign in as this user
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
