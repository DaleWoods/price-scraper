# PLAN 3 — Scrape health per competitor

**Rank: 3 of 5.**
**Why:** spec §3 lists four success criteria for this product. Three are visible
somewhere in the app (match coverage, data freshness, price position). The
fourth — **"Scrape health — success rate per competitor; breakages flagged, not
silently wrong"** — has no representation at all. There is no endpoint, no query
and no page containing the words "success rate".

Every failure is *recorded* (`scrape_run_items` has status, error_kind, error and
duration per target) but the only way to read it is to open one run at a time.
A competitor that quietly started failing three runs ago is invisible until
someone notices their prices went stale.

This is also the instrument you need while executing PLAN 2 — enabling a
competitor without a health view is enabling it blind.

---

## Goal

A **Scrape health** card on the Admin page: one row per competitor, over a
selectable window (7 / 30 days), showing what proportion of *attempts* produced
a price, what is failing and why, and when that competitor last worked.

All data already exists. This is one query, one endpoint, one card — no new
tables, no migration.

---

## Files to touch (in this order)

1. `server/src/services/scrapeHealth.ts` — **new file**, the query + shaping.
2. `server/src/routes/admin.ts` — new `GET /api/admin/scrape-health`.
3. `server/test/scrapeHealth.test.ts` — **new file**, DB-backed test.
4. `web/src/api.ts` — types + client method.
5. `web/src/pages/AdminPage.tsx` — the card.
6. `web/src/pages/GuidePage.tsx` + `CLAUDE.md` — docs (mandatory).

---

## Background: what the data actually means

`scrape_run_items.status` is one of `ok` / `error` / `skipped`, and **the naïve
reading of these is wrong**:

