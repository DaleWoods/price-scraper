# PLAN 1 — HTTP-first rendering, with automatic browser escalation

**Rank: 1 of 5 (do this first).**
**Why it is first:** the Render deploy is currently failing with *"Your account or
project has exceeded the compute time quota"*. Every one of the 11 competitor
configs sets `"rendering": "browser"`, so **every single page fetch launches a
Chromium context** — for robots checks' sibling fetches, sitemap-derived
candidate pages, and every price re-check. That is the dominant compute cost in
this app, and it is also a direct contradiction of the spec:

> §5.4 — "Use a lightweight HTTP fetch + HTML parser where a site allows it, and
> fall back to a full headless browser only where JS rendering is needed — it's
> slower and heavier."

Until this is fixed, every other feature burns quota faster than it needs to.

---

## Goal

Add a third rendering mode, `auto`, which fetches over plain HTTP first and
escalates to Playwright **only when the HTTP response cannot be extracted from**.
Move all competitors to `auto`. Record which mode actually produced each
observation so the saving is measurable and so a site that genuinely needs a
browser is visible rather than guessed at.

**Non-goal:** do not remove `browser` or `http` modes. Both stay valid explicit
choices; `auto` becomes the default for new competitors.

---

## Background you need before touching anything

- `server/src/scraping/fetcher.ts` already supports both transports cleanly.
  `fetchPage()` picks between `httpFetch()` and `browserFetch()` on
  `competitor.config.rendering === 'http'`. `FetchedPage` already carries a
  `renderedWith: 'http' | 'browser'` field that nothing currently reads.
- `server/src/scraping/extract.ts`'s `extractListing()` is the *only* thing that
  knows whether a fetched page was usable. It throws a typed `ScrapeError` with
  kind:
  - `layout_changed` — none of `config.product.sanityContains` selectors matched.
  - `no_price_found` — page looked right but no price in JSON-LD or selectors.
  These two kinds are exactly the escalation triggers. Any other kind
  (`blocked`, `not_found`, `robots_disallowed`, `timeout`, …) must **not**
  escalate — see edge cases.
- There are exactly **four** places that pair a fetch with an extract:
  | File | Lines (approx) | Purpose |
  | --- | --- | --- |
  | `server/src/scraping/runner.ts` | 294–295 | price re-check of a confirmed match |
  | `server/src/matching/discovery.ts` | 195–196 | opening a candidate during discovery |
  | `server/src/routes/matches.ts` | 223–224 | re-test a match's URL |
  | `server/src/routes/competitors.ts` | 183–184 | Admin → "Test a product URL" |

---

## Files to touch (in this order)

1. `server/src/domain/types.ts` — widen the `rendering` union.
2. `server/src/scraping/competitorRegistry.ts` — widen the zod enum.
3. `server/src/scraping/fetcher.ts` — add `fetchAndExtract()`.
4. `server/src/scraping/runner.ts` — use it (and store `rendered_with`).
5. `server/src/matching/discovery.ts` — use it.
6. `server/src/routes/matches.ts` — use it.
7. `server/src/routes/competitors.ts` — use it, and surface the mode in the response.
8. `migrations/014_observation_rendered_with.sql` — new file.
9. `competitors/*.json` — all 11 files.
10. `server/test/fetchAndExtract.test.ts` — new file.
11. `web/src/pages/AdminPage.tsx` — show the rendering mode in the test-URL result.
12. `web/src/api.ts` — type for the new response field.
13. `web/src/pages/GuidePage.tsx` + `CLAUDE.md` — docs (mandatory, see step 12).

---

## Step-by-step

### Step 1 — widen the type

`server/src/domain/types.ts`, in `CompetitorConfig`:

```ts
  /**
   * 'http' uses fetch + cheerio; 'browser' uses Playwright for JS-rendered
   * pages; 'auto' tries HTTP first and escalates to the browser only when the
   * HTTP response cannot be extracted from (Spec §5.4).
   */
  rendering: 'http' | 'browser' | 'auto';
```

