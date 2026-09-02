# Competitor verification record

Every competitor this app monitors has to earn its place here. This file is the
evidence: what was checked, what was observed, and when. A competitor is only
enabled once it has a row below saying someone looked at three real listings and
the extracted price matched the page.

**Nothing here has been verified yet.** All eleven rows read UNVERIFIED, for the
reason set out in the next section. Ernest Jones ships enabled but was written
under the same conditions as the other ten, so it carries the same caveat.

## Why the table is empty

The competitor configurations were written **without network access**. Every
selector, sitemap assumption and URL pattern in `competitors/*.json` is an
informed guess based on how UK jewellery retailers usually build product pages.
None has been checked against a live site.

The development sandbox cannot close that gap. Its egress gateway refuses
outbound HTTPS to retail domains:

```
$ curl -sS -o /dev/null -w "%{http_code}\n" https://www.ernestjones.co.uk/robots.txt
curl: (56) CONNECT tunnel failed, response 403

$ curl -sS "$HTTPS_PROXY/__agentproxy/status"
"kind": "connect_rejected",
"detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)"
```

That 403 comes from the sandbox's own proxy, not from the retailer. It applies
to every external host, `www.google.com` included, so it says nothing whatsoever
about whether a competitor will serve us.

**This is the single most important thing to get right about this file.** A 403
from the sandbox is not evidence that a site blocks us. Marking a competitor
BLOCKED on that basis would wrongly discard a usable source and quietly shrink
the comparison set the app exists to provide. Run the checks below from the
deployed Render host or any machine with ordinary internet access, and record
what *that* environment sees.

## Verdicts

Three states, and only three:

| Verdict | Meaning | `enabled` |
| --- | --- | --- |
| **ENABLED** | Robots allows product pages, the sitemap yields product URLs, and extraction returned the correct price on three real listings. | `true` |
| **NEEDS-WORK** | Reachable, but something in the config is wrong. The row must say exactly what failed. | `false` |
| **BLOCKED** | The site refuses automated access, or robots disallows what we would need to read. Recorded as a dropped source and left alone. | `false` |
| **UNVERIFIED** | Not yet checked. The starting state for everything. | as shipped |

A site actively blocking us is a source to drop, not an obstacle to work
around.

## The record

| Competitor | Slug | Verdict | robots | Sitemap URLs | Listings tested | Notes | Date |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Ernest Jones | `ernest-jones` | UNVERIFIED | not checked | not checked | 0/3 | Ships `enabled: true` and is the only competitor the app currently scans, but was configured without network access like the rest. Re-verify first. | — |
| Beaverbrooks | `beaverbrooks` | UNVERIFIED | not checked | not checked | 0/3 | `brands` already lists six; confirm against the live site. | — |
| Fraser Hart | `fraser-hart` | UNVERIFIED | not checked | not checked | 0/3 | `brands` empty — see below. | — |
| H. Samuel | `h-samuel` | UNVERIFIED | not checked | not checked | 0/3 | `brands` empty. | — |
| Watch Shop | `watch-shop` | UNVERIFIED | not checked | not checked | 0/3 | `brands` empty. | — |
| Watchfinder & Co. | `watchfinder` | UNVERIFIED | not checked | not checked | 0/3 | Pre-owned stock — prices are not directly comparable to new. Decide whether it belongs in the comparison at all before enabling. | — |
| Chisholm Hunter | `chisholm-hunter` | UNVERIFIED | not checked | not checked | 0/3 | `brands` empty. | — |
| Berry's Jewellers | `berrys-jewellers` | UNVERIFIED | not checked | not checked | 0/3 | `brands` empty. | — |
| 77 Diamonds | `77-diamonds` | UNVERIFIED | not checked | not checked | 0/3 | Bridal/diamond specialist, largely configurable jewellery. Expect few matches against a watch catalogue. | — |
| Austen & Blake | `austen-blake` | UNVERIFIED | not checked | not checked | 0/3 | Made-to-order bridal; same caveat as 77 Diamonds. | — |
| Purely Diamonds | `purely-diamonds` | UNVERIFIED | not checked | not checked | 0/3 | Same caveat as 77 Diamonds. | — |

Nine of the eleven have `brands: []`, which the matcher reads as *"assume they
stock everything"*. Discovery then opens candidate pages for every product in
the catalogue against that competitor. Filling `brands` in is the cheapest
accuracy and compute win available here: a retailer that does not carry Rolex
should skip every Rolex product before a single request is made, which the run
detail records as `skipped / brand_not_stocked`.

## How to verify one competitor

Work through them one at a time, in the order the table lists them. Replace
`<host>` with the deployed app's host and `<slug>` with the competitor's slug.

### A. Crawl permissions

```bash
curl -s -X POST https://<host>/api/admin/robots-check | python3 -m json.tool
```

Read the row for your competitor:

- **`status: "unreachable"`, `failureDetail: "HTTP 403"`** — the site refuses
  our user agent *from this host*. Record the exact status and mark BLOCKED.
