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
- **Price age is coloured at 3 and 14 days, client-side only.**
  `components/ui.tsx`'s `PriceAge` (backed by `priceAgeTone`) turns a
  competitor's "Seen" figure amber from 3 days old and bold red from 14 —
  chosen because there is still no scheduler: a price is only as fresh as
  the last manual run, so staleness needs to be visible everywhere a price
  is shown, not just inferred. It is
  purely a display computation against `observedAt`/`Date.now()` — nothing
  is stored or computed server-side, so there is no cache to invalidate and
  no migration needed if the thresholds change. Only applied where a price
  actually exists: the drawer's coverage table deliberately falls back to a
  plain, uncoloured `lastScannedAt` for a competitor with no price recorded,
  since an old *attempt* is not the same claim as an old *price*.
- **A run's product scope is one list internally, `productIds: number[] | null`
  — `productId` only exists at the API boundary for backward compatibility.**
  `runner.ts`'s `startRun` normalises `options.productId` and the newer
  `options.productIds` into a single list before anything else touches it;
  every SQL query downstream (`discoverUnmatchedProducts`,
  `scrapeConfirmedMatches`) filters with `p.id = ANY($n::bigint[])`, not a
  scalar `=`. `scrape_runs.product_id` (a single FK) is only set when that
  list has exactly one entry, so the existing single-product test UI keeps
  working unchanged; a longer list sets `product_count` instead (added in
  012_bulk_product_scope.sql) purely for the Recent runs list to say "47
  products" rather than looking like an untargeted full run. Nothing stores
  the actual list beyond the run — it doesn't need to: `scrape_run_items`
  already records which products a run touched, same as every other run.
  A bulk list is resolved from uploaded SKUs the same way a single SKU is
  (case-insensitive, against currently-listed products) but partially: an
  unmatched SKU is reported back in the response rather than failing the
  whole request, since the rest of the list is still worth scanning — unlike
  a single unknown SKU, which still 404s outright.
- **`getComparison`'s summary tiles and position filter used to only see one
  page of the catalogue, not the whole filtered set.** The products query
  carried the request's `LIMIT`/`OFFSET` directly, so `summarise(rows)` and
  the `position` filter — both computed from that same paginated `rows`
  array — silently missed anything past the page. A catalogue bigger than
  the frontend's 200-row request had the "they are cheaper" stat tile
  undercounting past the first 200 (alphabetically by brand/name), and
  filtering to `position=higher` could hide a genuine undercut on product
  #350 entirely. Fixed by decoupling paging from filtering: the products
  query now always fetches the whole filtered set up to `PRODUCT_SAFETY_CAP`
  (5000 — a ceiling against a pathological query, not a real page size), and
  `limit`/`offset` are applied with `.slice()` as the very last step, after
  `summary` and the position filter have both already seen everything.
  `/export.csv` used to reuse this same page-limited path with a hardcoded
  `limit: 500` (so a bigger catalogue's CSV export was silently incomplete,
  too) — it now passes no limit at all, which this function treats as "give
  me everything the safety cap allows."
- **Undercut alerts and the Comparison page used to compute `deltaPct`
  against different reference prices for the identical £ gap.**
  `alerts.ts`'s `raiseAlert` divided by our own price; `comparison.ts`
  divided by the competitor's price — same £100-vs-£80 gap read as 20% on
  the Alerts page and 25% on Comparison. `comparison.ts` now exports
  `priceDelta(ourPrice, competitorPrice)` as the one place this is computed,
  always relative to our price ("they are 20% cheaper than us" means 20% of
  what we charge), and both call sites use it — a future third consumer
  should too, rather than reimplementing the formula again.
- **The same `internal_sku` sold at more than one fascia only had one shared
  `products.our_product_url`.** Every feed import overwrote it
  unconditionally (`ON CONFLICT ... SET our_product_url = EXCLUDED...`), so
  whichever fascia's feed was imported last silently won — pasting an
  earlier-imported site's own product URL into "Scan by URL" 404'd even
  though it came straight from that site's feed, because the column no
  longer held it. `fascia_prices.product_url` (013_fascia_product_url.sql)
  is now the correct, per-fascia value, written alongside price on every
  import; `products.our_product_url` stays as a fallback for a product with
  no `fascia_prices` row at all (out of stock, or added by hand) rather than
  being removed outright. `routes/runs.ts`'s URL lookup and the `comparison`/
  `matches` SELECTs all check the per-fascia column first now. See the
  "keeps a separate product URL per fascia for the same SKU" test in
  `feedImportDb.test.ts` before changing this again.
