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
  anything absent from it. Products are marked delisted, never deleted:
  `price_observations` cascade from `products`, so deleting destroys the price
  history the app exists to collect.
- **Every competitor disallows `/search`** in robots.txt. Discovery reads the
  sitemaps they publish for crawlers instead. Fetches are always checked against
  robots.txt first, and a site that actively blocks us is a source to drop, not
  a block to work around.
- **Excel destroys the feeds.** Long numbers arrive as `7.32E+11`, timestamps as
  `00:00.0`. Refuse damaged identifiers rather than storing them, and report the
  count so the export can be fixed at source.
