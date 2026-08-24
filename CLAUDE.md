# Working on this project

## Keep the user guide current

The in-app user guide lives at `web/src/pages/GuidePage.tsx` (Help → User guide).
It is written for whoever runs price monitoring, not for a developer.

**Any change a user can notice must update the guide in the same commit.** That
includes:

- a new or removed page, tab or button
- a change to what a number, badge or status word means
- a change to what a file must contain, or how an import behaves
- a new failure mode worth warning about, or an old one that no longer applies

Also bump the `GUIDE_UPDATED` constant at the top of that file, which is shown at
the foot of the page so staleness is visible rather than assumed.

If a change is purely internal — a refactor, a query rewritten, a test added —
the guide does not need touching. Say so rather than editing it for the sake of
it.

Keep the register plain and factual. Explain what something means to someone
using it, not how it is implemented. The "Things that will bite you" section is
for problems that have actually happened, with the real numbers.

## Verifying work

- Both workspaces must typecheck and build: `npm run build`.
- `npm test` runs the unit suite. Database-backed tests skip unless
  `DATABASE_URL` is set; run them with it set before claiming an import or query
  change works.
- For anything user-visible, drive the real app in a browser rather than
  trusting the build. Full-page screenshots misrepresent sticky elements — check
  the scrolled state instead.
- Clear test fixtures out of the database when finished. Leaving fake products
  or fake logos behind is worse than not testing.

## Facts worth not rediscovering

- **Prices are per fascia**, never per product. Goldsmiths (197), Mappin & Webb
  (439) and Watches of Switzerland (470) each carry their own price for the same
  SKU. Anything showing "our price" must join `fascia_prices` for a chosen site.
- **A Google feed is authoritative for its site.** Importing one delists
  anything absent from it. An *import* marks products delisted and never deletes
  them: `price_observations` cascade from `products`, so deleting destroys the
  price history the app exists to collect. A *person* asking to delete a product
  does delete it — that is how test data gets cleared — but nothing automatic
  may.
- **`products.source` is `feed` or `manual`.** A manual product was typed in on
  Scrape runs to test with, so feed delisting skips it: no feed will ever mention
  it, and applying the feed's authority would delete the fixture mid-test.
- **Every competitor disallows `/search`** in robots.txt. Discovery reads the
  sitemaps they publish for crawlers instead. Fetches are always checked against
  robots.txt first, and a site that actively blocks us is a source to drop, not
  a block to work around.
- **Excel destroys the feeds.** Long numbers arrive as `7.32E+11`, timestamps as
  `00:00.0`. Refuse damaged identifiers rather than storing them, and report the
  count so the export can be fixed at source.
- **A discovery run item can say "ok" and still have matched nothing.** "OK"
  means nothing went wrong technically, not that a price was recorded — a
  candidate can be found, opened, and rejected (brand not identified, a
  different EAN, too little in common) and that is still "ok". Without a
  reason attached this looked identical to nothing having been found at all,
  which is what `discovery.ts`'s `bestAttempt`/`rejectionReason` and the
  detail text in `runner.ts` exist to fix. Keep populating that detail on any
  future change to the discovery loop — an "ok" with no explanation is the bug
  this fixed.
- **A single-product run reuses cached sitemap URLs; it does not re-harvest.**
  `refreshCompetitorUrls` used to run unconditionally for every enabled
  competitor on every discovery pass. Beaverbrooks alone caches 15,000+ URLs,
  so testing one SKU against "all enabled" meant walking every competitor's
  full sitemap tree first — a run that should answer one question in seconds
  took minutes and read as hung. `runner.ts` now skips the harvest when
  `productId` is set and something is already cached for that competitor,
  unless `forceHarvest` is passed. A full run (no product named) always
  harvests fresh — that is what keeps the cache current for everyone else, so
  do not extend the skip to that path.
- **A discovery candidate is opened once, not retried, and the whole
  competitor has a time budget.** This followed a real production incident:
  a single-product run took 8+ minutes and Render restarted the app because
  its health check (`GET /api/health`, `await query('SELECT 1')`) stopped
  getting answered — likely Chromium contending for CPU on a small instance
  while discovery burned through three candidates × three retries × a 30s
  timeout, per competitor. `fetchPage` now takes an optional `maxAttempts`
  (see `FetchPageOptions`); `discovery.ts` passes `{ maxAttempts: 1 }` for
  every candidate it opens, because an unproven URL guess doesn't deserve the
  same retry budget as a confirmed match's price re-check (which still uses
  the competitor's configured retry policy — do not change that call).
  `discovery.ts` also tracks `DISCOVERY_BUDGET_MS` (60s) across the candidate
  loop; it only stops the *next* candidate from starting, so the true worst
  case is the budget plus one more in-flight request timeout, not a hard
  ceiling — don't describe it as one. Verified against stand-in competitors:
  three unresponsive candidates went from ~369s observed in production down
  to ~64s with these two changes together.
