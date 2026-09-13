# Recall

A spaced-repetition flashcard app in the mould of Anki, for phone and desktop, with your decks synced to your account.

- **Anki-style SM-2 scheduling** — learning steps, ease factors, lapses, relearning, leech suspension
- **AI-varied prompts** — an optional toggle that has Gemini rephrase each question before it's shown, so you learn the material rather than memorising the shape of the sentence
- **AI card suggestions** — proposes new cards on the deck's actual subject without duplicating what's already there
- **CSV / TSV import and export** — with scheduling preserved, so an export is a real backup
- **Streaks** — consecutive days on which you cleared your entire due queue
- **Review early** — when a deck is caught up, practise cards falling due in the next week
- **Accuracy statistics** — per card, per deck, and overall, with an activity chart
- **Sign in with Google or Microsoft** — study from any device

---

## Quick start

```bash
npm install
```

### 1. Try it immediately (no accounts needed)

There's a bundled dev database (Postgres compiled to WASM) and a local-only sign-in, so you can see the app working before setting anything up.

In one terminal:

```bash
node scripts/dev-db.mjs
```

In another, create `.env.local`:

```
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres"
DB_POOL_MAX="1"
DB_IDLE_TIMEOUT="0"
AUTH_SECRET="<run: npx auth secret>"
ENCRYPTION_KEY="<run: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\">"
AUTH_DEV_LOGIN="1"
```

Then:

```bash
npm run dev
```

Open http://localhost:3000 and use the **Development sign-in** box. `AUTH_DEV_LOGIN` is ignored by production builds, so this can't follow you to deployment.

> `.env.local` already exists in this repo with `AUTH_SECRET` and `ENCRYPTION_KEY` generated for you.

### 2. Set up the real thing

#### Database (Neon, free tier)

