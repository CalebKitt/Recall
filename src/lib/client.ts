"use client";

/** Browser-side fetch helpers. Server code must not import this module. */

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * JSON fetch that turns a non-2xx response into an ApiError carrying the
 * server's own message, so callers can show it verbatim.
 */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (typeof body?.error === "string") message = body.error;
    } catch {
      /* Non-JSON error body; keep the status-based message. */
    }
    if (res.status === 401) {
      message = "Your session expired. Please sign in again.";
    }
    throw new ApiError(message, res.status);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const getJson = <T,>(url: string) => api<T>(url);

export const postJson = <T,>(url: string, body?: unknown) =>
  api<T>(url, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const patchJson = <T,>(url: string, body: unknown) =>
  api<T>(url, { method: "PATCH", body: JSON.stringify(body) });

export const del = <T,>(url: string) => api<T>(url, { method: "DELETE" });

/** Format 0..1 as a percentage, or an em dash when there is no data yet. */
export function formatPct(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function accuracyTone(value: number | null | undefined): "good" | "warn" | "bad" | "muted" {
  if (value === null || value === undefined) return "muted";
  if (value >= 0.85) return "good";
  if (value >= 0.65) return "warn";
  return "bad";
}

/** "in 3d", "2h", "now" — relative time for due dates. */
export function relativeTime(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const mins = abs / 60000;
  const unit =
    mins < 1
      ? "now"
      : mins < 60
        ? `${Math.round(mins)}m`
        : mins < 1440
          ? `${Math.round(mins / 60)}h`
          : mins < 43200
            ? `${Math.round(mins / 1440)}d`
            : `${Math.round(mins / 43200)}mo`;
  if (unit === "now") return "now";
  return ms > 0 ? `in ${unit}` : `${unit} ago`;
}

/** The browser's IANA timezone, used to seed the user's setting. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