- **`probe[0].allowed: false`** — their robots disallows the search URL. This is
  expected, not a failure. Every competitor examined disallows `/search`, which
  is exactly why discovery reads sitemaps instead. Continue.
- **`sitemaps: []` but reachable** — no sitemap declared in robots. Note it and
  try the conventional `/sitemap.xml` in the next step anyway.

### B. Sitemap survey

```bash
curl -s -X POST https://<host>/api/admin/sitemap-check | python3 -m json.tool
```

Thousands of URLs with product-shaped `sampleUrls` is a pass. Zero with a 403 or
block error is BLOCKED; zero with a parse error is NEEDS-WORK. If the survey
stopped at an index file, that is untested, not broken — say so.

### C. Extraction, on three real listings

Open the site in a normal browser and find three real product pages for brands
they actually stock. Pick different shapes: a plain in-stock item, one on
promotion with a struck-through was-price, and one out of stock.

```bash
curl -s -X POST https://<host>/api/competitors/<slug>/test-url \
  -H 'Content-Type: application/json' \
  -d '{"url":"<the real product URL>"}' | python3 -m json.tool
```

Compare the returned price against what the page shows. Also read `wasPrice` and
the in-stock flag, not just `price`.

- **All three correct** — ENABLED candidate.
- **`layout_changed`** — the `sanityContains` selectors are wrong for this site.
- **`no_price_found`** — the price selectors are wrong, or the price is injected
  by JavaScript. Fix the selectors first; if the site genuinely needs a browser,
  set `"rendering": "browser"` explicitly for that competitor.
- **A price came back but it is wrong** — the dangerous case. Jewellery sites
  routinely publish "from £X", finance-per-month figures and struck-through
  RRPs, and any of them will extract as a plausible number. A silently wrong
  price is worse than no price: fix the selector ordering so the live price
  wins, and never enable on a number you have not checked against the page.

One passing URL is not enough. A single simple product with clean JSON-LD can
pass by luck while the rest of the site fails.

### D. Fill in `brands`

Write what the retailer actually stocks, using the brand strings exactly as they
appear in our own feed. Matching is case-insensitive but not fuzzy, so
`TAG Heuer` matches `tag heuer` and `TAG-Heuer` matches nothing. Check against
the catalogue before writing the list:

```sql
SELECT DISTINCT brand FROM products ORDER BY 1;
```

### E. Record it

Update the config: `enabled`, `brands`, any corrected selectors, and rewrite the
`_notes` block. Those notes currently say the config is unverified, which
becomes a lie the moment you verify it. Replace them with what you observed and
the date.

Then update this file's table row with the verdict, the evidence and the date,
and list the three test URLs underneath the table so the next person can re-run
exactly what you ran.

### F. Sync, then enable in small batches

Editing `competitors/*.json` changes nothing at runtime until the configs are
synced, because the database holds a copy:

```bash
curl -s -X POST https://<host>/api/competitors/sync | python3 -m json.tool
```

The sync deliberately **preserves `enabled` overrides made in the Admin UI**, so
a competitor toggled off there stays off even after you set `"enabled": true` in
the file. Check Admin → Competitors afterwards and toggle there if needed.

Then, one competitor at a time: run a single-product scan from Scrape runs,
read the run detail for real outcomes rather than errors, and check the hosting
compute usage before adding the next. Three enabled competitors is a sensible
first target, not eleven — enabling all ten dormant configs at once multiplies
scan cost immediately.

## If a competitor really does block us

Assume nothing here applies until a verification pass from a network-capable
host says it does. When one genuinely refuses us, work down this list. It is
ordered by cost, and the cheap options at the top resolve more cases than people
expect.

### 0. Find out which wall it is

Run the URL through **Admin → Test a product URL**. A refusal now reports what
refused us and what would get past it, and the same cause is stored per run item
and totalled per competitor in **Scrape health**. Four different problems hide
behind the word "blocked" and only one of them justifies spending money:

| What it says | What it means | What to do |
| --- | --- | --- |
| Rate limited | We asked too fast. They are willing to serve us. | Raise `minDelayMs`, drop `maxConcurrent` to 1, spread the scan over more hours. |
| Refused outright | A 403 with no challenge page — usually our identity, not our behaviour. | Steps 1 and 2 below. |
| Bot challenge | Cloudflare, DataDome, Akamai or similar gating on *what we are*. | Steps 3 onward. Politeness will not clear it. |
| Soft block | A normal 200 hiding an interstitial. | Same as a bot challenge — but do not touch the selectors, they are fine. |
| Legally blocked / needs an account | Final. | Record it and drop the source. |

### 1. Set a real contact address (free, do this first)

`SCRAPER_USER_AGENT` still ships with `contact: trading@example.com`. A named
crawler with a working address is something a retailer can look up, contact and
whitelist; a placeholder is something an edge rule bins. Set it on the deployment
before concluding anything about a 403.

### 2. Slow down, and scan at night (free)

The strongest argument for this app is the one the business already makes: a
person could open every one of these pages by hand. That is true — and it is
also the shape of request pattern that nobody blocks. Blocking is triggered by
*rate*, and rate is entirely ours to choose. A full catalogue spread across an
overnight window at one request every few seconds is indistinguishable from
ordinary browsing, and there is no business reason to want prices faster than
daily.