### Step 2 — widen the schema

`server/src/scraping/competitorRegistry.ts`, in `competitorConfigSchema`:

```ts
  rendering: z.enum(['http', 'browser', 'auto']).default('auto'),
```

Note the default changes from `'browser'` to `'auto'` — a competitor JSON that
omits `rendering` now gets the cheap path.

### Step 3 — add `fetchAndExtract()` to `fetcher.ts`

Add at the end of `server/src/scraping/fetcher.ts`. Import `extractListing` and
`ExtractedListing` from `./extract.js`.

> **Import direction check:** `extract.ts` currently imports `FetchedPage` from
> `fetcher.ts`. Importing `extractListing` back into `fetcher.ts` creates a
> cycle. **Do not do that.** Put `fetchAndExtract` in a NEW file
> `server/src/scraping/fetchAndExtract.ts` which imports from both. Nothing
> imports it back, so there is no cycle.

```ts
import type { Competitor } from '../domain/types.js';
import { logger } from '../lib/logger.js';
import { extractListing, type ExtractedListing } from './extract.js';
import { ScrapeError } from './errors.js';
import { fetchPage, type FetchPageOptions, type FetchedPage } from './fetcher.js';

/** Extraction failures that mean "we fetched the wrong shape of HTML", not "the site said no". */
const ESCALATABLE = new Set(['layout_changed', 'no_price_found']);

export interface FetchAndExtractResult {
  page: FetchedPage;
  listing: ExtractedListing;
  /** True when the HTTP attempt was unusable and Playwright was needed. */
  escalated: boolean;
}

/**
 * Fetch a page and extract a listing from it, escalating to a real browser only
 * when a plain HTTP fetch produced HTML we could not read a price out of.
 *
 * Chromium is the single most expensive thing this app does, and most retail
 * product pages publish their price in server-rendered JSON-LD that a plain
 * fetch can see perfectly well (Spec §5.4).
 */
export async function fetchAndExtract(
  competitor: Competitor,
  url: string,
  options: FetchPageOptions = {},
): Promise<FetchAndExtractResult> {
  const mode = competitor.config.rendering ?? 'auto';

  if (mode !== 'auto') {
    const page = await fetchPage(competitor, url, options);
    return { page, listing: extractListing(competitor, page), escalated: false };
  }

  // First attempt: plain HTTP, by overriding the competitor's rendering for
  // this call only. The competitor object is not mutated — a shallow copy with
  // an overridden config is passed down instead, because the same object is
  // shared across concurrent competitor scans.
  const asHttp: Competitor = {
    ...competitor,
    config: { ...competitor.config, rendering: 'http' },
  };

  try {
    const page = await fetchPage(asHttp, url, options);
    return { page, listing: extractListing(competitor, page), escalated: false };
  } catch (err) {
    const kind = err instanceof ScrapeError ? err.kind : 'unknown';
    if (!ESCALATABLE.has(kind)) throw err;

    logger.info(
      'fetch',
      `[${competitor.slug}] HTTP fetch of ${url} was not extractable (${kind}); escalating to browser`,
    );
  }

  const asBrowser: Competitor = {
    ...competitor,
    config: { ...competitor.config, rendering: 'browser' },
  };
  const page = await fetchPage(asBrowser, url, options);
  return { page, listing: extractListing(competitor, page), escalated: true };
}
```

### Step 4 — migration for the recorded mode

Create `migrations/014_observation_rendered_with.sql`:

```sql
-- Which transport actually produced this price. Chromium is the most expensive
-- thing this app does, so 'auto' mode needs to be measurable: a competitor
-- whose observations are all 'http' never needs a browser, and one that is
-- always 'browser' is worth pinning explicitly rather than paying for a failed
-- HTTP attempt before every fetch.
ALTER TABLE price_observations
    ADD COLUMN IF NOT EXISTS rendered_with TEXT;
```

### Step 5 — use it in `runner.ts`

In `scrapeConfirmedMatches()` replace:

```ts
      const page = await fetchPage(competitor, match.competitor_url);
      const listing = extractListing(competitor, page);
```

with:

```ts
      const { page, listing } = await fetchAndExtract(competitor, match.competitor_url);
```

Then add `rendered_with` to the `INSERT INTO price_observations` statement in the
same function: add `rendered_with` to the column list, `$12` to the VALUES list,
and `page.renderedWith` to the parameter array. **Count the existing placeholders
before editing** — there are currently 11 (`$1`–`$11`); the new one is `$12`.

Remove the now-unused `extractListing` import if nothing else in the file uses it
(`fetchPage` may still be used elsewhere — check before deleting either import).

### Step 6 — use it in `discovery.ts`

Replace lines ~195–196:

```ts
      const page = await fetchPage(competitor, result.url, { maxAttempts: 1 });
      const extracted = extractListing(competitor, page);
```

with:

```ts
      const { listing: extracted } = await fetchAndExtract(competitor, result.url, {
        maxAttempts: 1,
      });
```

`{ maxAttempts: 1 }` must be preserved — see edge cases.

### Step 7 — use it in the two routes

`server/src/routes/matches.ts` (~223) and `server/src/routes/competitors.ts` (~183):
same substitution. In `competitors.ts` (the Admin "Test a product URL" panel),
also return the transport in the JSON response so a human can see it:

```ts
    const { page, listing, escalated } = await fetchAndExtract(competitor, url);
    // ... existing response object, plus:
    renderedWith: page.renderedWith,
    escalated,
```

### Step 8 — flip the competitor configs

In all 11 files in `competitors/`, change `"rendering": "browser"` to
`"rendering": "auto"`. Do it with a single pass so none is missed:

```bash
cd /workspace/price-scraper
sed -i 's/"rendering": "browser"/"rendering": "auto"/' competitors/*.json
grep -c '"rendering": "auto"' competitors/*.json   # every file must print 1
```

Then re-sync so the database picks the change up (the DB holds a copy of each
config):

```bash
curl -s -X POST http://localhost:3001/api/competitors/sync | head -20
```

### Step 9 — test

Create `server/test/fetchAndExtract.test.ts`. Use `node:test` + a real
`node:http` stand-in server on a spare port (follow the shape of
`server/test/sitemap.test.ts` for how a local server is stood up and torn down).
Cover, at minimum:

1. **HTTP-extractable page is never escalated.** Serve a page with valid JSON-LD
   including `"@type": "Offer"`. Assert `escalated === false` and
   `page.renderedWith === 'http'`.
2. **A non-escalatable error propagates unchanged.** Serve HTTP 403. Assert the
   thrown error's `kind` is `'blocked'` and that no browser was launched.
3. **`rendering: 'http'` and `rendering: 'browser'` still bypass the auto path.**
4. **The competitor object is not mutated.** Call `fetchAndExtract` with an
   `auto` competitor and assert `competitor.config.rendering === 'auto'`
   afterwards.

Do **not** write a test that asserts an actual Chromium escalation — launching
Playwright in the unit suite is slow and the sandbox has no outbound network.
Escalation is verified manually in step 10.

### Step 10 — verify manually

```bash
cd /workspace/price-scraper
service postgresql start
export DATABASE_URL="…"   # your local dev database, per .env.example
npm run typecheck --workspace server && npm run typecheck --workspace web
npm run build
npm test
```

Then stand up a local stand-in competitor that serves JSON-LD over plain HTTP,
register it as a competitor with `"rendering": "auto"`, seed one matching
product, run a scan, and confirm:

```sql
SELECT rendered_with, count(*) FROM price_observations GROUP BY 1;
```

returns `http` — proving the cheap path was used end to end and no Chromium was
started. **Delete every fixture row and the stand-in competitor afterwards.**

### Step 11 — docs (mandatory)

`CLAUDE.md` has a standing rule: *any change a user can notice must update
`web/src/pages/GuidePage.tsx` in the same commit, and bump `GUIDE_UPDATED`.*
This change is user-noticeable (scans get faster; the Admin test-URL panel gains
a line). So:

- `GuidePage.tsx` — in the **Scrape runs** `<Term>`, add a sentence: scans now
  read a competitor's page over plain HTTP where that works and only start a
  real browser when the page needs one, which is most of why a run is quicker.
  Bump `GUIDE_UPDATED` to today's date.
- `CLAUDE.md` — add a "Facts worth not rediscovering" bullet recording: why
  `auto` exists (the Render compute-quota outage), that escalation is keyed on
  exactly two `ScrapeError` kinds, that the competitor object must not be
  mutated because it is shared across concurrent scans, and that
  `price_observations.rendered_with` is how you check whether a competitor
  actually needs a browser.

---

## Edge cases a weaker model will get wrong

1. **Escalating on the wrong error kinds.** `blocked` (403/429), `not_found`
   (404), `robots_disallowed`, `timeout` and `navigation_failed` must **never**
   escalate. Retrying a block with a browser is exactly the "work around the
   block" behaviour the spec forbids (§9), and retrying a 404 with Chromium
   doubles the cost of the single most common failure. Only `layout_changed` and
   `no_price_found` mean "wrong shape of HTML, a browser might genuinely help".
2. **Mutating the shared `competitor` object.** `runCompetitor` runs up to three
   competitors concurrently and the same `Competitor` object is reused across
   every product for that competitor. Writing `competitor.config.rendering =
   'http'` would race across concurrent work and permanently corrupt the config
   in memory. Always pass a shallow copy.
3. **Double-charging the rate limiter.** An escalation makes *two* requests to
   the same host. `withRateLimit` is applied inside `fetchPage`, so both attempts
   are correctly spaced — do not try to "optimise" by hoisting the rate limit
   out. Slower and correct beats fast and rude.
4. **Losing `maxAttempts: 1` in discovery.** Discovery deliberately opens an
   unproven candidate exactly once (see `CLAUDE.md`). If the option is dropped
   during refactoring, an `auto` competitor now costs up to 3 HTTP attempts × 3
   browser attempts per candidate. Keep it, and note it applies to *each* leg.
5. **The `renderedWith` field on an escalated result.** Return the *final*
   page's `renderedWith` (`'browser'`), not the first attempt's. The recorded
   value must say what actually produced the price.
6. **Placeholder renumbering in the `price_observations` INSERT.** Adding a
   column means adding `$12`. Miscounting silently shifts every parameter and
   writes garbage into the wrong columns. Count them.
7. **`sanityContains` is optional.** If a competitor config has no
   `product.sanityContains`, `extractListing` skips the layout check entirely, so
   the only escalation trigger left is `no_price_found`. That is correct — do not
   invent an extra check.
8. **The re-sync step is easy to forget.** Competitor configs are *copied into
   the database*; editing the JSON alone changes nothing at runtime until
   `POST /api/competitors/sync` runs. A change that "does nothing" is almost
   always this.

---

## Acceptance criteria

- [ ] `npm run typecheck` passes for both workspaces; `npm run build` succeeds.
- [ ] `npm test` passes with `DATABASE_URL` set, including the new
      `fetchAndExtract.test.ts`, and the total test count has gone **up**.
- [ ] `grep -c '"rendering": "auto"' competitors/*.json` prints `1` for all 11 files.
- [ ] A local stand-in competitor serving plain-HTTP JSON-LD produces a price
      observation with `rendered_with = 'http'`, and no Chromium process appears
      in `ps aux` during that run.
- [ ] A stand-in that serves a price only via JavaScript still produces a price,
      with `rendered_with = 'browser'` and an `escalating to browser` line in the
      server log.
- [ ] A stand-in returning HTTP 403 fails as `blocked` with **one** request in
      its access log, not two.
- [ ] `GUIDE_UPDATED` is bumped and the Scrape runs section mentions the change.
- [ ] Every test fixture (products, competitors, runs, observations) is deleted
      afterwards: `SELECT count(*) FROM products;` returns the same number as
      before you started.