| status | error_kind | What it actually means | Counts as a failure? |
| --- | --- | --- | --- |
| `ok` | — | Nothing went technically wrong. For a price target: a price was recorded. For a discovery target: it may have found and *rejected* every candidate. | No |
| `skipped` | `brand_not_stocked` | We never asked — the competitor doesn't stock that brand. | **No** |
| `skipped` | `not_listed` | Asked, they don't list it. The normal majority of results. | **No** |
| `error` | `robots_disallowed` | Policy outcome, working as designed. | **No** (report separately) |
| `error` | `blocked` | Site is actively refusing us. | **Yes** |
| `error` | `layout_changed` / `no_price_found` | Their page changed; our config is stale. **The one that needs a human.** | **Yes** |
| `error` | `not_found` | A previously-matched listing 404s. | **Yes** (but it's a signal, not a bug) |
| `error` | `timeout` / `navigation_failed` / `http_error` | Transient or infrastructural. | **Yes** |

So: **success rate must exclude `skipped` from the denominator entirely**, and
`robots_disallowed` must be reported as its own category rather than dragging a
correctly-behaving competitor's score down.

Getting this wrong produces a dashboard that says every competitor is failing 95%
of the time (because most products aren't stocked anywhere), which is worse than
having no dashboard.

---

## Step-by-step

### Step 1 — `server/src/services/scrapeHealth.ts`

```ts
import { query } from '../db/pool.js';

export interface CompetitorHealth {
  competitorId: number;
  competitorName: string;
  competitorSlug: string;
  enabled: boolean;
  /** Attempts = ok + error. Skipped is excluded: we never asked. */
  attempts: number;
  ok: number;
  errored: number;
  skipped: number;
  /** ok / attempts, 0-100, null when there were no attempts at all. */
  successPct: number | null;
  /** Error kinds by frequency, worst first. */
  topErrors: { kind: string; count: number }[];
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastErrorKind: string | null;
  lastErrorMessage: string | null;
  medianDurationMs: number | null;
}

export async function getScrapeHealth(days = 7): Promise<{
  windowDays: number;
  competitors: CompetitorHealth[];
}> {
  const { rows } = await query<...>(
    `SELECT c.id, c.display_name, c.slug, c.enabled,
            count(*) FILTER (WHERE i.status IN ('ok','error'))            AS attempts,
            count(*) FILTER (WHERE i.status = 'ok')                       AS ok,
            count(*) FILTER (WHERE i.status = 'error')                    AS errored,
            count(*) FILTER (WHERE i.status = 'skipped')                  AS skipped,
            max(i.created_at) FILTER (WHERE i.status = 'ok')              AS last_ok_at,
            max(i.created_at) FILTER (WHERE i.status = 'error')           AS last_error_at,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY i.duration_ms)
              FILTER (WHERE i.duration_ms IS NOT NULL)                    AS median_duration_ms
     FROM competitors c
     LEFT JOIN scrape_run_items i
       ON i.competitor_id = c.id
      AND i.created_at >= now() - ($1::int * interval '1 day')
     GROUP BY c.id, c.display_name, c.slug, c.enabled
     ORDER BY c.display_name`,
    [days],
  );
  // ... plus a second query for topErrors and the last error message, keyed by
  // competitor_id, then merged in JS.
}
```

Two queries merged in JS is fine and clearer than one clever query. The second:

```sql
SELECT competitor_id, error_kind, count(*)::int AS count
FROM scrape_run_items
WHERE status = 'error' AND competitor_id IS NOT NULL
  AND created_at >= now() - ($1::int * interval '1 day')
GROUP BY competitor_id, error_kind
ORDER BY count DESC
```

And for the last error message, a `DISTINCT ON (competitor_id) ... ORDER BY
competitor_id, created_at DESC` query.

`successPct` is computed in JS as `attempts === 0 ? null : round(ok / attempts * 100)`.

### Step 2 — the route

In `server/src/routes/admin.ts`, alongside the existing `/status`,
`/robots-check`, `/sitemap-check` handlers:

```ts
adminRouter.get('/scrape-health', async (req, res, next) => {
  try {
    const raw = Number(req.query.days);
    const days = [7, 30, 90].includes(raw) ? raw : 7;
    res.json(await getScrapeHealth(days));
  } catch (err) {
    next(err);
  }
});
```

Whitelist the window rather than passing an arbitrary number through — it goes
into an interval multiplication.

### Step 3 — the test

`server/test/scrapeHealth.test.ts`, following the DB-backed pattern of
`server/test/feedImportDb.test.ts` exactly:
`describe(..., { skip: !DATABASE_URL && 'DATABASE_URL not set' })`, fixtures
created in `before`, deleted in `after`.

Seed one competitor and a run with a deliberate mix of items:
3 × `ok`, 1 × `error/layout_changed`, 1 × `error/blocked`, 20 ×
`skipped/not_listed`, 1 × `error/robots_disallowed`.

Assert:
- `attempts === 5` — **not 26**. This is the assertion that catches the bug this
  plan exists to prevent.
- `skipped === 20` and skipped is absent from the denominator.
- `successPct === 60`.
- `topErrors[0].kind` is present and counts are right.
- A competitor with no items at all in the window returns `attempts: 0` and
  `successPct: null` (not `0`, not `NaN`, not a division-by-zero throw).

### Step 4 — client types

`web/src/api.ts`: add `CompetitorHealth` and `ScrapeHealthResponse` interfaces
mirroring the server, and:

```ts
  scrapeHealth: (days = 7) =>
    request<ScrapeHealthResponse>(`/api/admin/scrape-health?days=${days}`),
```

### Step 5 — the Admin card

In `web/src/pages/AdminPage.tsx`, add a `<Card title="Scrape health" subtitle="…">`
following the shape of the existing "Crawl permissions" card. Columns:

| Competitor | Success | Attempts | Failing on | Last worked | Median |

Rules for presentation:
- Success as a percentage with a `PositionBadge`-style colour: ≥90% neutral/good,
  50–89% warn, <50% danger. **Reuse the existing `badge--*` classes** — do not
  invent new colours; the design system is a stated requirement (spec §5.7).
- `attempts === 0` renders "not scanned" in muted text, never "0%".
- "Failing on" shows the top error kind, mapped through the same
  `ERROR_KIND_COPY` human labels that `web/src/pages/RunsPage.tsx` already
  defines. **Export that map from a shared module rather than copy-pasting it**
  — a second divergent copy of those strings is exactly the kind of duplication
  the last review pass removed.
- "Last worked" uses the existing `PriceAge`-style relative time (`relativeTime`
  from `web/src/api.ts`); a competitor whose last success is >14 days old should
  read as visibly stale.
- Include a window selector (7 / 30 / 90 days) wired to the `days` param.
- Disabled competitors still get a row (greyed), so "we turned this off because
  it broke" stays visible rather than disappearing.

### Step 6 — docs (mandatory)

- `GuidePage.tsx`: add a `<Term label="Scrape health">` under the Admin section
  explaining what the percentage does and does not count — specifically that
  *skipped is not failure*, because a trader looking at "12% success" needs to
  know that is not what it sounds like. Bump `GUIDE_UPDATED`.
- `CLAUDE.md`: record the status/error_kind semantics table above, so the next
  person computing anything from `scrape_run_items` does not recompute the
  denominator wrongly.

---

## Edge cases a weaker model will get wrong

1. **Counting `skipped` as failure.** The single most important thing in this
   plan. Most of our range is not carried by most competitors — skipped is the
   normal majority outcome, by design. Including it makes every competitor look
   broken.
2. **Counting `robots_disallowed` as a breakage.** It is the system correctly
   honouring a competitor's rules. Report it in its own column or as a note; it
   must not make a well-behaved integration look unhealthy.
3. **`competitor_id` is nullable.** `scrape_run_items.competitor_id` is
   `ON DELETE SET NULL`, so items survive their competitor. A `GROUP BY
   competitor_id` without `IS NOT NULL` produces a phantom row. Drive the report
   from `competitors LEFT JOIN items` (as above), which sidesteps it.
4. **Division by zero.** A competitor with no attempts must yield `null`, and the
   UI must render that as "not scanned", not "0%" — those mean opposite things
   (never tried vs. tried and failed every time).
5. **Putting the date filter in the `WHERE` clause of a `LEFT JOIN` query.**
   `WHERE i.created_at >= …` turns the LEFT JOIN into an INNER JOIN and silently
   drops every competitor with no recent activity — exactly the ones you most
   need to see. The condition must be in the `ON` clause, as written above.
6. **`percentile_cont` on an empty set.** Returns NULL, which is correct — make
   sure the TypeScript type is `number | null` and the UI handles it, rather than
   `.toFixed()` on null.
7. **An `ok` discovery item is not a recorded price.** As `CLAUDE.md` already
   documents, discovery can return `ok` having found and rejected everything.
   Do not label the success column "prices recorded" — label it "attempts that
   completed", or split price-scrape items (`match_id IS NOT NULL`) from
   discovery items if you want a truer number. Do not overclaim in the copy.
8. **Duplicating `ERROR_KIND_COPY`.** It already exists in `RunsPage.tsx`. Move
   it to a shared module and import it in both places.

---

## Acceptance criteria

- [ ] `GET /api/admin/scrape-health` returns one entry per competitor, including
      competitors with zero activity (`attempts: 0`, `successPct: null`).
- [ ] `?days=30` changes the window; a nonsense value (`?days=abc`, `?days=9999`)
      falls back to 7 rather than erroring or interpolating.
- [ ] `server/test/scrapeHealth.test.ts` passes and includes the explicit
      "20 skipped items do not count as failures" assertion.
- [ ] `npm test` total count is higher than before; `npm run build` clean.
- [ ] Admin page shows the card; a competitor seeded with 3 ok / 2 error / 20
      skipped displays **60%**, not 12%.
- [ ] A competitor with no items reads "not scanned", not "0%".
- [ ] `ERROR_KIND_COPY` exists in exactly one place in the codebase
      (`grep -rn "ERROR_KIND_COPY" web/src | wc -l` shows the import sites, one
      definition).
- [ ] Guide has a Scrape health entry explaining that skipped ≠ failure;
      `GUIDE_UPDATED` bumped.
- [ ] All test fixtures removed afterwards.