- **`textSupports` in `matching/score.ts` built a `RegExp` straight from a
  normalised attribute value without escaping it.** `normaliseCaseSize`
  returns a literal decimal point for a size like "40.5", and an unescaped
  `.` in a regex matches *any* character — a title containing "40X5mm" would
  have wrongly counted as agreeing with a case size of "40.5mm". Fixed with
  a small `escapeRegExp` used only for that interpolation; the deliberate,
  intentional pattern-building elsewhere (`normaliseColour`'s
  `word.replace(/_/g, '\\s*')`, matching whitespace-flexibly against a fixed
  set of known synonym words, not attacker- or catalogue-controlled data) is
  a different case and was left alone.
- **A comparison row's full per-competitor price breakdown was computed and
  serialised for every product on every request, but nothing has read it
  since the drawer got its coverage table.** `getComparison` used to return
  `competitorPrices` (every competitor's price, position and delta for that
  product) on each `ComparisonRow` — needed once to build the old drawer
  section, now only used internally to pick the cheapest purchasable
  competitor for `bestCompetitorPrice` and friends. The array is still built
  (that reduction needs it) but no longer put on the object returned to
  callers, cutting the JSON response and the CSV-export computation down to
  what is actually used. `CompetitorPrice` (`web/src/api.ts`) and the
  matching nested type in `server/src/domain/types.ts` were removed with it
  — if a future feature needs a specific competitor's price on a comparison
  row again, prefer sourcing it from `getProductCoverage`
  (`services/comparison.ts`), which already exists for exactly that.
- **Rendering is HTTP-first: `auto` fetches over plain HTTP and escalates to
  Chromium only on two specific extraction failures.** Every competitor config
  used to say `rendering: "browser"`, so every page fetch launched a browser
  context — the dominant compute cost, and what took the Render deploy over its
  compute-time quota. Spec §5.4 always asked for the opposite. `auto` (now the
  schema default) lives in `scraping/fetchAndExtract.ts`, which is a separate
  module *because* `extract.ts` imports `FetchedPage` from `fetcher.ts` —
  pairing them anywhere else is an import cycle. Three rules it must keep:
  (1) escalate **only** on `layout_changed` and `no_price_found`. A `blocked`
  403 escalated is working around a refusal (Spec §9); a `not_found` escalated
  doubles the cost of the commonest failure; a timeout escalated pays twice to
  fail. (2) Never mutate `competitor.config.rendering` — the same object is
  shared across every product for that competitor and three competitors run
  concurrently, so it is copied per attempt instead. (3) A bare `fetchPage`
  call resolves `auto` to the browser, because only a caller that also extracts
  can judge whether cheap HTML was usable; `discovery.ts`'s search path relies
  on that. `price_observations.rendered_with` records what actually produced
  each price, so "does this competitor really need a browser" is a query rather
  than a guess.
- **`scrape_run_items.status` has three values and only two of them are an
  attempt.** Anything computing a rate from that table must know:
  `ok` = we asked and it worked; `error` = we asked and it failed;
  `skipped` = **we never asked** (the competitor does not stock the brand, or
  nothing in their sitemap resembled the product). Most of our range is not
  carried by most competitors, so `skipped` is the normal majority outcome by a
  wide margin — including it in a denominator makes a healthy competitor read
  as single-digit percent and produces a dashboard nobody believes.
  `services/scrapeHealth.ts` is the reference implementation: attempts are
  `ok + error`, `robots_disallowed` is counted separately because honouring a
  site's rules is policy rather than breakage, and a competitor with zero
  attempts returns `successPct: null` (rendered "not scanned") because never
  tried and tried-and-always-failed are opposite states. Two more traps in that
  query: the window filter belongs in the `LEFT JOIN ... ON` clause, since in a
  `WHERE` clause it silently becomes an inner join and drops exactly the quiet
  competitors you most need to see; and an `ok` discovery item is not proof a
  price was recorded (a candidate can be found, opened and rejected), so the
  column is labelled "worked", not "priced".
