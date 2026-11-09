# Competitor Price Monitor — project brief

**For:** Director of Ecommerce and anyone reviewing this work
**Last updated:** November 2026
**Status:** Built and working. Limited by data, not by software — see *Where it stands today*.

---

## The problem

We sell several thousand products across Goldsmiths, Mappin & Webb and Watches of
Switzerland. Other UK jewellers sell many of the same watches. Until now there
was no systematic way to answer three questions:

- **Are we more expensive than the market, and on what?**
- **When a competitor changes a price, how long before we notice?**
- **Is our position getting better or worse?**

The honest answer to all three was "nobody knows, unless someone goes and
looks". And looking is not a small job. Checking our live range against every
competitor by hand is somewhere between **37 and 122 working days of effort for
a single snapshot** — by which time the prices have moved. It is not that manual
checking is slow. It is that it cannot be done at all.

This project is the tool that does it automatically, every night, and reports
what changed.

---

## What it does

Each night, with nobody present, it:

1. Collects our current product list and prices
2. Finds the same products on competitors' websites
3. Records what each competitor is charging
4. Compares, and reports where we sit

The output is a set of screens anyone can read: where we stand overall, what
moved overnight, and where we are being undercut.

---

## How it works, step by step

**1. It gets our products automatically.**
Each of our three websites already sends a product file to Google every day,
and those files land on an FTP server. The app collects them from there
overnight — nobody uploads anything.

> *This step turned out to matter more than expected. When those files reached
> us via somebody's computer, they had usually been opened in Excel on the way
> — which silently rewrites a 13-digit barcode as "7.32E+11". In the first
> Goldsmiths file, **263 of 266 barcodes had been destroyed this way**. Taking
> the file straight off the server keeps them intact, and the barcode is the
> single most reliable way to tell that a competitor is selling the same watch.*

**2. It finds the same product on competitors' sites.**
Every retailer publishes a list of its pages for Google to read. The app reads
those lists — the sanctioned route — rather than hammering their search. It then
opens the likely candidates and scores them.

**3. It only accepts a confident match.**
A barcode match is treated as certain. A name-only guess never is. Anything in
between goes to a review queue for a person to approve or reject. Nothing is
compared until somebody or something is confident it is the same product.

**4. It checks the match is still right, every single time.**
Web addresses get reused. A retailer can redirect an old link to a replacement
model, or recycle it for next season's version. So every night the app re-checks
that the barcode on the page still matches ours. If it doesn't, **no price is
recorded** and the match is flagged for review. Without this the app would keep
reporting a confident, wrong price indefinitely — which is far worse than
reporting nothing.

**5. It records the price and keeps the history.**
Every observation is stored, so the history builds from day one. Our own prices
are kept too, so we can tell "they cut their price" from "we raised ours" —
the same gap, opposite responses.

**6. It reports.**
- **Price comparison** — every product, our price against each competitor's,
  colour-coded: green where we're cheaper, red where they are.
- **What moved** — everything that changed overnight, theirs and ours.
- **Market position** — the strategic view: where we sit by brand, by category,
  by competitor, and whether that's drifting.

---

## What it's built from

| Piece | What it's for |
| --- | --- |
| A web application | What people actually use — runs in a browser, no installation |
| A database | Holds the price history. This is the asset that grows over time |
| A web browser, automated | Reads competitor pages. Only started for pages that need it, because it's the expensive part |
| Render (hosting) | Where the app runs, so nobody needs a machine left on |
| Google Shopping feeds | Our own product and price data, already produced daily |
| FTP | Where those feeds arrive |
| *Optional, currently off* | Paid unblocking services, if a competitor ever refuses us |

Nothing here is exotic, and nothing is locked to a vendor. Competitors are added
by writing a small configuration file — **never by changing code**.

---

## Where it stands today

**This is the honest part, and it matters.**

The software is complete and tested. Every feature described above works.

**But it currently monitors one competitor.** Ten more are configured and
switched off, because their settings were written without internet access and
have never been checked against a live website. They are informed guesses, not
verified configurations.

That means every figure the app produces today is measured against a single
comparator. The tool is some way ahead of its data.

**The fix is not more software.** It is a verification pass — a built-in
one-button check that visits each competitor and reports whether we can read
their prices — run from the live system. It takes about half a minute per
competitor. Until that happens, the numbers are directional rather than
authoritative, and the app says so on screen rather than letting anyone quote
them unqualified.

---

## Numbers worth showing

| | |
| --- | --- |
| **263 of 266** | Barcodes destroyed by Excel in the first feed we received — now preserved by collecting it automatically |
| **37–122 working days** | Effort to check our range against all competitors by hand, once |
| **~3 hours** | Machine time for the same job, overnight, unattended |
| **0 hours** | Person-time per night, once running |
| **11** | Competitors configured (1 verified and live, 10 awaiting verification) |
| **280** | Automated tests, all passing — the app checks its own behaviour on every change |
| **20** | Database upgrades applied safely, with no data loss |
| **~19,000** | Lines of code, written and reviewed between August and October 2026 |
| **10** | Screens, including a built-in user guide written for non-technical staff |

---

## What it saves

**The honest framing is not "it saves X hours", because nobody was doing this
work.** It was not being done at all, because it could not be.

What the tool provides is something that did not previously exist:

- **Daily price visibility** across the live range, instead of none
- **A price history that compounds** — in six months we can show how our position
  has moved, which no amount of manual checking after the fact can reconstruct
- **An audit trail** — every figure traces back to a page, on a date, with the
  evidence for why we believe it is the same product
- **Staff time protected** — the alternative was not slow, it was impossible;
  any manual sampling would have consumed real buyer time for a fraction of the
  coverage

If the question is "what would this cost to buy instead", commercial price
monitoring services exist and charge subscription fees for broadly this
capability — with the significant difference that they would not know our
three-site pricing structure or import our own feeds.

---

## Built-in discipline

Worth noting for anyone asking whether this is safe to run against other
companies' websites:

- Every site's published crawling rules are **honoured**, always
- Requests are deliberately slow and spaced out — polite by design
- The app identifies itself honestly rather than pretending to be a customer
- **Only public pricing pages** are read. Nothing behind a login, no personal data
- If a site actively refuses us, that is treated as a signal to reconsider the
  source, not an obstacle to defeat

---

## What's needed next

Three things, in order, and **none of them are software**:

1. **Run the verification check** on all eleven competitors, from the live
   system. This is the single highest-value action available and unlocks
   everything else.
2. **Confirm which brands are price-controlled.** Where RRP is enforced,
   everyone shows the same price by definition — those products will cluster as
   "level" for reasons unconnected to our pricing decisions, and should be read
   separately.
3. **Consider licensed product feeds.** Several of these retailers run affiliate
   programmes that publish their prices as a daily file. That would be more
   complete and more reliable than reading their websites, and it is free. It is
   a commercial conversation rather than a technical one.

---

*Supporting detail, including the per-competitor verification record and a
one-page note on where competitor prices can come from, is in the `docs/`
folder of the project repository.*
