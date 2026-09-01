# PLAN 4 — Configurable alert thresholds, and the two missing alert types

**Rank: 4 of 5.**
**Why:** spec §5.5 specifies alerts as *"threshold-driven and configurable"* with
three triggers. The app implements one of them, with no threshold at all:

| Spec §5.5 alert | Status today |
| --- | --- |
| Competitor undercuts us **by more than X% (or £Y)** | Partially — fires on *any* undercut, including 1p. No threshold, nothing configurable. |
| Competitor **price drop / new promotion** detected | **Not built.** |
| A previously-matched product **goes out of stock or the listing 404s** | **Not built** as an alert (it is recorded as a run error and nothing more). |

With one competitor and a handful of products this is survivable. Against a full
catalogue it is the difference between an alert feed the trading team acts on and
one they mute — a 1p undercut on a £12,000 watch is noise, and a competitor
quietly dropping 15% overnight is the thing they actually needed to know.

---

## Goal

1. Thresholds for the undercut alert, stored in the database and editable in
   Admin: minimum % **and/or** minimum £ before an alert is raised.
2. New alert type `price_drop` — a competitor's own price fell by ≥ X% versus
   their previous observation of the same product.
3. New alert type `listing_gone` — a confirmed match's page 404s or the product
   goes out of stock at a competitor.
4. All three visible on the Alerts page, filterable by type.

---

## Files to touch (in this order)

1. `migrations/015_alert_settings_and_types.sql` — **new file**.
2. `server/src/services/alertSettings.ts` — **new file**, read/write settings.
3. `server/src/services/alerts.ts` — thresholds + the two new types.
4. `server/src/scraping/runner.ts` — hook `listing_gone` into the error path.
5. `server/src/routes/alerts.ts` — settings GET/PUT, and a `type` filter.
6. `server/test/alertThresholds.test.ts` — **new file**.
7. `web/src/api.ts` — types + client methods.
8. `web/src/pages/AlertsPage.tsx` — type filter + per-type presentation.
9. `web/src/pages/AdminPage.tsx` — the settings form.
10. `web/src/pages/GuidePage.tsx` + `CLAUDE.md` — docs (mandatory).

---

## Step-by-step

### Step 1 — migration

`migrations/015_alert_settings_and_types.sql`:

```sql
-- Spec §5.5 wants alerts "threshold-driven and configurable". Until now any
-- undercut at all raised one, including a penny on a five-figure watch.
CREATE TABLE IF NOT EXISTS alert_settings (
    id                     BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    undercut_min_pct       NUMERIC(6,2) NOT NULL DEFAULT 0,
    undercut_min_abs       NUMERIC(12,2) NOT NULL DEFAULT 0,
    price_drop_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    price_drop_min_pct     NUMERIC(6,2) NOT NULL DEFAULT 5,
    listing_gone_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly one row, ever. The BOOLEAN-primary-key-with-CHECK trick makes a
-- second row impossible at the schema level rather than by convention.
INSERT INTO alert_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- The existing partial unique index covers (type, product_id, competitor_id,
-- fascia_id) WHERE state = 'open'. price_drop and listing_gone are NOT per
-- fascia — they are facts about the competitor's own listing — so they carry
-- fascia_id IS NULL, and Postgres treats NULLs as DISTINCT in a unique index.
-- Without this second index every run would raise a fresh duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_no_fascia_idx
    ON alerts (type, product_id, competitor_id)
    WHERE state = 'open' AND fascia_id IS NULL;
```

**Read that last comment twice.** It is the highest-risk detail in this plan.

### Step 2 — settings accessor

`server/src/services/alertSettings.ts`:

```ts
export interface AlertSettings {
  undercutMinPct: number;
  undercutMinAbs: number;
  priceDropEnabled: boolean;
  priceDropMinPct: number;
  listingGoneEnabled: boolean;
}

export async function getAlertSettings(): Promise<AlertSettings> { /* SELECT … WHERE id */ }
export async function updateAlertSettings(patch: Partial<AlertSettings>): Promise<AlertSettings> { /* UPDATE … RETURNING */ }
```

Do **not** cache the result in a module-level variable. Settings are read once
per observation, the table has one row, and a stale cache after an edit is a
confusing bug for no measurable gain.

### Step 3 — thresholds in `syncUndercutAlerts`

In `server/src/services/alerts.ts`, `syncUndercutAlerts()` currently does:

```ts
const undercut = competitorPrice != null && classifyPosition(fp.price, competitorPrice) === 'higher';
```

