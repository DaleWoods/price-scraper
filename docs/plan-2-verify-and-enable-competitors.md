# PLAN 2 — Verify and enable the 10 dormant competitors

**Rank: 2 of 5.**
**Why:** the app currently monitors **exactly one** competitor. Ten of the eleven
config files ship `"enabled": false` with an explicit `_notes` block saying every
selector in them is an *informed guess written without network access* and has
never been checked against the live site. A price-comparison tool with one
comparator does not meet the stated goal ("compare our prices to our
competitors", plural — Ernest Jones, Beaverbrooks *and other UK retailers*, per
spec §1/§5.2). This is the largest gap between "the app works" and "the app is
useful".

**Do PLAN 1 first.** Enabling competitors multiplies compute, and the deploy is
already over its quota.

---

## Goal

Take each of the 11 competitors from "unverified guess" to one of three
**recorded, evidenced** states:

- **ENABLED** — robots allows product pages, a sitemap yields product URLs, and
  extraction returns the right price on ≥3 real listings.
- **BLOCKED** — the site refuses automated access, or robots disallows what we'd
  need. Stays disabled; recorded as a dropped source (spec §9 — do not work
  around it).
- **NEEDS-WORK** — reachable but selectors/patterns are wrong. Stays disabled
  with a written note of exactly what failed.

Output is both a code change (fixed configs, `enabled` flags, `brands` lists)
and a written record: `docs/competitor-verification.md`.

---

## ⚠️ Where this must be run

**This cannot be completed from the Claude Code sandbox.** The sandbox's egress
gateway rejects outbound HTTPS to retail domains with
`gateway answered 403 to CONNECT (policy denial or upstream failure)` — every
competitor will report `unreachable / HTTP 403` no matter how correct the config
is. That is a property of the dev container, not the retailers.

Run the verification steps against **the deployed Render app**, or any machine
with ordinary internet access. Config edits can be written anywhere; only the
*checks* need real network.

If you cannot reach a network-capable environment, **stop and report that** —
do not mark competitors BLOCKED on the basis of sandbox 403s. That is the single
biggest mistake available in this plan.

---

## Files to touch

1. `competitors/*.json` — the 11 config files (`enabled`, `brands`,
   `searchUrlPattern`, `product.selectors`, `product.sanityContains`, `_notes`).
2. `docs/competitor-verification.md` — new file, the evidence record.
3. `web/src/pages/GuidePage.tsx` + `CLAUDE.md` — only if the *set of enabled
   competitors* changes (it will), per the standing docs rule.

No TypeScript changes. If you find yourself editing `.ts` files to make a
competitor work, stop: spec §5.2 says adding/adjusting a retailer is
configuration, never code. A genuine code gap is a finding to report, not to
patch inside this plan.

---

## Step-by-step, per competitor

Work through them **one at a time**, in this order (most likely to matter first):

`ernest-jones` (already enabled — re-verify it), `beaverbrooks`, `fraser-hart`,
`h-samuel`, `watch-shop`, `watchfinder`, `chisholm-hunter`, `berrys-jewellers`,
`77-diamonds`, `austen-blake`, `purely-diamonds`.

### Step A — crawl permissions

```bash
curl -s -X POST https://<your-render-host>/api/admin/robots-check | python3 -m json.tool
```

Read the row for the competitor. Decide:

- `status: "unreachable"` with `failureDetail: "HTTP 403"` → the site refuses our
  user agent from this host. Mark **BLOCKED**, record the exact status. Move on.
- `probe[0].allowed: false` → their robots disallows the *search* URL. This is
  **expected and fine** (every competitor examined disallows `/search`) — it is
  why discovery uses sitemaps. Not a blocker. Continue to Step B.
- `sitemaps: []` and reachable → no declared sitemap; note it, continue to Step B
  and check the conventional `/sitemap.xml` anyway.

### Step B — sitemap survey

```bash
curl -s -X POST https://<your-render-host>/api/admin/sitemap-check | python3 -m json.tool
```

For this competitor, look at `totalUrls` and `sampleUrls`:

- Thousands of URLs and `sampleUrls` that look like product pages → good.
- `0` with an `error` → **NEEDS-WORK** or **BLOCKED** depending on the error
  (403/blocked = BLOCKED; parse failure = NEEDS-WORK).
- Index-only (the survey stopped at an index file) → not proof of failure.
  Record as untested rather than broken.

### Step C — extraction, on three real listings

Open the competitor's site in a normal browser, find **three** real product
pages for brands they actually stock, then for each:

```bash
curl -s -X POST https://<your-render-host>/api/competitors/<slug>/test-url \
  -H 'Content-Type: application/json' \
  -d '{"url":"<the real product URL>"}' | python3 -m json.tool
```

Compare the returned `price` against what the page shows in the browser.

- All three correct → **ENABLED** candidate. Go to Step D.
- Extraction throws `layout_changed` → `sanityContains` selectors are wrong for
  this site. Fix them (see Step E) and retry.
- Extraction throws `no_price_found` → the price selectors are wrong, or the
  price is JS-injected. Fix selectors; if the site genuinely needs a browser,
  set `"rendering": "browser"` explicitly for that competitor (PLAN 1 leaves
  `browser` a valid explicit choice).
