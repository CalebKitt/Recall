"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useCallback, useEffect, useState } from "react";
import { getJson } from "@/lib/client";
import { cn } from "@/components/ui";

interface StreakPayload {
  streak: { current: number; longest: number; includesToday: boolean };
  totals: { reviewsToday: number };
}

/**
 * Dispatched by the study screen after each answer so the streak in the nav
 * updates without a full page reload.
 */
export const STREAK_EVENT = "recall:streak-changed";

export function notifyStreakChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(STREAK_EVENT));
}

const LINKS = [
  { href: "/decks", label: "Decks", icon: "▤" },
  { href: "/study", label: "Study", icon: "▶" },
  { href: "/stats", label: "Stats", icon: "◔" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

function StreakPill({ streak, active }: { streak: number; active: boolean }) {
  return (
    <span
      title={
        active
          ? `${streak} day streak — today's cards are done`
          : streak > 0
            ? `${streak} day streak — finish today's cards to keep it`
            : "No streak yet. Clear your due cards to start one."
      }
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[13px] font-semibold tabular-nums transition",
        active ? "bg-warn-soft text-streak" : "bg-surface-2 text-muted",
      )}
    >
      <span className={cn("text-sm", !active && "grayscale opacity-60")} aria-hidden="true">
        🔥
      </span>
      {streak}
    </span>
  );
}

export function Nav({ userName, userImage }: { userName?: string | null; userImage?: string | null }) {
  const pathname = usePathname();
  const [streak, setStreak] = useState<StreakPayload["streak"] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const refresh = useCallback(() => {
    getJson<StreakPayload>("/api/stats?days=7")
      .then((d) => setStreak(d.streak))
      // A failed streak fetch must never break navigation.
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(STREAK_EVENT, refresh);
    return () => window.removeEventListener(STREAK_EVENT, refresh);
  }, [refresh]);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      {/* Desktop / tablet top bar */}
      <header className="sticky top-0 z-40 hidden border-b border-border bg-surface/85 backdrop-blur sm:block">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-1 px-5">
          <Link href="/decks" className="mr-4 flex items-center gap-2 font-semibold text-text">
            {/* The icon carries its own background, so no accent tile behind it. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" className="size-7 rounded-lg" />
            Recall
          </Link>

          <nav className="flex items-center gap-0.5">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-sm font-medium transition",
                  isActive(l.href) ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
                )}
              >
                {l.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            {streak && <StreakPill streak={streak.current} active={streak.includesToday} />}

            <div className="relative">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-sm text-muted transition hover:bg-surface-2"
              >
                {userImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={userImage} alt="" className="size-7 rounded-full" referrerPolicy="no-referrer" />
                ) : (
                  <span className="flex size-7 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-text">
                    {(userName ?? "?").slice(0, 1).toUpperCase()}
                  </span>
                )}
              </button>

              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} aria-hidden="true" />
                  <div
                    role="menu"
                    className="card-surface absolute right-0 z-20 mt-2 w-52 overflow-hidden p-1.5"
                  >
                    <div className="truncate px-2.5 py-2 text-xs text-muted">{userName ?? "Signed in"}</div>
                    <button
                      role="menuitem"
                      onClick={() => signOut({ callbackUrl: "/login" })}
                      className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-text transition hover:bg-surface-2"
                    >
                      Sign out
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Mobile top bar: identity + streak only, navigation lives at the bottom */}
      <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-surface/85 px-4 backdrop-blur sm:hidden">
        <Link href="/decks" className="flex items-center gap-2 font-semibold text-text">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" className="size-7 rounded-lg" />
          Recall
        </Link>
        <div className="ml-auto flex items-center gap-2">
          {streak && <StreakPill streak={streak.current} active={streak.includesToday} />}
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="rounded-lg px-2 py-1.5 text-xs text-muted transition hover:bg-surface-2"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Mobile bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 backdrop-blur sm:hidden">
        <div
          className="flex items-stretch"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                "flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium transition",
                isActive(l.href) ? "text-accent" : "text-muted",
              )}
            >
              <span className="text-lg leading-none" aria-hidden="true">
                {l.icon}
              </span>
              {l.label}
            </Link>
          ))}
        </div>
      </nav>
    </>
  );
}