- **A non-JSON API response must never be shown to the user verbatim.**
  `web/src/api.ts`'s `request()` used to fall back to `{ error: text }` when
  a response failed to parse as JSON — which meant a platform's own error
  page (Render's "Bad Gateway" HTML, a Cloudflare block page) was rendered
  whole inside an `<Alert>`, tags and inline CSS included. It now logs the
  real body to the console and shows a short, fixed message naming the HTTP
  status instead. Keep it that way if `request()` is touched again.
- **Undercut alerts are per (product, competitor, fascia) and self-resolving.**
  `services/alerts.ts`'s `syncUndercutAlerts` runs after every price
  observation and checks it against *every* fascia that prices the product —
  one observation can open an alert for Goldsmiths and not Mappin & Webb.
  `state` is `open` / `acknowledged` / `resolved`, not just the two the table
  shipped with in 001_init.sql: `resolved` means the system found the
  undercut no longer holds; `acknowledged` means a person dismissed it while
  it may still be true. A partial unique index (`alerts_open_undercut_idx`,
  `WHERE state = 'open'`) is the dedupe — the same still-cheaper price
  observed again is a no-op, not a second alert. Deleting a comparison by
  hand (`comparison.ts`'s three DELETE routes) resolves the matching alerts
  too, via `resolveAlertsForPair` / `resolveAlertsForProduct` /
  `resolveAllOpenAlerts` — an open alert with its underlying price deleted
  out from under it is worse than no alert.
- **The price-history chart has no history for our own price.** `fascia_prices`
  is overwritten on every feed import (`UNIQUE (product_id, fascia_id)`,
  `ON CONFLICT ... DO UPDATE`) — there has never been anywhere our own price's
  past values were kept. `PriceHistoryChart` draws competitors as real lines
  from `price_observations` and our price as a dashed *current-value*
  reference line. Do not fabricate a historical line for it; if that history
  is ever wanted, it needs its own table, not a reinterpretation of this one.
- **Out-of-stock is checked separately from `price_visible`, on the same
  footing.** Reported directly against a real Mappin & Webb export: 93 of 99
  rows were "out of stock" but all had `price_visible=TRUE`, and
  `feedImport.ts` only ever checked that flag — every one of those 93 got
  priced and compared anyway. `isInStock()` now gates price-writing
  alongside the `price_visible` check, treating anything not recognised as an
  in-stock value (`out of stock`, `preorder`, `backorder` after
  normalisation) the same way: no price row, so the product falls out via the
  existing "no price anywhere = discontinued" delisting path rather than
  needing one of its own. An unrecognised `availability` string fails open
  (still priced) rather than breaking the import — see the "fails open" test
  in `feedImportDb.test.ts` before tightening that set.
- **A competitor scan runs up to three competitors concurrently, not one at a
  time.** `runner.ts`'s `executeRun` used to loop over enabled competitors
  sequentially; with every competitor config on `rendering: "browser"` and a
  5-8s per-request rate limit, a run against several competitors took the
  *sum* of all of them. `mapWithConcurrency` now runs `runCompetitor` for up
  to `COMPETITOR_CONCURRENCY` (3) competitors at once — each competitor's own
  requests are still fully sequential and rate-limited exactly as before,
  this only overlaps *different* competitors' waits. Bounded rather than
  unbounded deliberately: this is the same Chromium-contention failure mode
  already documented above (the 8-minute run that got the app restarted
  mid-scrape) — running every enabled competitor's browser at once on a
  small deployment would risk repeating it. Verified against three stand-in
  competitors each with an artificial 2s-per-request delay: a run against all
  three completed in ~6s (≈ one competitor's own sequential total), not the
  ~18s three of them would take one after another.
- **Competitor coverage for one product is computed fresh, not stored.**
  `services/comparison.ts`'s `getProductCoverage` drives the product drawer's
  coverage table: for every *enabled* competitor it resolves one status by
  checking, in order, (1) the latest `price_observations` row — priced; (2)
  the latest `product_matches` row's status — confirmed-awaiting-price,
  pending-review, or rejected; (3) the competitor's configured `brands` list
  against the product's brand — not-stocked, before ever looking at run
  history, since a brand-restricted competitor's discovery never even runs
  for that product; (4) the latest `scrape_run_items` row for that
  (product, competitor) pair — not-listed, error, or rejected (found
  candidates, nothing cleared the confidence bar so no match row exists);
  (5) otherwise not-scanned. Keep that order if this is touched — a contrived
  test that skips straight to inserting a `scrape_run_items` row for a
  brand-restricted competitor will read as not-stocked, not whatever the
  test row says, and that is correct: real discovery never produces a run
  item for a brand it was never asked to check.
- **Scanning by our product URL matches `our_product_url` verbatim, modulo a
  trailing slash.** `POST /api/runs`'s `productUrl` field (used when the SKU
  field is empty) does `rtrim(our_product_url, '/') = rtrim($1, '/')` — no
  other normalisation. This is deliberate: the value comes straight from the
  feed's `link` column and the box asks for a URL copied from our own site,
  so anything more forgiving (case-folding, query-string stripping) would
  risk matching the wrong product rather than being a convenience. A URL not
  in the last imported feed returns 404 with a message saying so, the same
  pattern as an unknown SKU.
