# Competitor Price Monitor — MVP (Phase 0)

Imports the WOSG master product catalogue, matches our products to competitor
listings, scrapes those listings' prices, and shows where a competitor is
cheaper, dearer or level.

Built to the WOSG Competitor Price Monitoring spec, **Phase 0 only**. Scheduling,
alerting and price-history charts are later phases and are deliberately not here.

The app never scrapes WOSG's own sites — our prices are imported.

---

## What's in this MVP

| Spec | Delivered |
| --- | --- |
| §5.1 Product import | CSV/Excel upload of the single master export; required-field validation, de-duplication on SKU, update-not-duplicate, per-row error report. Unrecognised columns import as **extensible spec attributes**. |
| §5.2 Competitor config | Competitors are JSON files in `competitors/`. Adding a retailer is a config file plus a sync — **never a code change**. Ernest Jones ships enabled; Beaverbrooks ships disabled as a worked example. |
| §5.3 Matching | Tiered scoring — EAN/MPN exact → brand + spec attributes → fuzzy name — with gate/high/medium/ignore weights per category (Appendix A). Anything below the threshold goes to a manual-confirm queue; confirmed matches persist as a stored URL. |
| §5.4 Scraping | Playwright (or plain HTTP where a site allows) against the stored URL of confirmed matches; on-site search + candidate proposal for unmatched products. robots.txt respected, per-domain rate limiting with jitter, retry with backoff, and typed, loud failures. |
| §5.5 Comparison | Our price vs each competitor's latest price, classified lower / equal / higher with £ and % delta, plus the cheapest competitor per product. Every observation is stored, so price history accumulates from day one. |
| §5.7 Visual design | A considered design system — tokenised palette, typography and spacing; colour-coded price position; polished tables, cards, drawer drill-in, skeleton loading and toasts. |
| Manual trigger | "Run now" from the UI. No scheduler yet, by design. |

**Not built yet (later phases):** scheduling, email/Slack alerts, history charts,
SAP Commerce integration, SSO and role-based access.

---

## Architecture

```
.
├── competitors/              # One JSON file per competitor — config, not code
│   ├── ernest-jones.json     #   enabled
│   └── beaverbrooks.json     #   disabled (Phase 2)
├── migrations/               # Plain SQL, applied in order, tracked in the DB
│   └── 001_init.sql
├── sample-data/              # Example catalogue export to try the import with
├── server/                   # Node + TypeScript API and scraping engine
│   └── src/
│       ├── config/env.ts     # All configuration from the environment
│       ├── db/               # Pool, migrations, seed
│       ├── domain/types.ts   # Core entities (Spec §6)
│       ├── import/           # CSV/Excel catalogue import
│       ├── matching/
│       │   ├── attributes.ts #   Appendix A rulebook + value normalisation
│       │   ├── score.ts      #   Tiered confidence scoring
│       │   └── discovery.ts  #   Search a competitor, score, store candidates
│       ├── scraping/
│       │   ├── robots.ts     #   robots.txt, cached per origin, fails closed
│       │   ├── rateLimiter.ts#   Per-domain delay + jitter + concurrency cap
│       │   ├── fetcher.ts    #   HTTP or Playwright, retry with backoff
│       │   ├── extract.ts    #   JSON-LD first, CSS selectors as fallback
│       │   └── runner.ts     #   Run orchestration and per-target outcomes
│       ├── services/         # Comparison view
│       └── routes/           # REST API
└── web/                      # React + Vite frontend
    └── src/
        ├── styles.css        # The design system (tokens + components)
        ├── components/ui.tsx # Shared primitives
        └── pages/            # Comparison, review queue, runs, import, competitors
```

### Data model (Spec §6)

| Table | Purpose |
| --- | --- |
| `products` | Our catalogue row. Spec attributes live in a `specs` JSONB column so the import accepts an open set of fields. |
| `competitors` | A monitored site plus its JSONB config, loaded from `competitors/*.json`. |
| `product_matches` | Product ↔ competitor listing URL, with confidence, tier, evidence and confirm/reject state. A partial unique index enforces one confirmed listing per product per competitor. |
| `price_observations` | One scraped price point: price, was-price, promo, stock, source URL, timestamp. This is the price-history time series. |
| `scrape_runs` / `scrape_run_items` | A run and its per-target outcome, so failures are attributable rather than aggregate. |
| `alerts` | Table created for the Phase 1 alerting work; nothing writes to it yet. |
| `users` | Created for later role separation; the MVP uses one shared password. |

---

## Running locally

**Prerequisites:** Node 20+, a PostgreSQL database.

```bash
git clone https://github.com/dalewoods/price-scraper.git
cd price-scraper

npm install
npx playwright install --with-deps chromium   # required for scraping

cp .env.example .env                           # then set DATABASE_URL
npm run seed                                   # applies migrations + loads competitors
npm run dev                                    # API on :3001, UI on :5173
```

