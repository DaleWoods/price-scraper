# PLAN 5 — Test coverage for `runner.ts`, the highest-churn untested file

**Rank: 5 of 5.**
**Why:** `server/src/scraping/runner.ts` is 500 lines, orchestrates everything
(competitor concurrency, product scoping, discovery-then-prices ordering, error
classification, run counters, alert triggering) — and has **zero tests**. Compare
with the rest of the suite: `extract`, `matching`, `sitemap`, `robots`,
`feedImport`, `logos`, `discovery` rejection and the fetcher retry override all
have dedicated files.

It is also the most-modified file in the repository. In recent history alone it
gained bounded competitor concurrency, changed its product scope from a scalar
`productId` to a `productIds` array with `= ANY($n::bigint[])` SQL, and changed
its sitemap cache-reuse condition. Each of those was verified by hand, once, and
then nothing has protected them since.

Every other plan in this set touches this file: PLAN 1 changes its fetch call,
PLAN 3 reads the run items it writes, PLAN 4 adds alert hooks to its error path.
Tests here are what make those changes safe.

**Ranked last only because it delivers no user-visible value on its own** — it is
insurance, and the four items above are the product. Do it immediately after,
or alongside, PLAN 1.

---

## Goal

A DB-backed integration test file that drives real runs against local stand-in
competitor servers and asserts the orchestration contract: what gets scanned,
what gets skipped, how failures are classified, and that the counters match the
items.

---

## Files to touch

1. `server/test/helpers/standInCompetitor.ts` — **new**, reusable fake retailer.
2. `server/test/runnerScope.test.ts` — **new**, product scoping + counters.
3. `server/test/runnerOutcomes.test.ts` — **new**, per-item outcome classification.
4. `CLAUDE.md` — record the testing pattern so it is reused, not reinvented.

No production code changes. If a test cannot be written without changing
`runner.ts`, prefer changing the test — with one exception, noted at the end.

---

## Background: why this file is awkward to test

Four things make `runner.ts` resist ordinary unit testing. The plan works *with*
them rather than trying to refactor them away:

1. **`activeRunId` is module-level mutable state.** `startRun` throws if a run is
   already in flight. Tests therefore **cannot run runs in parallel** and must
   wait for each to finish. Use `node:test`'s default sequential execution within
   a file and never `Promise.all` two runs.
2. **`startRun` is fire-and-forget.** It inserts the run row, kicks off
   `executeRun` **without awaiting it**, and returns immediately with
   `status: 'running'`. A test that asserts straight after `startRun` resolves
   will read an empty run every time. You must poll.
3. **Competitors come from the database**, via `listCompetitors(true)` — there is
   no injection seam. Tests seed a real `competitors` row whose `base_url` points
   at a local HTTP server.
4. **`closeBrowser()` runs in a `finally`.** Harmless with `rendering: 'http'`
   stand-ins, but it means the process may hold a Playwright handle if any test
   ever uses `browser` mode. Keep stand-ins on `http`.

---

## Step-by-step

### Step 1 — the stand-in competitor helper

`server/test/helpers/standInCompetitor.ts`. A small `node:http` server that
serves `robots.txt`, `sitemap.xml` and product pages, with configurable
behaviour per path so a test can make a page 404, return 403, omit a price, or
serve valid JSON-LD.

```ts
import { createServer, type Server } from 'node:http';

export interface StandInProduct {
  slug: string;
  name: string;
  brand: string;
  price?: string;          // omit to serve a page with no price
  gtin?: string;
  status?: number;         // e.g. 404 or 403 to force a failure
  inStock?: boolean;
}

export interface StandIn {
  origin: string;
  requestLog: string[];
  close(): Promise<void>;
}

export async function startStandIn(products: StandInProduct[]): Promise<StandIn> { … }
```

Product page HTML must include valid schema.org JSON-LD:

```json
{
  "@type": "Product",
  "name": "…",
  "brand": { "name": "…" },
  "gtin13": "…",
  "offers": {
    "@type": "Offer",
    "price": "100.00",
    "priceCurrency": "GBP",
    "availability": "https://schema.org/InStock"
  }
}
```

