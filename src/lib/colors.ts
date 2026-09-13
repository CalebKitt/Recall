/** Deck accent colours. Kept as literal classes so Tailwind can see them. */

export const DECK_COLORS = [
  "indigo",
  "violet",
  "sky",
  "teal",
  "emerald",
  "amber",
  "rose",
  "slate",
] as const;

export type DeckColor = (typeof DECK_COLORS)[number];

const SWATCH: Record<string, string> = {
  indigo: "bg-indigo-500",
  violet: "bg-violet-500",
  sky: "bg-sky-500",
  teal: "bg-teal-500",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  slate: "bg-slate-500",
};

const STRIPE: Record<string, string> = {
  indigo: "from-indigo-500/70",
  violet: "from-violet-500/70",
  sky: "from-sky-500/70",
  teal: "from-teal-500/70",
  emerald: "from-emerald-500/70",
  amber: "from-amber-500/70",
  rose: "from-rose-500/70",
  slate: "from-slate-500/70",
};

export const swatchClass = (color: string) => SWATCH[color] ?? SWATCH.indigo;
export const stripeClass = (color: string) => STRIPE[color] ?? STRIPE.indigo;
