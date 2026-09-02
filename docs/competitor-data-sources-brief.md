# Competitor price data: how we get it, and one decision to make

**For:** Director of Ecommerce, and whoever reviews commercial terms
**From:** Ecommerce / price monitoring project
**Date:** September 2026

---

## The ask, restated

We want to compare our prices against the UK competition — one product at a
time, a supplied list, or the whole live catalogue — and act on where we sit.
The tool for this is built and working. This note is about **where the
competitor prices come from**, because there is a better answer available than
the obvious one, and it needs a decision rather than more engineering.

## Where we are

The application imports our live catalogue, matches our products to competitor
listings, records their prices over time, and raises an alert when a competitor
goes cheaper than us, cuts their own price sharply, or drops a listing. It runs
on individual SKUs, on an uploaded list, and across everything.

**Today it monitors one competitor.** Ten more are configured but switched off,
because their configurations were written without internet access and have never
been checked against the live sites. Verifying them is a short piece of work that
has to be run from a machine with ordinary internet access.

One thing worth being precise about: **we have not yet been blocked by anybody.**
The refusals seen so far came from the development environment's own network
restrictions, not from the retailers. That is worth knowing before we spend
anything solving a problem we may not have.

## Two ways to get competitor prices

### 1. Read their public product pages

What the tool does now. The prices are published publicly; we read them at a
polite rate, honour each site's robots.txt, and never touch anything behind a
login.

It works, and it is free. The limitations are real but ordinary: pages change
and configurations need occasional maintenance, and some retailers put bot
protection in front of their site. Where that happens, the tool now says *which
kind* of refusal it is — a rate limit we caused and can fix by slowing down, a
plain refusal that is usually just how we identify ourselves, or a genuine
gate — so the response is proportionate rather than guesswork.

### 2. Take a licensed product feed instead

**This is the recommendation.** Most of these retailers run affiliate
programmes, and an affiliate programme comes with a **product data feed**:
SKU, title, brand, price, availability and product URL, refreshed daily, as a
file we collect.

That is precisely the data we are otherwise reconstructing page by page, except
licensed, structured, complete and stable. It is what price comparison sites
actually run on. It cannot be blocked, does not break when a site is redesigned,
and covers a retailer's whole range rather than the products we happened to match.

Confirmed available:

| Retailer | Network |
| --- | --- |
| Beaverbrooks | Awin |
| Ernest Jones | FlexOffers |
| Fraser Hart | FlexOffers |
| H. Samuel | Shares Signet's UK operation with Ernest Jones — check the same networks |

Importing a feed is a **much smaller build** than it sounds, because the
application already imports and reconciles a feed of exactly this shape for our
own catalogue.

## What we need from you

**1. A view on the affiliate feed route.** Two questions, neither technical:

- Are we willing to apply to these programmes as a publisher? Acceptance is at
  the merchant's discretion.
- Programme terms should be read for **what the feed may be used for**. Using a
  feed for competitive analysis rather than for promotion is a question for
  whoever signs it. We should ask it deliberately rather than assume the answer.

**2. Awareness of a paid fallback, not yet a decision.** For any retailer that
genuinely blocks us and has no feed, commercial unblocking services exist
(Zyte, Bright Data, ScrapingBee, ScraperAPI) at roughly £1–£2 per thousand
requests. The application is already wired for one — two settings turn it on,
and with them unset nothing changes and nothing costs money.

We would not switch this on without sign-off, because it means paying to get
past a measure a site put up deliberately, and that is a commercial and legal
call rather than an engineering one. Guards are built in: it is used only where
it could actually work, only for products we have already confirmed, and every
run has a hard ceiling on paid requests.

**3. A note on scale, in our favour.** There is no business reason to want these
prices faster than daily. A full catalogue spread across an overnight window at
a few seconds per request looks like ordinary browsing and is the pattern least
likely to be refused by anyone. Being patient is both cheaper and better behaved.

## What we are not doing

We honour every site's robots.txt, and we do not read anything behind a login.
Both stay true whichever route is chosen. Public price comparison is ordinary
commercial practice; those two lines are what keep it that way, and crossing
them would put the whole programme on a different footing for a marginal amount
of extra coverage.

## Suggested sequence

1. **Verify the ten dormant competitors** from a network-capable environment.
   Cheap, and tells us how much of a problem we actually have.
2. **Open the affiliate feed conversation in parallel** — it has the longest
   lead time and the biggest payoff.
3. **Enable competitors in small batches**, checking hosting cost as we go.
4. **Revisit paid unblocking only if** a retailer both blocks us and has no feed.
