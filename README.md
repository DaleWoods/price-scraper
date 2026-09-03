# Competitor Price Monitor

Imports WOSG's live product feeds, finds the same products on competitors'
sites, records what they charge, and shows where we are cheaper, dearer or
level — per site, with history, and with alerts when something moves.

Built to the WOSG Competitor Price Monitoring spec. The app **never scrapes
WOSG's own sites**: our prices come from the Google Shopping feeds each fascia
already produces.

- [Status at a glance](#status-at-a-glance)
- [Requirements and what is delivered](#requirements-and-what-is-delivered)
- [What is not built yet](#what-is-not-built-yet)
- [Architecture](#architecture)
- [Architecture decisions](#architecture-decisions)
- [Running locally](#running-locally)
- [Deploying to Render.com](#deploying-to-rendercom)
- [Adding a competitor](#adding-a-competitor-config-not-code)
- [Scraping conduct](#scraping-conduct-spec-9)
- [When a site refuses us](#when-a-site-refuses-us)
- [API reference](#api-reference)
- [Feature notes](#feature-notes)
- [Where the rest of the documentation lives](#where-the-rest-of-the-documentation-lives)

---

## Status at a glance

**The application is feature-complete for its purpose and is limited by data,
not by code.** Everything below works: import, matching, scanning, comparison,
history and alerting. The gap between "it works" and "it is useful" is that it
currently monitors **one competitor**.

| | |
| --- | --- |
| **Working end to end** | Feed import, per-fascia pricing, sitemap discovery, matching and review, scanning, comparison, price history, three alert types, scrape health, per-competitor verification |
| **The live constraint** | Ten of eleven competitor configurations are **unverified and disabled**. They were written without internet access and have never been checked against a real site |
| **The next action** | Run **Admin → Can we read each competitor?** from the deployed app. It reports, per competitor, whether we can actually read their prices. Nothing else should be decided before that |
| **Deliberately absent** | Scheduling. Every run is triggered by hand |

> **A warning that has cost real time.** If a verification run reports *every*
> competitor as unreachable, that is the host's own network, not the retailers.
> The development sandbox this was built in refuses all outbound HTTPS,
> including to `google.com`. Do not conclude a retailer blocks us without
> checking from somewhere with ordinary internet access.

---

## Requirements and what is delivered

| Spec | Status | Delivered |
| --- | --- | --- |
| **§5.1** Product import | ✅ Done | Google Shopping feed per fascia. Authoritative for its site: prices from an earlier feed are replaced, and products absent from every latest feed are **delisted** rather than deleted. Format detected from magic bytes; damaged identifiers, padding rows and repeated headers are reported rather than hidden. |
| **§5.2** Competitor config | ⚠️ Built, unverified | Competitors are JSON files in `competitors/`. Adding a retailer is config plus a sync — **never a code change**. Eleven are configured; **one is enabled**, the other ten are unverified guesses. |
| **§5.3** Matching | ✅ Done | Tiered scoring — EAN/MPN exact → brand + spec attributes → fuzzy name — with gate/high/medium/ignore weights per category (Appendix A). ≥85 auto-confirms; below that goes to a review queue with single and bulk decisions, plus manual URL linking. |
| **§5.4** Scraping | ✅ Done | Sitemap discovery, robots.txt honoured, per-domain rate limiting with jitter, retry with backoff, typed loud failures. Fetches over plain HTTP and escalates to a browser only where needed. Refusals are diagnosed by cause. |
| **§5.5** Comparison | ✅ Done | Our price vs each competitor's latest, classified lower/equal/higher with £ and % delta, cheapest competitor per product, per-competitor coverage, CSV export, and a price trend chart. Every observation is stored, so history accumulates from day one. Competitor prices are shown with their **age**, so a stale figure cannot read as current. |
| **§5.6** Alerts | ✅ Done (in-app) | Three types: **undercut** (a competitor cheaper than us at one of our sites), **price drop** (a competitor cutting their own price sharply) and **listing gone** (a matched product out of stock or 404ing). Undercut and listing-gone resolve themselves. Thresholds are configurable in Admin. **In-app only** — no email or Slack delivery. |
| **§5.7** Visual design | ✅ Done | Tokenised palette, typography and spacing; colour-coded price position; tables, cards, drawer drill-in, skeleton loading and toasts. |
| **§8** Retention | ❌ Pending | Nothing prunes `price_observations`. A retention window still needs agreeing. |
| **§9** Scraping conduct | ✅ Done | robots.txt respected and failing closed, honest user agent, public data only, no defeat-of-protection logic, no media downloads. See [Scraping conduct](#scraping-conduct-spec-9). |
| Manual trigger | ✅ Done | Run now, scoped to one product, an uploaded list of SKUs, or everything. |
| Scheduling | ❌ Pending | By design for this phase. |

---

## What is not built yet

Ordered by how much it matters.

1. **Verified competitors.** The largest gap between working and useful. Ten
   configurations have never met a live site. See
   [`docs/competitor-verification.md`](docs/competitor-verification.md).
2. **A retention policy for `price_observations`** (§8). The table only grows.
3. **Scheduling.** Every run is manual. Deliberate for this phase, but the tool
   is most valuable running nightly.
4. **Alert delivery.** Alerts are raised and resolved in-app; nothing is sent
   anywhere.
5. **History for our own price.** Only competitors' prices are historised — a
   feed import overwrites ours rather than versioning it.
6. **Competitor feed import.** Proposed, not built: several of these retailers
   publish licensed product feeds through affiliate networks, which would
   replace scraping them entirely. See
   [`docs/competitor-data-sources-brief.md`](docs/competitor-data-sources-brief.md).
7. **SAP Commerce integration, SSO and role-based access.** The app uses one
   shared password.

---

## Architecture

Node + TypeScript API and scraping engine, React + Vite frontend, PostgreSQL,
one npm workspace repo, deployed as a single Docker image.

### Repository layout

```
.
├── competitors/                    # One JSON file per competitor — config, not code
│   ├── ernest-jones.json           #   the only one currently enabled
│   └── … 10 more                   #   configured but unverified and disabled
├── migrations/                     # Plain SQL, applied in order on boot (001…016)
├── docs/
│   ├── competitor-verification.md  #   Per-competitor evidence record and procedure
│   └── competitor-data-sources-brief.md
├── sample-data/
├── server/src/
│   ├── config/env.ts               # All configuration from the environment
│   ├── db/                         # Pool, migrations, seed
│   ├── domain/types.ts             # Core entities (Spec §6)
│   ├── import/                     # Google feed import, tabular parsing
│   ├── matching/
│   │   ├── attributes.ts           #   Appendix A rulebook + value normalisation
│   │   ├── score.ts                #   Tiered confidence scoring
│   │   ├── sitemapDiscovery.ts     #   Rank cached URLs against a product
│   │   └── discovery.ts            #   Open candidates, score, store
│   ├── scraping/
│   │   ├── robots.ts               #   robots.txt, cached per origin, fails closed
│   │   ├── rateLimiter.ts          #   Per-domain delay + jitter + concurrency cap
│   │   ├── fetcher.ts              #   HTTP or Playwright, retry with backoff
│   │   ├── fetchAndExtract.ts      #   The escalation ladder (see below)
│   │   ├── extract.ts              #   JSON-LD first, CSS selectors as fallback
│   │   ├── blockDiagnosis.ts       #   What kind of wall, and what would clear it
│   │   ├── unblocker.ts            #   Optional paid backend — off by default
│   │   ├── sitemap.ts              #   Harvest and survey sitemaps
│   │   └── runner.ts               #   Run orchestration and per-target outcomes
│   ├── services/                   # Comparison, alerts, alert settings,
│   │                               #   scrape health, competitor verification
│   └── routes/                     # REST API
└── web/src/
    ├── styles.css                  # The design system (tokens + components)
    ├── errorKinds.ts               # One shared vocabulary for failure kinds
    ├── components/                 # Shared primitives, logos, price history chart
    └── pages/                      # Comparison, Alerts, Review, Runs, Import, Admin, Guide
```

### Data model (Spec §6)

| Table | Purpose |
| --- | --- |
| `products` | Our catalogue row. Spec attributes live in a `specs` JSONB column, so the import accepts an open set of fields. `delisted_at` marks a product no feed still lists. |
| `fascias` | Our sites — Goldsmiths (197), Mappin & Webb (439), Watches of Switzerland (470). |
| `fascia_prices` | **Our price, per site per product.** One row per `(product, fascia)`. |
| `competitors` | A monitored site plus its JSONB config, loaded from `competitors/*.json`. |
| `competitor_urls` | Cached sitemap URLs per competitor, with the path reduced to searchable words. This is the index discovery searches. |
| `product_matches` | Product ↔ competitor listing URL, with confidence, tier, evidence and confirm/reject state. A partial unique index enforces one confirmed listing per product per competitor. |
| `price_observations` | One scraped price point: price, was-price, promo, stock, source URL, which transport read it, timestamp. **This is the price-history time series.** |
| `scrape_runs` / `scrape_run_items` | A run and its per-target outcome, so failures are attributable rather than aggregate. Items carry an error kind and, for a refusal, a `block_cause`. |
| `alerts` | Open/acknowledged/resolved alerts of three types. Two partial unique indexes provide dedupe — see the decisions below. |
| `alert_settings` | Single-row table holding the thresholds. |
| `feed_imports` | One row per feed upload, for the audit trail. |
| `users` | Created for later role separation; currently one shared password. |
| `schema_migrations` | Applied migration filenames. |

---

## Architecture decisions

The reasoning behind the choices that are not obvious from the code. `CLAUDE.md`
carries the full list; these are the ones that shape the system.

### Prices are per fascia, never per product

The same watch is a different price at Goldsmiths and at Mappin & Webb, so
"our price" is meaningless without naming a site. Every page showing one carries
a site selector, and every figure — position, deltas, summaries — is measured
against that site's price. `products.our_price` was removed rather than kept as
a convenience, because it invited exactly the bug it caused: the review queue
selected it and showed NULL for every row.

### A feed is authoritative for its site

Importing a feed makes that file exactly what the site sells. Anything absent is
**delisted, not deleted** — `price_observations` cascade from `products`, so
deleting would destroy the history the app exists to collect. A person deleting
a product still deletes it; nothing automatic may.

### Discovery reads sitemaps, not on-site search

Every competitor examined disallows `/search` in robots.txt. A sitemap is
published *for* crawlers and lists the same product pages, so it is the
sanctioned route rather than a way around the block. Sitemaps are harvested
**once per run** into `competitor_urls`, then each product is ranked against
that cache using Postgres full-text search — no extension required, which
matters on managed databases. The alternative, walking the sitemap per product,
is the difference between one request and thousands.

Every product page fetch is still checked against robots.txt. Being in a
sitemap grants no exemption.

### The fetch is a three-rung ladder, cheapest first

`fetchAndExtract.ts` tries a **plain HTTP request**, escalates to a **real
browser** only when extraction fails in a way a browser could fix, and — only
if configured — falls back to a **paid unblocking service** for a genuine
refusal.

Chromium is by far the most expensive thing this app does and was the dominant
cost behind a compute-quota outage. Most retail pages publish their price in
server-rendered JSON-LD that a plain fetch reads perfectly well. A block, a 404
or a timeout is **not** escalated to a browser, because it would fail
identically and cost the launch.

### "Blocked" was hiding four unrelated problems

A rate limit is ours to fix by slowing down. A bare 403 is usually just our user
agent. A bot challenge cannot be cleared by politeness at all. A 451 or login
wall is final. `blockDiagnosis.ts` tells them apart from what the response says
about itself, stores the cause on the run item, and pairs each with its remedy.
It is deliberately conservative: an unrecognised refusal is reported as
`unclassified` rather than guessed at, because a wrong guess sends someone off
to buy a subscription to fix a config bug.

The nastiest case is a **soft block** — a challenge page served under HTTP 200.
The status is healthy and the HTML is valid, so it otherwise reads as a layout
change and someone rewrites selectors that were never wrong.

### The paid backend is opt-in and cannot run away

Unset `UNBLOCKER_PROVIDER` and nothing costs money. Configured, every guard
against spending lives in one function: it is reached only from a block, only
from a block a vendor could plausibly clear, only for **confirmed matches**
(discovery opens guesses, so unblocking one buys a maybe), and only within a
per-run ceiling. Reaching the ceiling does not fail the run — a partial scan
beats a stopped one and beats a surprise invoice.

### Extraction prefers JSON-LD to CSS selectors

Most UK retailers publish schema.org `Product`/`Offer` markup, which is far more
stable than class names. Selectors are the fallback, not the primary path.

### Failures are loud, and a wrong price is worse than no price

A competitor changing their layout must never surface as a silently wrong
figure. Extraction that cannot be trusted throws rather than storing something
plausible, and an implausible price is refused outright.

### "Not stocked" is not a failure

Most of our range is not carried by most competitors, so a competitor not
listing a product is recorded as **skipped**, never as an error. Counting it as
failure would bury the real errors under thousands of rows saying nothing more
than "they don't sell this", and would make every competitor's success rate read
as roughly 5%. Scrape health therefore counts **attempts** — ok plus error —
and never skipped.

### Postgres treats NULLs as distinct in a unique index

This silently broke dedupe for two alert types. `price_drop` and `listing_gone`
are facts about a competitor's listing rather than about one of our sites, so
they carry `fascia_id NULL` — and a NULL never equals a NULL, so the original
index gave them no dedupe at all. A second partial index covers the no-fascia
case. There is a test that fails if it is dropped.

### robots.txt is evaluated against our own identity, always

A competitor may be set to present a normal browser user agent, for sites whose
edge rules reject non-browser agents outright — on that path the fetch really
is Chromium. But robots.txt is checked against our own crawler identity
regardless. Choosing an identity to slip past a `Disallow` would be
circumvention, and this app does not do that. Nothing behind a login is read
either.

### Deployed as Docker, not Render's native Node runtime

Chromium needs system libraries absent from Render's Node image.
`playwright install --with-deps` shells out to `apt-get` as root, which
Render's build sandbox forbids. The Dockerfile starts from
`mcr.microsoft.com/playwright`, where browser and libraries are installed and
tested together.

### Migrations run on boot

`src/index.ts` applies pending migrations before the server listens, tracked in
`schema_migrations`, so re-running is a no-op and a normal deploy needs no
release step.

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

1. **Import feed** — upload a Google Shopping feed, choosing which of our sites
   it belongs to. The feed carries both products and prices; there is no
   separate catalogue importer.
2. **Admin → Can we read each competitor?** — confirm the competitor you intend
   to use can actually be read before scanning anything.
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
npm test             # Full test suite (set DATABASE_URL for the DB-backed tests)
npm run typecheck    # Typecheck both workspaces
```

> `npm test` runs the server suite with `--test-concurrency=1`. Every
> database-backed test shares one database, and two share a single row, so
> concurrent files corrupt each other's fixtures. Do not remove that flag.

---

## Deploying to Render.com

The database is an **external Postgres** (Neon, Supabase, Aiven or similar)
reached by connection string. Nothing about it is hardcoded, and no credentials
are committed.

### 1. Provision the database

Create a Postgres instance with your provider and copy its connection string:

```
postgresql://user:password@host.provider.com:5432/dbname?sslmode=require
```

Hosted providers require SSL; the pool enables it by default. Use
`sslmode=verify-full` for strict certificate verification.

### 2. Create the Render web service

**Option A — blueprint (recommended).** This repo contains `render.yaml`. In
Render: **New → Blueprint**, point it at this repository.

**Option B — manual.** **New → Web Service**, connect the repo, then set:

| Setting | Value |
| --- | --- |
| Root directory | *(leave blank — the app is at the repo root)* |
| Runtime | **Docker** |
| Dockerfile path | `./Dockerfile` |
| Health check path | `/api/health` |
| Instance type | **Starter or larger** — Chromium exceeds the free plan's memory |

There is no build or start command to set: the Dockerfile defines both.

> **Keep the image tag and the Playwright version in step.** The tag in the
> Dockerfile must match the `playwright` version resolved in
> `package-lock.json`. If they drift, scrapes fail with
> "Executable doesn't exist at …".

The first Docker build is slow; later builds reuse cached layers.

### 3. Set environment variables

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Your external Postgres connection string |
| `APP_PASSWORD` | A shared password — set this for any internet-facing deploy |
| `SESSION_SECRET` | `openssl rand -base64 32` (the blueprint generates one) |
| `NODE_ENV` | `production` |
| `SCRAPER_USER_AGENT` | **Include a real contact address** — see below |

The blueprint marks `DATABASE_URL` and `APP_PASSWORD` as `sync: false`, so set
them by hand. The server refuses to start without `DATABASE_URL`.

`PORT` is injected by Render — don't set it. Do **not** set
`PLAYWRIGHT_BROWSERS_PATH`: the Docker image already points it at the right
place. Full list in `.env.example`.

> If `APP_PASSWORD` is unset the app runs with **no login gate** and warns
> loudly in the logs on boot.

> `SCRAPER_USER_AGENT` defaults to a placeholder contact address
> (`trading@example.com`). That is useless to a retailer wanting to reach us and
> is a plausible reason to be refused outright. Setting a real one is free and
> is the first thing to try against a bare 403.

### 4. Migrations

Migrations run **automatically on every boot**. To run them by hand, from the
service's **Shell** tab:

```bash
npm run migrate:prod --workspace server   # apply pending migrations
npm run seed --workspace server           # migrate + reload competitors/*.json
```

Adding a migration means dropping a new numbered file into `migrations/`; they
apply in filename order, each in its own transaction.

### 5. After deploying

Hit `/api/health` — it reports database connectivity and whether auth is on.
Then run **Admin → Can we read each competitor?**, which is the first thing
worth knowing about a fresh deploy.

---

## Adding a competitor (config, not code)

1. Copy an existing file to `competitors/<slug>.json`.
2. Set `slug`, `displayName`, `baseUrl`, `searchUrlPattern` (must contain
   `{query}`), and the brands they stock.
3. Leave `rendering` on `auto`. It fetches over plain HTTP and starts a browser
   only for pages that need one. Pin it to `browser` if every page on the site
   needs one, so it stops paying for the failed attempt each time.
4. Leave `useJsonLd` on. Selectors are the fallback.
5. **Fill in `brands`.** An empty list means "assume they stock everything", so
   discovery opens candidates for every product in the catalogue against that
   competitor. Filling it in is the cheapest accuracy and compute win available.
6. Restart the app, or hit **Re-sync from config** on the Competitors page.
7. Verify with **Admin → Can we read each competitor?**, then tune selectors
   with **Test a product URL**.

Optional per-competitor settings: `identity` (`bot` or `browser`), `unblocker`
(`auto` or `never`), `discovery` (`sitemap` or `search`), rate limits and retry
counts.

> Re-syncing **preserves `enabled` overrides made in the Admin UI**. A
> competitor toggled off there stays off even after you set `"enabled": true` in
> the file.

### Match confidence

Scoring follows Appendix A. Gate attributes are pass/fail — brand disagreement
rejects a candidate outright. High and medium attributes contribute weighted
points, an EAN/MPN exact match scores 100 and overrides everything, and
attributes marked *ignore* (water resistance, ring size, strap length,
packaging) never discriminate — they are variants of the same product.

Matches at or above **85** auto-confirm; below that goes to the review queue. A
name-only fuzzy match can never auto-confirm. Tune the weights in
`server/src/matching/attributes.ts` once you have real data — the spec treats
them as a starting point, not the final model.

---

## Scraping conduct (Spec §9)

Built in, not bolted on:

- **robots.txt is respected** and cached per origin. If it cannot be retrieved,
  the fetch is **skipped rather than assumed permitted**. A site-declared
  `Crawl-delay` overrides ours when longer. It is always evaluated against our
  own crawler identity, never a browser string.
- **Rate limited per domain** with randomised jitter and a concurrency cap, with
  a global floor beneath whatever a competitor config says.
- **Identifies itself honestly** via `SCRAPER_USER_AGENT`.
- **Public data only.** Nothing login-gated, no personal data.
- **No defeat-of-protection logic.** A refusal is recorded, diagnosed and never
  worked around.
- **Images, fonts and media are not downloaded** — they add nothing to price
  extraction and cost the competitor bandwidth.

### Failures are loud

Every failure is typed and recorded against the run:

| Kind | Meaning |
| --- | --- |
| `robots_disallowed` | robots.txt forbids it, or could not be read |
| `blocked` | The site refused us — see the block cause below |
| `not_found` | A previously-matched listing now 404s |
| `layout_changed` | Expected product-page markers are gone — selectors need review |
| `no_price_found` | Neither JSON-LD nor selectors produced a price |
| `implausible_price` | A price outside the sane range — refused rather than stored |
| `invalid_url` | Not a usable http(s) URL |
| `timeout` / `http_error` / `navigation_failed` | Transient; retried with backoff |
| `unknown` | Unclassified — investigate rather than assume |

Prices are only ever written when extraction fully succeeds.

---

## When a site refuses us

`blocked` is recorded with a **cause**, shown per competitor in Admin → Scrape
health and in the URL tester. The remedies are unrelated, and three of the five
are free:

| Cause | What it means | What to do | Ours to fix? |
| --- | --- | --- | --- |
| `rate_limited` | We asked too fast. They will serve us | Raise `minDelayMs`, drop concurrency, spread the scan | ✅ Yes |
| `ua_or_waf` | A 403 with no challenge page — usually our identity | Set a real contact address, or the browser identity | ✅ Yes |
| `bot_challenge` | Cloudflare/DataDome/Akamai gating on *what we are* | Politeness cannot clear it — feed, or paid service | ❌ No |
| `soft_block` | A normal 200 hiding an interstitial | Not a selector problem. Compare the HTML against the page | ❌ No |
| `geo_or_legal`, `login_required` | Final | Drop the source | ❌ No |

### The optional paid backend

For a genuine gate with no licensed feed available, the app can route a blocked
request through a commercial unblocking service. **It is off unless configured**,
and configuring it is two environment variables:

```
UNBLOCKER_PROVIDER=zyte | brightdata | scrapingbee | scraperapi
UNBLOCKER_API_KEY=…
UNBLOCKER_MAX_CALLS_PER_RUN=250
```

This is a commercial and legal decision rather than a technical one and should
have sign-off, because it means paying to get past a measure a site put up
deliberately. The guards are described under
[Architecture decisions](#the-paid-backend-is-opt-in-and-cannot-run-away) and in
[`docs/competitor-verification.md`](docs/competitor-verification.md).

**The stronger route is a licensed product feed.** Several of these retailers
run affiliate programmes that publish exactly the data we are reconstructing —
see [`docs/competitor-data-sources-brief.md`](docs/competitor-data-sources-brief.md).

---

## Before going live

- [ ] **Run Admin → Can we read each competitor?** and record the results in
      `docs/competitor-verification.md`. Nothing else should be decided first.
- [ ] Fill in each verified competitor's `brands` list.
- [ ] Review each retailer's terms of use and confirm sign-off covers this
      deployment.
- [ ] Set `APP_PASSWORD` and `SESSION_SECRET`.
- [ ] Put a **real contact address** in `SCRAPER_USER_AGENT`.
- [ ] Enable competitors in small batches, checking hosting compute usage
      between each.
- [ ] Set alert thresholds in Admin. They default to zero, which alerts on any
      difference at all — a penny off a five-figure watch is not news.
- [ ] Agree a retention window for `price_observations` (§8) — nothing prunes it.

---

## API reference

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Database connectivity and auth state |
| `POST` | `/api/auth/login` \| `/logout`, `GET /session` | Shared-password session |
| `POST` | `/api/products/import-feed` | Upload a Google feed for one fascia (`?fascia=<code>`) |
| `GET` | `/api/products` \| `/:id` \| `/facets` | Catalogue browse and filter facets |
| `GET` | `/api/products/:id/history` | Observation history for one product |
| `GET` | `/api/products/:id/coverage` | Per-competitor coverage for one product |
| `POST` | `/api/products` | Add a single manual product for testing |
| `DELETE` | `/api/products/:id` \| `/api/products` | Delete a product, or the catalogue |
| `GET` | `/api/comparison` | Comparison view; filter by brand, category, competitor, position, search |
| `GET` | `/api/comparison/export.csv` | CSV export of the current view |
| `DELETE` | `/api/comparison/observations` \| `/product/:id` \| `/product/:id/competitor/:id` | Clear observations at three scopes |
| `GET` | `/api/matches` | Review queue (`?status=`, `?fascia=`) |
| `POST` | `/api/matches/:id/confirm` \| `/reject` \| `/bulk` | Resolve candidates singly or together |
| `POST` | `/api/matches` | Manually link a product to a competitor URL (verified on save) |
| `GET` | `/api/alerts` | Alerts (`?state=`, `?type=`) |
| `POST` | `/api/alerts/:id/acknowledge` \| `/acknowledge-all` | Acknowledge |
| `GET` \| `PUT` | `/api/alerts/settings` | Read and change alert thresholds |
| `GET` | `/api/competitors` | Configured competitors |
| `PATCH` | `/api/competitors/:slug` | Enable or disable one |
| `POST` | `/api/competitors/sync` | Reload `competitors/*.json` |
| `POST` | `/api/competitors/:slug/test-url` | Dry-run extraction on one URL; stores nothing |
| `GET` \| `POST` \| `DELETE` | `/api/competitors/:slug/logo` | Competitor logo |
| `POST` | `/api/competitors/refresh-logos` | Fetch missing logos (`?force=1` re-fetches all) |
| `POST` | `/api/runs` | Trigger a run (`mode`: `prices` \| `discover` \| `both`; scope by product, SKU list, or none) |
| `GET` | `/api/runs` \| `/:id` | Run history and per-target detail |
| `GET` | `/api/runs/errors/recent` | Recent scrape failures across all runs |
| `DELETE` | `/api/runs/:id` \| `/api/runs` | Delete a run, or every finished run; prices are kept |
| `GET` | `/api/admin/status` | Read-only counts and timestamps |
| `GET` | `/api/admin/fascias` | Our sites, for the fascia selectors |
| `GET` | `/api/admin/scrape-health` | Success rate and failures per competitor (`?days=7\|30\|90`) |
| `POST` | `/api/admin/verify-competitor/:slug` | End-to-end verification of one competitor |
| `POST` | `/api/admin/robots-check` | What each competitor's robots.txt permits |
| `POST` | `/api/admin/sitemap-check` | Survey the sitemaps each competitor declares |

---

## Feature notes

### Admin

**Configure → Admin** holds setup and housekeeping, separate from the monitoring
pages. Nothing on it changes a price.

- **System status** — what is actually in the database: catalogue and pricing
  counts, coverage per site, confirmed matches, observations, run history and
  applied migrations.
- **Scrape health** — per competitor over 7, 30 or 90 days: how much of what we
  asked actually worked, what is failing, which walls went up, and when each
  last produced a price. The percentage counts **attempts only**.
- **Alert thresholds** — how big a difference is worth raising an alert.
- **Can we read each competitor?** — the verification check.
- **Crawl permissions** and **Sitemaps** — what each site allows, and what it
  publishes for crawlers.
- **Test a product URL** — dry-run extraction on one page. Reports which
  transport read it and, on a refusal, what refused us and what would get past.
- **Competitor logos** — upload, replace, remove, or fetch from the retailers.

### Everything priced is per fascia

Both the comparison and the review queue carry an *Our site* selector, and every
figure is measured against that site's price. A product with no price at the
selected site reads as awaiting a price rather than silently borrowing another
site's. Admin reports coverage per site for the same reason: a single "priced"
figure cannot distinguish "every site has this" from "one site does".

### Competitor price age

Every competitor price is shown with how long ago it was seen — fresh under
three days, ageing after that, and marked stale past a fortnight. A price nobody
has checked in a month must not read as today's.

### Google Shopping feed

The feed each site sends to Google is the single source for **both product
content and price**. Upload one per fascia. A product sold by more than one site
keeps a price per site; the content is shared and refreshed by whichever feed
was imported last.

| Feed column | Used as |
| --- | --- |
| `id` | SKU (`internal_sku`) |
| `title` | Product name |
| `brand` | Brand |
| `gtin`, else `mpn` | EAN/MPN, when not damaged |
| `link` | Our product URL |
| `product_type` | Category |
| `price`, `sale_price` | The fascia's price; a sale only when genuinely cheaper |
| `price_visible=FALSE` | No price recorded — customers are not shown one |
| everything else | Spec attributes for matching |

**What it reports rather than hides:** identifiers destroyed by Excel (long
numbers as `7.32E+11` — in the first Goldsmiths feed this was 263 of 266 GTINs,
refused rather than stored), blank padding rows, repeated header rows, rows with
no title, and prices that could not be read.

### File formats and column names

`.csv`, `.tsv`, `.txt`, `.xlsx`, `.xlsm`, `.xltx` and `.xls` are accepted. The
format is identified from **magic bytes**, not the extension, because exports
routinely arrive as `.xls` that are really tab-separated text. A genuine Excel
97-2003 binary `.xls` is refused with a message saying to re-save — reading it
would mean adding SheetJS, pinned at 0.18.5 with unpatched advisories.

Headings are matched after stripping export decorations, so `Article Number*^`,
`Identifier[en]` and `Supercategories†` all match as written plainly. Where two
columns could serve the same field the earlier alias wins, and a populated
column beats an empty one.

### Competitor logos

Each competitor shows its mark beside its name; until a logo is fetched — and
permanently, for any retailer whose site offers no usable icon — a **monogram
badge** stands in, on a colour derived from the slug. The palette is restricted
to 190°–330° to stay clear of the red/green this app uses for dearer/cheaper: a
logo must never read as a price signal.

Logos are cached in our own database and served from our own origin rather than
hotlinked — which keeps the dashboard working without egress, and avoids sending
these retailers a request every time someone opens the page. Uploads are
identified by their bytes, not the declared MIME type, and served with
`default-src 'none'; sandbox` because an SVG is an active document.

### Deleting runs

Runs can be deleted individually or cleared in bulk. A run still in progress is
refused. Deleting removes the run and its detail rows; **price observations
survive** — they reference the run with `ON DELETE SET NULL`, so clearing noisy
runs never destroys price history.

### User guide

The app carries its own guide at **Help → User guide**
(`web/src/pages/GuidePage.tsx`): what each page is for, what the numbers mean,
and the failure modes worth knowing. It is written for whoever is running price
monitoring, not for a developer.

It ships with the behaviour it describes, so **it must be updated in the same
commit as any user-visible change** — see `CLAUDE.md`.

---

## Where the rest of the documentation lives

| File | What it holds |
| --- | --- |
| `CLAUDE.md` | Working notes for anyone changing this code: verification steps, and a long list of traps that have already cost time once |
| `docs/competitor-verification.md` | The per-competitor evidence record, the verification procedure, and the ranked routes for a competitor that genuinely blocks us |
| `docs/competitor-data-sources-brief.md` | A one-pager for the business on where competitor prices come from and the affiliate-feed route |
| `PLAN-1…5-*.md` | Implementation plans from a previous round of work. All five are delivered; kept for the reasoning |
| `web/src/pages/GuidePage.tsx` | The in-app user guide |