- Price returned but **wrong** (e.g. it grabbed an RRP, a finance monthly figure,
  or a "from" price) → this is the dangerous case. Fix the selector ordering so
  the live price wins. Never enable a competitor that returns a plausible-but-
  wrong number; a silently wrong price is worse than no price (spec §5.4).

### Step D — set `brands`

Look at what the retailer actually stocks and fill the `brands` array. Nine of
the eleven configs currently have `"brands": []`, which means *"assume they stock
everything"* — discovery then opens candidate pages for every product in the
catalogue against that competitor.

This is both a compute cost and an accuracy cost. Setting `brands` correctly is
one of the cheapest big wins available: a competitor that does not stock Rolex
should skip every Rolex product before a single request is made
(`runner.ts` records these as `skipped / brand_not_stocked`).

Use the brand names **exactly as they appear in our feed's `brand` column** —
matching is case-insensitive but not fuzzy, so `TAG Heuer` matches `tag heuer`
but `TAG-Heuer` matches nothing.

### Step E — record and commit the config

Update the JSON: `enabled`, `brands`, any corrected selectors, and **rewrite the
`_notes` block** — it currently says the config is unverified, which will be a
lie once you have checked it. Replace with what you actually observed and the
date.

Then append a row to `docs/competitor-verification.md`:

```markdown
| Competitor | Verdict | robots | sitemap URLs | Listings tested | Notes | Date |
| --- | --- | --- | --- | --- | --- | --- |
| Ernest Jones | ENABLED | search disallowed (expected) | 14,203 | 3/3 correct | — | 2026-08-29 |
```

### Step F — enable in small batches and watch the cost

**Do not enable all ten at once.** After each competitor is enabled:

1. Run a single-product scan against it from the Scrape runs page.
2. Check the run detail: statuses, durations, and error kinds.
3. Check Render's compute usage before adding the next one.

Three enabled competitors is a sensible first target, not eleven.

---

## Edge cases a weaker model will get wrong

1. **Treating a sandbox 403 as the retailer blocking us.** Covered above; it is
   the environment. Verify from the deployed host or report that you cannot.
2. **Treating "search disallowed" as failure.** It is the expected result for
   every competitor examined and is precisely why sitemap discovery exists. The
   Admin UI even says so. Marking a site BLOCKED for this would wrongly discard
   a perfectly usable source.
3. **Enabling on one successful test URL.** One page can pass by luck (a simple
   product with clean JSON-LD). Three listings, ideally of different shapes (a
   plain watch, one on promotion with a was-price, one out of stock), is the
   minimum.
4. **Accepting a wrong-but-plausible price.** Jewellery sites commonly show
   "from £X", finance-per-month figures, and RRP struck through. A number is not
   a pass; the number must match what a customer would pay. Check
   `wasPrice`/`promo` in the response too.
5. **Filling `brands` with marketing names.** Must match our feed's `brand`
   values exactly (modulo case). Check against
   `SELECT DISTINCT brand FROM products ORDER BY 1;` before writing the list.
6. **Forgetting the re-sync.** Editing `competitors/*.json` changes nothing at
   runtime until `POST /api/competitors/sync` runs — the DB holds a copy.
   Worse: the sync **preserves `enabled` overrides made in the UI**
   (`syncCompetitorsToDatabase` deliberately does not overwrite `enabled`), so a
   competitor toggled off in Admin stays off even after you set
   `"enabled": true` in the file. Check the Admin page after syncing, and toggle
   there if needed.
7. **Enabling a competitor whose `searchUrlPattern` is a guess.** The pattern
   must contain `{query}` (schema-enforced) but nothing checks it is *correct*.
   It only matters for `discovery: "search"` competitors — all current configs
   use `discovery: "sitemap"`, so a wrong search pattern is harmless today but
   will bite if discovery mode is ever switched. Note it rather than fixing
   blind.
8. **Not re-verifying Ernest Jones.** It ships enabled but was configured under
   the same no-network conditions as the rest. It is the one competitor the app
   currently relies on; it deserves the same three-listing check.

---

## Acceptance criteria

- [ ] `docs/competitor-verification.md` exists and has a row for **all 11**
      competitors, each with a verdict, the evidence, and a date.
- [ ] Every competitor marked ENABLED has three recorded test URLs whose
      extracted price matched the live page.
- [ ] No competitor is marked BLOCKED on the basis of a sandbox/proxy 403.
- [ ] Every `_notes` block in an edited config reflects what was actually
      observed — no config still claims to be unverified after being verified.
- [ ] `brands` is populated for every ENABLED competitor, with values that
      appear in `SELECT DISTINCT brand FROM products`.
- [ ] `POST /api/competitors/sync` has been run and Admin → Competitors shows
      the intended enabled/disabled state.
- [ ] A single-product scan against each newly enabled competitor completes and
      its run detail shows real outcomes (a price, or an explained miss) — not
      an error.
- [ ] `GUIDE_UPDATED` bumped if the guide's description of enabled competitors
      changed.