It must now also clear the threshold. Use the existing shared helper —
`priceDelta()` from `services/comparison.ts` — do **not** recompute the maths:

```ts
const settings = await getAlertSettings();           // once, before the loop
// inside the loop:
const { deltaAbs, deltaPct } = priceDelta(fp.price, competitorPrice!);
const meetsThreshold =
  deltaPct >= settings.undercutMinPct && deltaAbs >= settings.undercutMinAbs;
const undercut = competitorPrice != null
  && classifyPosition(fp.price, competitorPrice) === 'higher'
  && meetsThreshold;
```

Both defaults are `0`, so behaviour is unchanged until someone sets a threshold.

**Critical:** when an existing open alert no longer meets the threshold, the
`else` branch already calls `resolveAlert(...)`. That is correct and must stay —
raising the threshold should quietly resolve alerts that no longer qualify, not
strand them open forever.

### Step 4 — `price_drop`

Add to `alerts.ts`. Called from the same place `syncUndercutAlerts` is called
(`runner.ts`, right after a price observation is written), with the new price:

```ts
export async function syncPriceDropAlert(
  productId: number,
  competitorId: number,
  newPrice: number | null,
): Promise<void> {
  const settings = await getAlertSettings();
  if (!settings.priceDropEnabled || newPrice == null) return;

  // The observation immediately before the one just written. OFFSET 1 skips the
  // row we have only just inserted.
  const { rows } = await query<{ price: number | null }>(
    `SELECT price FROM price_observations
     WHERE product_id = $1 AND competitor_id = $2 AND price IS NOT NULL
     ORDER BY observed_at DESC
     OFFSET 1 LIMIT 1`,
    [productId, competitorId],
  );
  const previous = rows[0]?.price;
  if (previous == null || previous <= 0) return;

  const dropPct = ((previous - newPrice) / previous) * 100;
  if (dropPct < settings.priceDropMinPct) return;

  await raiseAlert({ type: 'price_drop', productId, competitorId, fasciaId: null, … });
}
```

Message wording: *"Ernest Jones dropped Rolex Submariner 41mm from £9,500.00 to
£8,200.00 (−13.7%)."* — name the competitor, both prices and the percentage.

### Step 5 — `listing_gone`

Two triggers, both in `server/src/scraping/runner.ts`, inside
`scrapeConfirmedMatches()`:

**(a) 404 / gone.** In the `catch` block, where `kind` is computed:

```ts
      if (kind === 'not_found') {
        await raiseListingGoneAlert(match.product_id, competitor.id, match.competitor_url, 'the listing 404s')
          .catch((e) => logger.warn('runner', `listing_gone alert failed: ${e.message}`));
      }
```

**(b) Out of stock.** In the success path, after `extractListing`, when
`listing.inStock === false`. Note `inStock` is `boolean | null` — `null` means
*unknown*, which must **not** raise an alert. Test `=== false` explicitly.

Resolution: when a later run scrapes the same match successfully **and**
`inStock !== false`, resolve any open `listing_gone` for that (product,
competitor). Add `resolveListingGone(productId, competitorId)` and call it on the
success path.

### Step 6 — routes

`server/src/routes/alerts.ts`:
- `GET /api/alerts/settings` → `getAlertSettings()`.
- `PUT /api/alerts/settings` → validate then `updateAlertSettings()`.
  Validation: percentages 0–100, absolute ≥ 0, booleans are booleans. Reject
  anything else with 400 and a message naming the field.
- Extend the existing alerts list endpoint with an optional `?type=` filter,
  whitelisted to the three known types.

### Step 7 — UI

`AlertsPage.tsx`:
- Add a type filter (All / Undercut / Price drop / Listing gone).
- Give each type its own badge and glyph — reuse existing `badge--*` classes.
- `delta_abs`/`delta_pct` are null for `listing_gone`; the table must render "—"
  rather than `£NaN`.

`AdminPage.tsx`:
- A "Alert thresholds" card with the five settings, a Save button, and a toast.
- Under the undercut fields, state plainly that both conditions must be met (see
  edge case 3) — e.g. *"An alert is raised only when the competitor is cheaper by
  at least this percentage AND at least this amount. Leave either at 0 to ignore
  it."*

### Step 8 — tests

`server/test/alertThresholds.test.ts`, DB-backed, following
`feedImportDb.test.ts`'s skip-without-DATABASE_URL pattern:

1. Undercut below the % threshold raises **no** alert.
2. Undercut above both thresholds raises exactly one.
3. Raising the threshold above an existing open alert **resolves** it.
4. Two consecutive identical `listing_gone` triggers produce **one** open alert,
   not two. *(This is the NULL-unique-index test — it fails without the second
   index from Step 1.)*
5. `price_drop` fires at ≥ the configured %, not below it.
6. `inStock === null` does **not** raise `listing_gone`.

### Step 9 — docs (mandatory)

- `GuidePage.tsx`: extend the Alerts `<Term>` with the three types and what the
  thresholds do; add a "Things that will bite you" note that raising a threshold
  resolves alerts that no longer qualify. Bump `GUIDE_UPDATED`.
- `CLAUDE.md`: record the NULL-in-partial-unique-index trap, the "both undercut
  thresholds must be met" semantics, and that `inStock === null` means unknown.

---

## Edge cases a weaker model will get wrong

1. **The NULL unique-index trap.** Postgres treats NULLs as distinct in unique
   indexes, so the existing `alerts_open_undercut_idx` provides **no dedup at
   all** for rows with `fascia_id IS NULL`. Without the second partial index,
   every single run raises a fresh duplicate `listing_gone`/`price_drop` — the
   table fills with thousands of identical open alerts. The matching
   `ON CONFLICT` clause in `raiseAlert` has the same problem and must target the
   new index's column list for those types.
2. **`OFFSET 1` in the price-drop lookup.** The new observation has already been
   inserted by the time alerts run. Comparing against "the latest observation"
   compares the price to itself and never fires. Skip one row.
3. **First-ever observation.** No previous row → no drop → return early. Do not
   treat a missing previous price as a drop from zero or to zero.
4. **`inStock === null` vs `false`.** `null` means the page did not say. Alerting
   on unknown stock would fire constantly on sites that don't publish
   availability. Only `=== false`.
5. **Percentage direction.** `price_drop` is about the competitor's price falling
   *relative to their own previous price* — nothing to do with our price. Do not
   reuse the undercut comparison here.
6. **Both undercut thresholds are ANDed, not ORed.** Spec says "by more than X%
   (or £Y)" which reads like OR, but ANDing with defaults of 0 is the behaviour
   that is safe either way: with both at 0 nothing changes; setting only one
   applies only that one. Implement AND, default both to 0, and **say so in the
   UI** so the behaviour is not a surprise.
7. **Alerts must never break a scrape.** Every alert call in `runner.ts` must be
   `.catch()`-wrapped and logged, exactly as the existing `syncUndercutAlerts`
   call is. A failed alert write must not lose a successfully scraped price.
8. **Resolution paths for the new types.** An alert that can be raised but never
   resolved is worse than no alert. `listing_gone` resolves on a successful
   in-stock scrape; `price_drop` is a point-in-time event — it should be
   *acknowledgeable* but does not auto-resolve. Say which is which in the guide.
9. **`raiseAlert` currently hardcodes `type = 'undercut'`** in several helper
   queries (`resolveAlert`, `resolveAlertsForPair`, `resolveAlertsForProduct`,
   `resolveAllOpenAlerts` all filter `WHERE type = 'undercut'`). Decide
   deliberately for each whether the new types should be included — clearing a
   product's comparisons should probably resolve *all* its alert types, not just
   undercuts.

---

## Acceptance criteria

- [ ] Migration applies cleanly; `alert_settings` has exactly one row and a
      second `INSERT` is rejected by the CHECK constraint.
- [ ] With default settings (both thresholds 0), alert behaviour is **identical**
      to before this change — verified by the existing `alerts.test.ts` still
      passing unmodified.
- [ ] Setting `undercut_min_pct = 10` stops a 5% undercut raising an alert and
      resolves any existing open alert that no longer qualifies.
- [ ] Two consecutive runs against a 404ing listing produce **one** open
      `listing_gone` alert. Verify directly:
      `SELECT count(*) FROM alerts WHERE type='listing_gone' AND state='open';` → 1.
- [ ] A competitor price falling 15% raises `price_drop`; falling 2% does not
      (with `price_drop_min_pct = 5`).
- [ ] An observation with `in_stock IS NULL` raises no `listing_gone`.
- [ ] Alerts page filters by type; `listing_gone` rows render "—" for delta
      rather than `NaN` or `£null`.
- [ ] Admin settings form saves, reloads correctly, and rejects 150% / negative
      values with a readable error.
- [ ] `npm test` count increased; `npm run build` clean; fixtures cleaned up.
- [ ] `GUIDE_UPDATED` bumped; guide documents all three types and the AND
      semantics.