### 3. Ask them (free, and better than any workaround)

Retailers whitelist identified crawlers on request more often than people
assume, particularly between UK businesses that already know each other. The
worst outcome is being told no, which is information we do not currently have.

### 4. Take the prices from a licensed feed instead (the strongest route)

This is the option worth pursuing hardest, because it removes the problem rather
than fighting it. Most of these retailers run affiliate programmes, and an
affiliate programme comes with a **product data feed**: SKU, title, brand,
price, availability and product URL, refreshed daily, delivered as a file.
That is the same data a scrape is trying to reconstruct, except licensed,
structured, complete, and immune to layout changes and blocking alike. It is
what price comparison sites actually run on.

Known so far:

- **Beaverbrooks** — [Awin](https://ui.awin.com/merchant-profile/5856), also
  linked from their own [affiliates page](https://www.beaverbrooks.co.uk/info/affiliates).
- **Ernest Jones** — [FlexOffers](https://www.flexoffers.com/affiliate-programs/ernest-jones-affiliate-program/).
- **Fraser Hart** — [FlexOffers](https://www.flexoffers.com/affiliate-programs/fraser-hart-affiliate-program/).
- H. Samuel shares Signet's UK operation with Ernest Jones, so check the same
  networks.

Two things to check before committing: acceptance into each programme is at the
merchant's discretion, and the programme terms should be read for what the feed
may be used for — using it for competitive analysis rather than promotion is a
question for whoever signs it, not an assumption to make quietly. If the answer
is yes, importing a competitor feed is a much smaller build than it sounds,
because this app already imports and reconciles a feed of exactly this shape for
our own catalogue.

### 5. Commercial unblocking services (paid)

Zyte, Bright Data, ScrapingBee and ScraperAPI sell request infrastructure that
handles the challenge layer. This is ordinary practice in price intelligence and
priced per thousand requests — roughly $1.50 per 1,000 records at Bright Data,
from cents to double digits per 1,000 at Zyte depending on how hard the target
is, and ScrapingBee from about $49/month. At a nightly full-catalogue scan the
volume is modest.

Two honest caveats. It is a commercial and legal decision rather than a
technical one, and it should have sign-off from whoever owns that risk, because
it means paying to get past a measure the site put up deliberately. And it does
not fix a legal block or a login wall.

**The app is already wired for this.** Set two environment variables and it
works; leave them unset and nothing changes and nothing costs money:

```
UNBLOCKER_PROVIDER=zyte | brightdata | scrapingbee | scraperapi
UNBLOCKER_API_KEY=…
UNBLOCKER_MAX_CALLS_PER_RUN=250     # hard ceiling per run
```

Four guards keep it from becoming an open invoice, and they are worth knowing
before anyone signs anything:

- It is reached **only from a block**, never from a slow page or a wrong
  selector.
- And not from every block. A **rate limit is not retried** — that is us asking
  too fast, and paying to avoid slowing down is money for nothing. A **legal
  block or login wall is not retried** either, because no service gets past
  them. Only the walls a backend genuinely clears are worth a paid call.
- **Only confirmed matches can spend.** Discovery opens several unproven
  candidates per product and rejects most; paying to unblock one buys a maybe.
  It is given no allowance at all.
- **A per-run ceiling**, defaulting to 250 calls. Past it the run continues
  unblocked rather than failing — a partial scan beats a stopped one, and beats
  a bill nobody approved.

Set a competitor's `unblocker` to `"never"` in its config file to opt it out
individually. Admin's **Test a product URL** panel spends exactly one call, so
you can confirm a subscription works on a site that refuses us before running
anything at scale, and the transport is reported per page so paid fetches are
visible rather than inferred.

### 6. Buy the answer instead (paid)

Price2Spy, Prisync, Competera, Skuuudle and DataWeave sell competitor price
monitoring as a service. They have already solved blocking and maintain the
extraction themselves. Worth pricing against the engineering time the equivalent
in-house capability costs, especially if the requirement grows beyond a handful
of UK jewellers.

### What this app will not do

Two lines are not crossed regardless of which route is chosen, because they turn
a defensible commercial practice into an indefensible one.

**robots.txt is honoured, always.** Every fetch is checked against it first, and
`identity: 'browser'` does not change that — robots is evaluated against our own
crawler identity even when the request is driven by Chromium, so switching
identity can never be used to get past a `Disallow`. Worth noting this costs us
nothing today: every competitor examined allows product pages and disallows only
`/search`, which is precisely why discovery reads sitemaps.

**Nothing behind a login.** Reading a price that is only shown to signed-in
customers is a different thing legally from reading a public page, and the app
reports it as out of scope rather than attempting it.

## Known config caveat

`searchUrlPattern` is schema-checked for containing `{query}` but nothing
verifies it is correct. It only matters for competitors using
`discovery: "search"`, and all eleven currently use `discovery: "sitemap"`, so a
wrong pattern is harmless today. Note it rather than fixing it blind.