- **`ERROR_KIND_COPY` lives in `web/src/errorKinds.ts` and nowhere else.** It is
  shared by the run-detail table and the scrape-health card. A second copy
  drifts, and then one failure reads as two different things depending which
  page you are on.
- **Postgres treats NULLs as DISTINCT in a unique index, which silently broke
  dedupe for the two non-fascia alert types.** `alerts_open_undercut_idx`
  covers `(type, product_id, competitor_id, fascia_id) WHERE state = 'open'`.
  `price_drop` and `listing_gone` are facts about a competitor's own listing
  rather than about one of our sites, so they carry `fascia_id NULL` — and a
  NULL never equals a NULL, so that index (and any `ON CONFLICT` targeting it)
  provides them **no dedupe at all**: every run would insert another copy of
  the same still-true open alert, forever. `alerts_open_no_fascia_idx`
  (015_alert_settings_and_types.sql) is the partial unique index that actually
  covers them, and `insertAlert` in `services/alerts.ts` targets *that* index's
  column list. There is a test for exactly this ("raises exactly one
  listing_gone however many runs report it") — dropping the index makes four
  tests fail, which is how it should be.
- **The two undercut thresholds are ANDed, and both default to 0.** Spec §5.5
  words it as "by more than X% (or £Y)", which reads like OR, but AND with
  zero defaults is the reading that is safe either way: both at zero preserves
  the old alert-on-anything behaviour exactly, and setting one applies only
  that one. The Admin form and the guide both say so explicitly, because two
  fields side by side otherwise read as OR. Raising a threshold **resolves**
  open alerts that no longer qualify rather than stranding them.
- **`inStock === null` means the page did not say, and must not raise
  `listing_gone`.** Plenty of sites never publish availability; alerting on
  unknown would fire constantly. Only an explicit `false` counts. Every alert
  call in `runner.ts` is also `.catch()`-wrapped and logged: a failed alert
  write must never lose a price that was scraped successfully.
- **`syncPriceDropAlert` compares against `OFFSET 1`, not the latest
  observation.** By the time alerts run, the new observation has already been
  inserted — comparing to "the most recent" compares the price to itself and
  never fires. It also returns early when there is no previous price, since a
  first sighting is not a drop from zero.
- **Runner tests talk to a real local site, because `runner.ts` has no
  injection seam.** Competitors come from the database and are reached over
  HTTP, so `server/test/helpers/standInCompetitor.ts` starts a stand-in
  retailer (robots.txt, sitemap, product pages) on port 0 and the test inserts
  a competitor row pointing at it. Four things about that helper are load-
  bearing. Its JSON-LD offer needs its own `"@type": "Offer"`, because
  `extract.ts` finds the offer node by type and an unlabelled object reads as a
  page with no price — a fixture bug that has twice looked like an app bug.
  Its product URLs are realistic slugs (`/p/testbrand-runner-watch-a`, built by
  `slugFor`), never the short handle, because sitemap discovery ranks cached
  URLs by full-text search over the slug words and `/p/a` carries no searchable
  word at all. It records every request, which is the only way to assert that a
  non-retryable failure was not retried and that the brand gate skipped a
  product *before* any network call. And every run must be scoped by
  `competitorId`, or a real competitor left enabled in a dev database sends the
  suite out to the internet.
- **`startRun` is fire-and-forget, so a test must poll the run row.** It
  returns as soon as the row exists and the scrape continues in the background.
  Poll `scrape_runs.status` rather than `getActiveRunId()`: the in-memory flag
  is cleared in a `finally` that can win the race against the final UPDATE, so
  a test waiting on it can read counters that are not written yet. Related: all
  runner tests live in **one file**, since `activeRunId` is module-level and two
  test files would fight over it.
- **The no-concurrent-runs guard needs a synchronous reservation.**
  `activeRunId` alone cannot enforce it: the id only exists after the INSERT
  that creates the run row, and awaiting that INSERT yields the event loop, so
  two callers arriving together (a double-clicked "Run now", two tabs, a
  retried request) both saw `null` and both started a run — double-scraping
  every competitor and racing the counters. `runStarting` is set in the same
  tick as the check, which is what actually closes the window.
- **"Blocked" is four different problems and only one of them is a wall.**
  `blockDiagnosis.ts` tells them apart: a 429 is ours to fix by slowing down, a
  bare 403 is usually just our user agent, a Cloudflare/DataDome/Akamai
  interstitial is a gate on what we are that politeness cannot clear, and a 451
  or login wall is final. The cause is stored on `scrape_run_items.block_cause`
  and shown per competitor in scrape health, because the remedies are unrelated
  and the expensive one (paying an unblocking vendor) is only right for one of
  them. Diagnosis is deliberately conservative — an unrecognised refusal comes
  back `unclassified` rather than guessed at, since a wrong guess sends someone
  off to buy a subscription for a config problem.
- **A soft block is a 200 that hides an interstitial, and it is the one that
  wastes days.** The status is healthy, the HTML is valid, and every layer above
  reads it as a layout change — so someone rewrites selectors that were never
  wrong. `fetchAndExtract` re-checks after the browser attempt also fails to
  find a price, and only re-labels when the page actually carries challenge
  markers. A genuine redesign must stay `layout_changed`; there is a test for
  exactly that, because the tempting shortcut (any 200 that fails extraction is
  a soft block) would report every redesign as a block.
- **robots.txt is always evaluated against our own identity, never a browser
  string.** `competitor.config.identity` may be set to `'browser'` so the
  browser transport sends a normal Chrome user agent — some edge rules reject
  any non-browser agent outright, and on that path the fetch really is Chromium.
  But `checkRobots` is called with `env.scraperUserAgent` regardless. Picking
  the identity that gets past a Disallow would be circumvention, which this app
  does not do, and a rule written for us still applies when we happen to be
  driving a browser.
- **`SCRAPER_USER_AGENT` ships with a placeholder contact address.** The default
  is `...contact: trading@example.com`, which is both useless to a retailer
  wanting to reach us and a plausible reason to be refused outright. Setting a
  real address on the deployment costs nothing and is the first thing to try
  against a bare 403 — before any conversation about proxies or vendors.
- **The runner tests poll for up to 60s, not 10s.** `env.minRequestDelayMs`
  puts a 3s floor under every request whatever the competitor config says, so a
  run touching a handful of pages legitimately takes tens of seconds. Timing out
  early does not just fail one test: the next `beforeEach` deletes the run row
  out from under the still-running scrape, and the foreign-key violation that
  follows looks like a runner bug rather than an impatient test.
- **The server suite runs `--test-concurrency=1`, and must keep doing so.** Every
  database-backed test file shares one Postgres database, and two of them share
  a single *row*: `alert_settings` is a singleton, so `alertThresholds.test.ts`
  raising a threshold while `alerts.test.ts` runs concurrently makes the latter
  see no alerts and fail with "expected 1, actual 0" — a failure that points at
  the alerts code, where nothing is wrong. It passed for a while purely on
  scheduling luck and surfaced only when new test files shifted the timing.
  Fixture prefixes keep the *rows* apart; they cannot keep shared singletons or
  a shared schema apart.
- **The paid unblocking backend is opt-in, and every guard against spending
  lives in `unblockOrThrow`.** Unset `UNBLOCKER_PROVIDER` and the app is exactly
  what it was: nothing costs money. Configured, it becomes a third rung after
  HTTP and browser, reached only from a `blocked` error whose diagnosis says a
  vendor could plausibly help. That last condition is the point — retrying a
  429 through a paid backend is paying not to slow down, and retrying a 451 or
  a login wall is paying for a request that cannot succeed. The decision reads
  `vendorWouldHelp` off the diagnosis rather than restating the rule per call
  site.
- **Only confirmed matches may spend; discovery never does.** A confirmed match
  is a page already known to be the right product, so unblocking it buys a
  price we want. Discovery opens several still-unproven candidates per product
  and rejects most of them, so unblocking one buys a maybe. It is simply passed
  no `UnblockerBudget`, and `options.unblockerBudget?.take()` being undefined
  is what stops it — there is no second code path to keep in step.
- **`UnblockerBudget` is per run, not global or per competitor.** A run is the
  unit a person starts and watches, so it is the unit whose cost they can
  reason about. Per competitor it would silently multiply by however many are
  enabled. Hitting the ceiling does not fail the run: it carries on unblocked,
  because a partial scan beats a stopped one and beats a surprise invoice.
- **A failure of the paid fetch is thrown as its own error, never folded back
  into the original block.** A subscription that has expired or run out of
  credit otherwise looks exactly like the retailer blocking us, and nobody ever
  goes and looks at the billing page.