> **`"@type": "Offer"` on the nested offer is mandatory.** `extract.ts` finds the
> offer node by looking for a node whose `@type` is `offer`/`aggregateoffer`. An
> offer object without it is invisible to the extractor and every test will fail
> with `no_price_found` for reasons that have nothing to do with `runner.ts`.
> This has already cost time once in this repo.

Bind to port `0` and read the assigned port off the server, so parallel test
files never collide on a hardcoded port.

### Step 2 — shared fixtures and the wait helper

In each test file's `before`, seed:

- A competitor row pointing at the stand-in, with config:
  `{"discovery":"sitemap","rendering":"http","rateLimit":{"minDelayMs":0,"jitterMs":0,"maxConcurrent":1},"retry":{"attempts":1,"backoffMs":10},"product":{"useJsonLd":true,"sanityContains":["h1"]}}`
  — zero delays keep the suite fast; `attempts: 1` stops a deliberate failure
  taking three retries.
- Products with SKUs prefixed `tst-runner-` so cleanup is a single
  `DELETE ... WHERE internal_sku LIKE 'tst-runner-%'`.

The wait helper — every test needs it:

```ts
async function runToCompletion(options: StartRunOptions): Promise<number> {
  const run = await startRun(options);
  for (let i = 0; i < 200; i += 1) {
    const { rows } = await query<{ status: string }>(
      'SELECT status FROM scrape_runs WHERE id = $1', [run.id],
    );
    if (rows[0]?.status !== 'running') return run.id;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${run.id} did not finish within 10s`);
}
```

Poll the **database**, not `getActiveRunId()` — the run row is the contract, and
`activeRunId` is cleared in a `finally` that can win the race against the final
`UPDATE`.

### Step 3 — `runnerScope.test.ts`

Assert what a run decides to look at:

1. **A `productIds` list scans exactly those products.** Seed 4 products, run
   with 3 of them, assert `scrape_run_items` contains rows for exactly those 3
   product ids and none for the 4th. *(This is the `= ANY($n::bigint[])` change
   that currently has no protection.)*
2. **A single `productId` still works** and sets `scrape_runs.product_id`, with
   `product_count` NULL.
3. **A bulk list sets `product_count` and leaves `product_id` NULL.**
4. **A full run (no scope) covers every listed product.**
5. **A delisted product is never scanned** even when named explicitly in
   `productIds` — `WHERE p.delisted_at IS NULL` comes first.
6. **`limit` caps a full run** but a scoped run ignores it.
7. **Counters match items:** `ok_count + error_count + skipped_count` equals
   `SELECT count(*) FROM scrape_run_items WHERE run_id = $1`.

### Step 4 — `runnerOutcomes.test.ts`

Assert how a run classifies what happened:

1. **A matching product produces a price.** Confirmed match → `status: 'ok'`, a
   `price_observations` row with the right price, `match_id` set.
2. **A 404 on a confirmed match** → `status: 'error'`, `error_kind: 'not_found'`.
3. **A 403** → `error_kind: 'blocked'`, and — importantly — **one request in the
   stand-in's `requestLog`**, proving a non-retryable error was not retried.
4. **A page with no price** → `error_kind: 'no_price_found'`.
5. **Brand not stocked** → competitor with `brands: ['SomeOtherBrand']` produces
   `status: 'skipped'`, `error_kind: 'brand_not_stocked'`, and **zero requests**
   in the log — the skip must happen before any network call.
6. **Discovery finding nothing** → `status: 'skipped'`, `error_kind:
   'not_listed'`.
7. **Discovery finding but rejecting** → `status: 'ok'` with an `error` string
   naming the candidate URL and the reason. *(Guards the behaviour `CLAUDE.md`
   explicitly warns must keep working — an "ok" with no explanation is the bug
   that was fixed.)*
8. **A run with no enabled competitors** completes with status `completed` and
   the "No enabled competitors" message, rather than hanging or failing.

### Step 5 — cleanup

`after` in each file must delete, in FK-safe order: `scrape_run_items`,
`scrape_runs`, `price_observations`, `product_matches`, `alerts`,
`competitor_urls`, `fascia_prices`, the products, then the competitor — and
close the stand-in server and the pool. Leaving a fake competitor enabled in the
dev database silently changes the behaviour of every later manual test.

### Step 6 — document the pattern

Add a `CLAUDE.md` bullet covering: the stand-in-competitor pattern, the
poll-the-run-row rule, the `"@type": "Offer"` requirement, and the "never run two
runs concurrently in tests" constraint from `activeRunId`.

---

## Edge cases a weaker model will get wrong

1. **Asserting immediately after `startRun` resolves.** It returns before any
   work happens. Every assertion must come after the poll. Symptom: tests that
   pass individually and fail in CI, or always see zero items.
2. **Running two runs concurrently.** `startRun` throws *"A scrape run is already
   in progress"*. `node:test` runs files in parallel by default — if two test
   files both drive runs against the same database, they will collide. Either
   keep all runner tests in **one** file, or run the suite with
   `--test-concurrency=1`, or accept and assert the guard. State the choice in a
   comment.
3. **Forgetting other enabled competitors exist.** A full run scans *every*
   enabled competitor. If the dev database has real competitors enabled, the test
   will try to reach the internet (and hang or fail on the sandbox's blocked
   egress). Always pass `competitorId` scoped to the stand-in, or disable others
   in `before` and restore in `after`.
4. **Hardcoding a port.** Use port 0 and read back the assigned port.
5. **Sitemap caching between tests.** `competitor_urls` persists, and a scoped
   run deliberately *reuses* the cache rather than re-harvesting. A test that
   changes the stand-in's sitemap between runs will read stale URLs unless it
   clears `competitor_urls` or passes `forceHarvest: true`. This is correct
   behaviour, not a bug — test it deliberately, both ways.
6. **Expecting auto-confirmation without an EAN.** A candidate only auto-confirms
   above the accept threshold; brand+name alone usually lands in *pending*. For
   a test that needs a price, insert the `product_matches` row as `confirmed`
   directly and run in `prices` mode, rather than hoping discovery confirms it.
7. **Asserting on wall-clock timing.** Do not assert "concurrency made it faster"
   — timing assertions are flaky on shared CI. If you want to prove concurrency,
   assert on *interleaving* in the stand-in's request log across two competitors,
   not on elapsed milliseconds.
8. **Alert side-effects.** `runner.ts` calls `syncUndercutAlerts` after every
   observation. A product with a `fascia_prices` row will generate alert rows —
   include `alerts` in cleanup, and be aware PLAN 4 adds more alert writes to
   this same path.

### The one permitted production change

If, and only if, testing the "no enabled competitors" path proves impossible
without it, export `executeRun` for direct invocation. Prefer not to: the public
contract is `startRun`, and testing through it is what actually protects users.

---

## Acceptance criteria

- [ ] `server/test/helpers/standInCompetitor.ts` exists and is used by both new
      test files (no duplicated fake-server code).
- [ ] All scenarios in Steps 3 and 4 are implemented as named `it(...)` cases.
- [ ] `DATABASE_URL=… npm test` passes; the server suite's test count has risen
      by at least 15.
- [ ] Tests skip cleanly (not fail) when `DATABASE_URL` is unset, matching
      `feedImportDb.test.ts`'s pattern.
- [ ] The suite passes twice in a row without manual DB cleanup in between —
      proving `after` really cleans up.
- [ ] After the suite, `SELECT count(*) FROM competitors WHERE slug LIKE 'tst-%'`
      returns 0 and no `tst-runner-%` products remain.
- [ ] Deliberately breaking one line of `runner.ts` (e.g. changing
      `p.id = ANY($2::bigint[])` back to `p.id = $2`) makes a test **fail** —
      demonstrating the tests actually bind to the behaviour they claim to.
- [ ] `CLAUDE.md` documents the pattern.
