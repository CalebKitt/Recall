<img src="public/logo.png" width="72" alt="">

# Recall

**[beta-recall-ai.vercel.app](https://beta-recall-ai.vercel.app)**

A spaced-repetition flashcard app for phone and desktop. Cards you find hard come back
sooner, cards you know get pushed further out — and an AI rewords each question before
showing it, so you can't pass by memorising the shape of a sentence.

Sign in with Google and your decks follow you to any device.

---

## What it does

**Spaced repetition that actually schedules.** An Anki-style SM-2 algorithm with learning
steps, ease factors, lapses and relearning. Grade a card Again, Hard, Good or Easy and it
reschedules accordingly — minutes for something new, months for something you know cold.

**Questions that change wording.** Optional, and off by default. With it on, Gemini rephrases
each prompt while leaving the answer identical. You end up recalling the material rather than
pattern-matching a familiar sentence. A ↻ button gets you a different wording on demand, and
a ✦ tag lets you compare against the original.

**AI card suggestions.** Open a deck, and it will work out the subject from the cards already
there and propose new ones that fit without repeating what you have. If your deck is characters
from a novel, you get other characters from that same novel. Accept, edit or reject each one.

**Streaks that mean something.** A day counts only when you clear your entire due queue across
every deck. Day boundaries follow your own timezone, and yesterday acts as an anchor so you have
all of today to keep a streak alive.

**Statistics per card and per deck.** Accuracy, lapses, interval maturity, answer spread and an
activity chart. Sort a deck by "weakest" to find the cards actually costing you.

**Import and export.** CSV or TSV, with the delimiter and column names detected automatically —
Anki exports work as-is. Exports include scheduling, so a file is a real backup that restores
your progress rather than just the text.

**Built for a phone.** Bottom tab bar, large touch targets, safe-area padding, and a light and
dark theme that follows your system.

---

## How the scheduling works

Every card sits in one of four states, and the interval grows by an *ease factor* that moves
with your performance.

| State | Behaviour |
| --- | --- |
| `new` | Never studied. Introduced up to a daily cap, 20 per deck by default. |
| `learning` | A ladder of 1 minute, then 10. Two consecutive "Good" answers graduate it. |
| `review` | Scheduled in days. "Good" multiplies the interval by the ease factor, starting at 2.5. |
| `relearning` | Where a failed review card goes before rejoining the review pool. |

- **Hard** cuts ease by 0.15 and stretches the interval only 1.2×; **Easy** adds 0.15 and applies
  a further 1.3× bonus. Ease never falls below 1.3.
- **Again** on a review card is a *lapse*: ease drops 0.20 and the interval collapses to one day.
- Intervals of two days or more are **fuzzed** so cards learned together don't stay clumped.
- After 8 lapses a card becomes a **leech** and is suspended, so one impossible card can't
  dominate every session.

It lives in [`src/lib/srs.ts`](src/lib/srs.ts) as pure functions — no database, with the clock
and randomness injected — which is what makes it straightforward to test.

## How the rewording works

Calling a model on every single review would be slow and expensive. Instead each call generates
three variants at once, cached against a hash of the card's text, and served least-recently-shown
first. A normal review is one indexed query; the model is only called when the pool runs low.
Editing a card invalidates its cached variants automatically.

The model is told to keep the answer identical, never leak it into the question, and vary the
sentence structure rather than swap a synonym — and the app checks the answer hasn't leaked
before showing a variant, rather than trusting the model to have obeyed.

If Gemini is slow, overloaded or out of quota, the request falls back to a lighter model, and
failing that the original wording is shown. **Studying never breaks because the AI is down.**

---

## Built with

| | |
| --- | --- |
| **TypeScript** | 91% of the codebase — schema, API and UI |
| **Next.js 15** (App Router) + **React 19** | Frontend and API in one project |
| **PostgreSQL** on **Neon** | Serverless Postgres that scales to zero |
| **Drizzle ORM** | Schema is the source of truth for types *and* migrations |
| **Auth.js** + Google OAuth | No passwords stored, because none exist |
| **Gemini API** | Rewording and card suggestions |
| **Tailwind CSS 4** | Styling |
| **Vercel** | Hosting, deploying on push |

Roughly 9,900 hand-written lines, 12 database tables, 14 API endpoints and 119 tests.

---

## Running it yourself

You'll need Node 20+ and a Postgres database.

```bash
git clone https://github.com/CalebKitt/Recall.git
cd Recall
npm install
```

### The fastest path

There's a bundled database — Postgres compiled to WebAssembly — and a local-only sign-in, so you
can see it working without creating any accounts.

```bash
node scripts/dev-db.mjs          # in one terminal
```

Create `.env.local`:

```ini
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres"
DB_POOL_MAX="1"
DB_IDLE_TIMEOUT="0"
AUTH_SECRET="<npx auth secret>"
ENCRYPTION_KEY="<64 hex chars: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\">"
AUTH_DEV_LOGIN="1"
```

```bash
npm run dev                      # in another
```

Open <http://localhost:3000> and use the **Development sign-in** box. `AUTH_DEV_LOGIN` is ignored
by production builds, so it can't follow you to a deployment.

> The bundled database serves a single connection, which is why `DB_POOL_MAX` and
> `DB_IDLE_TIMEOUT` are set. Restart `npm run dev` if you restart the database.

### With a real database and Google sign-in

1. **Database** — create a project at [neon.tech](https://neon.tech), copy the **pooled**
   connection string into `DATABASE_URL`, and create the tables:

   ```bash
   npm run db:migrate
   ```

   Any Postgres works; drop the `DB_POOL_MAX` and `DB_IDLE_TIMEOUT` lines when you're not using
   the bundled one.

2. **Google sign-in** — in [console.cloud.google.com](https://console.cloud.google.com), configure
   the OAuth consent screen as **External**, then create an **OAuth client ID → Web application**
   with `http://localhost:3000/api/auth/callback/google` under **Authorised redirect URIs** (not
   JavaScript origins — that mismatch is the most common setup failure). Put the ID and secret in
   `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`.

3. **Gemini** *(optional)* — a free key from
   [aistudio.google.com/apikey](https://aistudio.google.com/apikey) in `GEMINI_API_KEY` enables AI
   for everyone on your instance. Users can also paste their own key in **Settings**, which is
   stored AES-256-GCM encrypted and takes precedence. Without any key the app works fully and the
   AI screens explain what's missing.

Microsoft Entra ID sign-in is also wired up; set `AUTH_MICROSOFT_ENTRA_ID_ID`,
`AUTH_MICROSOFT_ENTRA_ID_SECRET` and `AUTH_MICROSOFT_ENTRA_ID_ISSUER` and the button appears.
Leave them blank and it doesn't.

See [`.env.example`](.env.example) for every variable.

### Deploying

Import the repository at [vercel.com](https://vercel.com) and set `DATABASE_URL`, `AUTH_SECRET`,
`ENCRYPTION_KEY`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` and optionally `GEMINI_API_KEY`. Don't
set `AUTH_DEV_LOGIN`, `DB_POOL_MAX` or `DB_IDLE_TIMEOUT`. Add
`https://your-domain/api/auth/callback/google` to the same OAuth client.

`ENCRYPTION_KEY` must stay identical across environments, or personal Gemini keys already stored
in the database can't be decrypted.

To move an existing local database into the cloud:

```bash
node scripts/migrate-to-cloud.mjs "<connection-string>"
```

Decks, cards, scheduling, review history and streaks are copied with their original ids. Safe to
run twice — existing rows are skipped.

---

## Commands

| Command | |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and serve |
| `npm test` | Full test suite |
| `npm run typecheck` | TypeScript, no emit |
| `npm run db:generate` | Regenerate migrations after a schema change |
| `npm run db:migrate` | Apply migrations |
| `npm run db:studio` | Drizzle Studio, a browser UI for the data |
| `node scripts/dev-db.mjs` | Bundled Postgres on port 5433 |

## Tests

```bash
npm test
```

119 tests in two layers, with no mocking framework and no database server to install:

- **Unit** — the scheduler, the CSV parser, the timezone and streak maths, and the Gemini
  fallback chain, all as pure functions with the clock, randomness and network injected.
- **Integration** — the real service layer against a real Postgres running in-process, with the
  actual migrations applied. These cover the SQL itself, the transaction that records an answer,
  cascading deletes, daily caps, per-user API keys, and that one account can never read another's
  cards.

## Project layout

```
src/
  app/
    (app)/            Signed-in screens: decks, editor, study, stats, settings
    api/              14 endpoints
    login/
  components/         Nav, shared UI, deck editor tabs
  lib/
    srs.ts            SM-2 scheduler (pure)
    study.ts          Queue building, answering, streaks
    stats.ts          Aggregate statistics
    csv.ts            RFC 4180 parsing and serialisation (pure)
    time.ts           Timezone-aware day boundaries (pure)
    gemini.ts         AI client with model fallback
    crypto.ts         AES-256-GCM for stored API keys
    db/schema.ts      12 tables
drizzle/              Generated SQL migrations
tests/
```

API routes stay thin — authenticate, validate, delegate. The logic lives in `lib/` and takes its
database handle as an argument rather than importing a global one, which is what lets the tests
run the real code against a throwaway database.

---

## Security notes

- Every query filters by the user id from the session, never from the request body. Ownership is
  enforced in the `WHERE` clause, so requesting another user's deck returns "not found".
- Per-user Gemini keys are AES-256-GCM encrypted before storage and never returned to the client;
  Settings shows only a masked preview.
- The development sign-in accepts any email with no password. It's guarded by both an explicit
  environment flag **and** `NODE_ENV !== "production"`, so a production build can't expose it.

## Known limitations

- No rate limiting — a public instance should add it before opening sign-up.
- Cards are text only; no images or audio.
- No undo in the study session.
- The review log grows without bound. Fine for years at this scale, but there's no pruning yet.
- Uses SM-2 rather than FSRS, which models a forgetting curve from your actual history.