Open <http://localhost:5173>.

### First run, end to end

1. **Import catalogue** — upload `sample-data/sample-catalogue.csv` (or your own
   export). Every column beyond the known fields becomes a spec attribute.
2. **Competitors** — check Ernest Jones is enabled. Before trusting it against
   the live site, use **Test a product URL** to dry-run one real listing and
   confirm the extracted price matches what the page shows.
3. **Scrape runs → Run now** — start with *Discovery only* and a small product
   limit (10–25).
4. **Match review** — confirm or reject the proposed candidates. Confirming
   stores the competitor URL, so future runs hit that page directly.
5. **Run now** again in *Prices only* mode, then open **Price comparison**.

### Useful commands

```bash
npm run dev          # API + UI with hot reload
npm run build        # Build frontend, then compile the server
npm start            # Serve the built app (API + static UI on one port)
npm run migrate      # Apply pending migrations only
npm run seed         # Migrate, then sync competitors/*.json into the database
npm test             # Server unit tests
npm run typecheck    # Typecheck both workspaces
```

---

## Deploying to Render.com

The database is an **external Postgres** (Neon, Supabase, Aiven or similar)
reached by connection string. Nothing about it is hardcoded, and no credentials
are committed.

### 1. Provision the database

Create a Postgres instance with your provider and copy its connection string. It
looks like:

```
postgresql://user:password@host.provider.com:5432/dbname?sslmode=require
```

Hosted providers require SSL; the pool enables it by default. Use
`sslmode=verify-full` if you want strict certificate verification.

### 2. Create the Render web service

**Option A — blueprint (recommended).** This repo contains `render.yaml`. In
Render: **New → Blueprint**, point it at this repository, and it will create the
service with the right build and start commands.

**Option B — manual.** **New → Web Service**, connect the repo, then set:

| Setting | Value |
| --- | --- |
| Root directory | *(leave blank — the app is at the repo root)* |
| Runtime | **Docker** |
| Dockerfile path | `./Dockerfile` |
| Health check path | `/api/health` |
| Instance type | **Starter or larger** — Chromium exceeds the free plan's memory |

There is no build or start command to set: the Dockerfile defines both.

#### Why Docker rather than Render's native Node runtime

Chromium needs a set of system libraries (`libnss3`, `libatk`, and friends) that
aren't in Render's native Node image. The usual way to get them,
`playwright install --with-deps`, shells out to `apt-get` as root — which
Render's build sandbox does not permit, so the build fails with
`Exited with status 1 while building your code`. Installing without
`--with-deps` gets the browser but not the libraries, so it fails later at
launch instead.

The Dockerfile starts from `mcr.microsoft.com/playwright:v1.62.1-noble`, where
the browser and its libraries are already installed and tested together.

> **Keep the image tag and the Playwright version in step.** The tag in the
> Dockerfile must match the `playwright` version resolved in `package-lock.json`.
> If they drift, scrapes fail with "Executable doesn't exist at …".

The first Docker build is slow (the base image is large); later builds reuse
cached layers.

### 3. Set environment variables

In the service's **Environment** tab:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Your external Postgres connection string |
| `APP_PASSWORD` | A shared password — set this for any internet-facing deploy |
| `SESSION_SECRET` | `openssl rand -base64 32` (the blueprint generates one) |
| `NODE_ENV` | `production` |
| `SCRAPER_USER_AGENT` | Include a real contact address |

The blueprint marks `DATABASE_URL` and `APP_PASSWORD` as `sync: false`, so Render
does **not** create them for you — set them by hand. The server refuses to start
without `DATABASE_URL`, which shows up as a failed deploy.

`PORT` is injected by Render — don't set it. Do **not** set
`PLAYWRIGHT_BROWSERS_PATH`: the Docker image already points it at the right
place, and overriding it sends Playwright looking in an empty directory. Full
list in `.env.example`.

> If `APP_PASSWORD` is left unset the app runs with **no login gate** and warns
> loudly in the logs on boot.

### 4. Running migrations on Render

Migrations run **automatically on every boot** — `src/index.ts` calls
`runMigrations()` before the server listens, and applied migrations are tracked
in a `schema_migrations` table, so re-running is a no-op. A normal deploy needs
no separate release step.

To run them by hand instead — from the service's **Shell** tab:

```bash
npm run migrate:prod --workspace server   # apply pending migrations
npm run seed --workspace server           # migrate + reload competitors/*.json
```

Adding a migration means dropping a new numbered file into `migrations/`
(`002_…sql`); they apply in filename order, each in its own transaction.

### 5. After deploying

Hit `/api/health` — it reports database connectivity and whether auth is on.

---

## Adding a competitor (config, not code)