1. Create a project at [neon.tech](https://neon.tech).
2. Copy the **pooled** connection string into `DATABASE_URL`.
3. Create the tables:

```bash
npm run db:migrate
```

Any Postgres works — Neon is just the easiest free option. If you use a local Postgres or Neon, drop the `DB_POOL_MAX` and `DB_IDLE_TIMEOUT` lines; they exist only because the bundled dev database serves a single connection.

> The bundled dev database is for trying things out. If you restart it, restart `npm run dev` too — the app holds one long-lived connection to it.

#### Google sign-in (free, no card)

1. [console.cloud.google.com](https://console.cloud.google.com) → create a project.
2. **APIs & Services → OAuth consent screen** → External → fill in the app name and your email. While it's in "Testing", add your own Google account under **Test users**.
3. **Credentials → Create credentials → OAuth client ID → Web application**.
4. Authorised redirect URIs — add both:
   - `http://localhost:3000/api/auth/callback/google`
   - `https://YOUR-DOMAIN/api/auth/callback/google`
5. Put the client ID and secret in `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`.

#### Microsoft sign-in (optional)

Microsoft Entra External ID is free up to 50,000 monthly users, but it needs an Azure subscription, which requires a card on file even if you're never charged. Google alone is enough — leave the Microsoft variables blank and that button simply doesn't appear.

To enable it: **Entra admin centre → App registrations → New registration**, redirect URI (Web) `http://localhost:3000/api/auth/callback/microsoft-entra-id`, then fill in `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, and `AUTH_MICROSOFT_ENTRA_ID_ISSUER`.

#### Gemini (optional, for the AI features)

Get a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

- Put it in `GEMINI_API_KEY` to make AI available to everyone using your instance, **and/or**
- Let each person paste their own key in **Settings**, which is stored AES-256-GCM encrypted and takes precedence over the server key.

Without any key the app works fully; the AI toggle and the suggestions tab explain what's missing instead of failing.

The app uses `gemini-3.6-flash` with a low thinking level (these are simple tasks, and full thinking makes each call slow). If that model is overloaded, rate limited, or retired — Google withdraws older models from new API keys — it automatically falls back to `gemini-3.5-flash-lite`. Override either with `GEMINI_MODEL` / `GEMINI_FALLBACK_MODEL`.

---

## Deploying to Vercel

1. Push this repository to GitHub.
2. [vercel.com](https://vercel.com) → **Add New → Project** → import the repo.
3. Add every variable from `.env.example` under **Settings → Environment Variables**. Do **not** set `AUTH_DEV_LOGIN`.
4. Set `NEXTAUTH_URL` to your deployed origin, and add `https://YOUR-DOMAIN/api/auth/callback/google` to the Google credentials.
5. Deploy, then run `npm run db:migrate` once against the production `DATABASE_URL`.

The free Hobby tier and Neon's free tier are enough to run this for yourself.

---

## How the scheduling works

Ratings are **Again / Hard / Good / Easy**, and every card moves through the same states Anki uses.

| State | Behaviour |
| --- | --- |
| `new` | Never studied. Introduced up to `newCardsPerDay` per deck. |
| `learning` | Walking the ladder — 1 minute, then 10 minutes. Two consecutive "Good"s graduate it. |
| `review` | Scheduled in days. "Good" multiplies the interval by the ease factor (starting at 2.5). |
| `relearning` | Where a failed review card goes. Rejoins `review` once the ladder is cleared. |

- **Hard** cuts ease by 0.15 and stretches the interval by only 1.2×; **Easy** adds 0.15 and applies a further 1.3× bonus. Ease never drops below 1.3.
- **Again** on a review card is a *lapse*: ease drops 0.20 and the interval collapses to one day.
- Intervals of 2+ days are **fuzzed** so cards learned together don't stay clumped forever.
- After 8 lapses a card is flagged a **leech** and auto-suspended, so one impossible card can't dominate every session.

All of this lives in [`src/lib/srs.ts`](src/lib/srs.ts) as pure functions, and is covered by unit tests.

### Streaks

A day counts toward your streak when you clear your **entire** due queue — every deck, not just one. Day boundaries use the timezone in your settings, so travelling doesn't cost you a streak.

A streak isn't shown as broken the moment midnight passes: yesterday counts as the anchor, so you have all of today to keep it alive.

Cards sitting in a learning step due in the next 20 minutes still count as outstanding, so the day isn't marked complete while you have cards mid-ladder.

### Reviewing early

When a deck has nothing due, **Review early** pulls in cards falling due over the next seven days. Two rules keep it sane: cards already studied today are skipped, and the session is clearly marked as early, since answering still reschedules the card and pushes its next review further out.

---

## AI rewording

With the toggle on, a card's question is rephrased before it's shown. The answer never changes.

The model is instructed to keep the answer identical, never leak it into the question, preserve difficulty, and genuinely vary the sentence structure rather than swapping a synonym. The app also checks the answer hasn't leaked into the variant before showing it, rather than trusting the model to have obeyed.

Variants are generated in batches of three and cached against a hash of the card's content, then served least-recently-shown first. So a normal review is one indexed query, not an API call — and editing a card automatically discards its stale variants. If Gemini is slow, down, or out of quota, the original wording is shown and the review continues.

During study, rephrased questions carry a **✦ reworded** tag you can tap to compare against the original.

---

## CSV import and export

**Import** accepts a file, a drag-and-drop, or pasted rows, and works out the rest:

- Delimiter is detected automatically — comma, tab (Anki's export format), or semicolon
- Column names are matched flexibly: `front`/`question`/`term`, `back`/`answer`/`definition`, and so on
- With no header row, the first two columns are used
- Quoted fields, embedded commas and newlines, doubled quotes, CRLF and a UTF-8 BOM are all handled
- Duplicates of cards already in the deck are skipped and reported, as are rows missing a question or answer

**Export** writes every card with its scheduling and accuracy, so re-importing restores your progress exactly. Turn scheduling off for a clean question/answer file to share, or pick TSV to move a deck into Anki.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and serve |
| `npm test` | Full test suite |
| `npm run typecheck` | TypeScript, no emit |
| `npm run db:generate` | Regenerate SQL migrations after editing the schema |
| `npm run db:migrate` | Apply migrations |
| `npm run db:studio` | Drizzle Studio, a browser UI for the data |
| `node scripts/dev-db.mjs` | Local throwaway Postgres on port 5433 |

---

## Tests

```bash
npm test
```

100 tests, in two layers:

- **Unit** — the scheduler, the CSV parser, and the timezone/streak maths, as pure functions with an injected clock and RNG.
- **Integration** — the service layer against a real Postgres running in-process (PGlite), with the actual migrations applied. These cover the SQL itself, the transaction in `answerCard`, the daily-stats upsert, cascading deletes, daily caps, and that one user can never see another's cards.

No mocks and no separate database server; `npm test` works on a clean checkout.

---

## Project layout

```
src/
  app/
    (app)/            Signed-in screens: decks, deck editor, study, stats, settings
    api/              Route handlers
    login/            Sign-in page
  components/
    deck/             Deck editor tabs: cards, AI suggestions, import/export, settings
    Nav.tsx           Desktop top bar and mobile tab bar
    ui.tsx            Buttons, fields, modal, toasts
  lib/
    srs.ts            SM-2 scheduler (pure)
    study.ts          Queue building, answering, streaks
    stats.ts          Aggregate statistics
    csv.ts            RFC 4180 parsing and serialisation (pure)
    time.ts           Timezone-aware day boundaries and streak maths (pure)
    gemini.ts         Gemini client
    crypto.ts         AES-256-GCM for stored API keys
    db/schema.ts      Drizzle schema
drizzle/              Generated SQL migrations
tests/                Unit and integration tests
```

The service layer takes its database handle as an argument rather than importing a singleton, which is what lets the integration tests run the real code against a throwaway database.

---

## Notes on security

- Every API route resolves the user from the session and scopes its queries by user id — ownership is enforced in the query, not by checking an id from the request.
- Per-user Gemini keys are encrypted with AES-256-GCM before storage and never returned to the client; Settings shows only a masked preview.
- `ENCRYPTION_KEY` must be stable. Changing it makes stored personal API keys unreadable (they fail closed and fall back to the server key).
- The development sign-in accepts any email with no password. It's guarded by both an explicit env flag and `NODE_ENV !== "production"`, so a production build can't expose it even if the flag leaks into the environment.