1. Copy `competitors/beaverbrooks.json` to `competitors/<slug>.json`.
2. Set `slug`, `displayName`, `baseUrl`, `searchUrlPattern` (must contain
   `{query}`), and the brands they stock.
3. Set `rendering` to `http` if the site serves prices in the initial HTML —
   it's much lighter than a browser. Use `browser` when prices are rendered by
   JavaScript.
4. Leave `useJsonLd` on. Most UK retailers publish schema.org `Product`/`Offer`
   markup, which is far more stable than CSS classes. The selectors are the
   fallback.
5. Restart the app, or hit **Re-sync from config** on the Competitors page.
6. Tune the selectors with **Test a product URL** before enabling the competitor.

### Match confidence

Scoring follows Appendix A. Gate attributes are pass/fail — brand disagreement
rejects a candidate outright. High and medium attributes contribute weighted
points, an EAN/MPN exact match scores 100 and overrides everything, and
attributes marked *ignore* (water resistance, ring size, strap length,
packaging) never discriminate — they are variants of the same product.

Matches at or above **85** auto-confirm; anything below goes to the review queue.
A name-only fuzzy match can never auto-confirm. Tune the thresholds in
`server/src/matching/attributes.ts` once you have real data — the spec treats
these weights as a starting point, not the final model.

---

## Scraping conduct (Spec §9)

Built in, not bolted on:

- **robots.txt is respected** and cached per origin. If it cannot be retrieved,
  the fetch is **skipped rather than assumed permitted**. A site-declared
  `Crawl-delay` overrides our own when it is longer.
- **Rate limited per domain** with randomised jitter and a concurrency cap.
- **Identifies itself honestly** via `SCRAPER_USER_AGENT`. Put a real contact
  address there.
- **Public data only** — prices and product information. Nothing login-gated, no
  personal data.
- **No defeat-of-protection logic.** A `401`/`403`/`429` is recorded as
  `blocked`, never retried and never worked around. If a site actively blocks
  automated access, that is a signal to reconsider the source — consider a
  licensed price feed instead.
- **Images, fonts and media are not downloaded** — they add nothing to price
  extraction and cost the competitor bandwidth.

### Failures are loud

A competitor changing their layout must never surface as a silently wrong price.
Every failure is typed and recorded against the run:

| Kind | Meaning |
| --- | --- |
| `robots_disallowed` | robots.txt forbids it, or could not be read |
| `blocked` | Site actively blocked us — not retried, not worked around |
| `not_found` | A previously-matched listing now 404s |
| `layout_changed` | Expected product-page markers are gone — selectors need review |
| `no_price_found` | Neither JSON-LD nor selectors produced a price |
| `implausible_price` | Extracted a price outside the sane range — refused to store it |
| `timeout` / `http_error` / `navigation_failed` | Transient; retried with backoff |

Prices are only ever written when extraction fully succeeds. See **Scrape runs**
in the UI for per-target outcomes.

---

## Before going live

- [ ] **Tune the Ernest Jones selectors.** The CSS fallbacks in
      `competitors/ernest-jones.json` are **unverified** against the live site —
      they were written without network access to it. JSON-LD is the primary
      path and usually suffices, but verify with **Test a product URL** on a few
      real listings and confirm the extracted price matches the page.
- [ ] Review Ernest Jones' terms of use and confirm the legal sign-off recorded
      in the spec covers this deployment.
- [ ] Set `APP_PASSWORD` and `SESSION_SECRET`.
- [ ] Put a real contact address in `SCRAPER_USER_AGENT`.
- [ ] Start with a small product limit and check the run's error list before
      scaling up.
- [ ] Agree a retention window for `price_observations` (§8) — nothing prunes it
      yet.

## API reference

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Database connectivity and auth state |
| `POST` | `/api/products/import` | Upload a catalogue export (multipart `file`) |
| `GET` | `/api/products/:id/history` | Observation history for one product |
| `GET` | `/api/comparison` | Comparison view; filter by brand, category, competitor, position, search |
| `GET` | `/api/comparison/export.csv` | CSV export of the current view |
| `GET` | `/api/matches?status=pending` | The review queue |
| `POST` | `/api/matches/:id/confirm` \| `/reject` | Resolve a candidate |
| `POST` | `/api/matches` | Manually link a product to a competitor URL (verified on save) |
| `GET` | `/api/competitors` | Configured competitors |
| `POST` | `/api/competitors/sync` | Reload `competitors/*.json` |
| `POST` | `/api/competitors/:slug/test-url` | Dry-run extraction on one URL; stores nothing |
| `POST` | `/api/runs` | Trigger a run (`mode`: `prices` \| `discover` \| `both`) |
| `GET` | `/api/runs` \| `/api/runs/:id` | Run history and per-target detail |
| `GET` | `/api/runs/errors/recent` | Recent scrape failures across all runs |
