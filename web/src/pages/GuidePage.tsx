import { Alert, Card } from '../components/ui';

/**
 * The user guide.
 *
 * Written for whoever is actually running price monitoring rather than for a
 * developer: what each page is for, what the numbers mean, and the handful of
 * things that will otherwise waste an afternoon. Kept in the app rather than in
 * a wiki so it ships with the behaviour it describes.
 *
 * KEEP THIS UPDATED. Any change to how a page works, what a number means, or
 * what a file must contain belongs here in the same commit as the change.
 */

/** Shown at the foot of the page so staleness is visible rather than assumed. */
const GUIDE_UPDATED = '26 August 2026';

function Section({
  id,
  title,
  subtitle,
  children,
}: {
  id: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div id={id} style={{ scrollMarginTop: 90 }}>
      <Card title={title} subtitle={subtitle}>
        {children}
      </Card>
    </div>
  );
}

function Term({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="guide-term">
      <div className="guide-term__label">{label}</div>
      <div className="guide-term__body">{children}</div>
    </div>
  );
}

const CONTENTS = [
  ['what-it-does', 'What this app does'],
  ['start-here', 'Start here'],
  ['pages', 'The pages, one by one'],
  ['prices', 'How prices work'],
  ['matching', 'How matching works'],
  ['runs', 'Reading a scrape run'],
  ['gotchas', 'Things that will bite you'],
];

export function GuidePage() {
  return (
    <div className="page">
      <p className="page__intro">
        How to run price monitoring: what each page is for, what the numbers mean, and the handful
        of things worth knowing before they cost you an afternoon.
      </p>

      <Card title="Contents">
        <ul className="guide-contents">
          {CONTENTS.map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`}>{label}</a>
            </li>
          ))}
        </ul>
      </Card>

      <Section
        id="what-it-does"
        title="What this app does"
        subtitle="And, just as usefully, what it does not"
      >
        <p>
          It compares <strong>our</strong> price for a product against what competitors charge for
          the same thing, and shows where we are undercut.
        </p>
        <p>
          Our prices come from the <strong>Google Shopping feed</strong> each of our sites already
          sends — the same prices customers see. Competitor prices are read from their public
          product pages. Nothing here changes a price anywhere; it only reports.
        </p>
        <p className="small muted" style={{ marginBottom: 0 }}>
          It does not price-match, publish, or push anything back to SAP or Hybris.
        </p>
      </Section>

      <Section id="start-here" title="Start here" subtitle="Three steps to a working comparison">
        <ol className="guide-steps">
          <li>
            <strong>Import a feed for each site.</strong> Import feed → choose the site → drop the
            file. Do this separately for Goldsmiths, Mappin &amp; Webb and Watches of Switzerland;
            each carries its own prices.
          </li>
          <li>
            <strong>Check what competitors allow.</strong> Admin → Crawl permissions, then Admin →
            Sitemaps. These say whether each competitor can be read at all, and by what route.
            Nothing is scraped by either check.
          </li>
          <li>
            <strong>Run a scrape.</strong> Scrape runs → Start run. Use a small product limit for
            the first run against a new competitor, then review what it found under Match review. To
            prove the whole chain works, put one SKU you know a competitor stocks in the
            single-product box and scan just that.
          </li>
        </ol>
      </Section>

      <Section id="pages" title="The pages, one by one">
        <Term label="Price comparison">
          Our price against each competitor's most recent observed price. Pick which of our sites
          you are comparing with using <strong>Our site</strong> — prices differ between them, so
          every figure on the page follows that choice. <strong>They are cheaper</strong> is the
          column that needs action. Click any row to open <strong>Competitor coverage</strong>: every
          enabled competitor, not just the ones a price was found for. A priced row shows the price,
          its URL and where it stands against ours; anything else shows a plain-English reason —
          not listed, doesn't stock the brand, found but rejected, a candidate awaiting review, or
          the last scan's error. If every enabled competitor comes back negative, a banner says so
          plainly rather than leaving you to infer it from an empty table. Below that sits a{' '}
          <strong>Price trend</strong> chart of how each competitor's price has moved, and the full
          observation history.
          <br />
          <br />
          Every "Seen" figure — on this table, in the drawer, and beside the headline{' '}
          <strong>Best competitor</strong> price — is coloured by age: plain for a price observed in
          the last 3 days, amber from 3 days, and bold red from 14 days. There is no scheduler yet, so
          a price is only as current as the last run that touched it; the colour is what stops an
          old figure from reading as today's. Hover it for the exact date.
          <br />
          <br />
          Each row carries two actions. <strong>Scan</strong> runs that one product against every
          enabled competitor there and then — the quickest way to check whether a product you know
          a competitor stocks is actually being picked up. <strong>Delete</strong> removes the
          product itself, along with our price for it and every competitor price and match recorded
          against it.
          <br />
          <br />
          There are three scales of clearing up. <strong>Remove</strong>, beside a competitor's price
          in the row detail, drops that one competitor's price for that one product.{' '}
          <strong>Clear comparisons</strong>, at the top of the page, throws away every recorded
          competitor price and match while keeping the products.{' '}
          <strong>Delete all products</strong> empties the catalogue entirely — the start-from-scratch
          button. Your competitors and their settings survive all three, and so does the match going
          with the price: leaving it behind would have the next run record the same stale figure
          straight back. What is never thrown away: your products and your own prices, which come
          from the feed rather than from scraping, and anything you have <em>rejected</em> in Match
          review, so clearing a comparison never re-opens a candidate you have already turned down.
        </Term>
        <Term label="Alerts">
          Raised automatically the moment a confirmed competitor price drops below ours at one of our
          sites, and <strong>resolved automatically</strong> the moment it no longer does — nothing
          here is typed in by hand, and you never need to check whether an old alert is still true.
          <strong>Acknowledging</strong> one only marks that you have seen it; it does not touch any
          price or match. The sidebar badge counts open alerts, the same way Match review's badge
          counts pending candidates.
        </Term>
        <Term label="Match review">
          Candidate matches the scraper found, strongest first. Confirm the ones that are genuinely
          the same product and reject the rest. A rejection is remembered — a later run will not
          re-suggest it. This page also has an <strong>Our site</strong> selector, because the price
          shown beside a candidate is the price at that site. Tick several rows — or the header
          checkbox for all pending ones — to confirm or reject them together.
        </Term>
        <Term label="Scrape runs">
          Start a run and see what each one did. <em>Prices</em> re-checks products already matched;{' '}
          <em>Discovery</em> looks for new matches; <em>Both</em> discovers first and then prices,
          so a match found by a run is priced by that same run. Every target produces a row, so a
          competitor changing their page layout shows up as an error rather than a silently wrong
          price. Runs can be deleted individually or cleared in bulk — recorded prices are always
          kept.
          <br />
          <br />
          A run scans up to three competitors at once rather than one after another, so a run
          against several competitors finishes in roughly the time of the slowest one rather than
          the sum of all of them. Each competitor's own requests are still spaced out exactly as
          before — this only overlaps waiting on <em>different</em> competitors, it does not scan
          any one of them any less politely.
          <br />
          <br />
          A run can be scoped three ways. Putting a <strong>SKU</strong> in the single-product box —
          or pasting the product's own page URL on our site into the box beside it — scopes the run
          to that one product, which is how you test whether something you know a competitor lists
          gets picked up; either one resolves to the same product, and a URL that isn't in the last
          imported feed says so rather than guessing. <strong>Uploading a list of SKUs</strong>{' '}
          (a plain text file or CSV export, one per line or comma/tab separated) scopes it to exactly
          that batch instead — the middle ground between testing one product and scanning the whole
          catalogue, for when you want to check a specific set without waiting on everything else.
          Any SKU in the file that doesn't match a product is reported once the run starts rather
          than silently dropped, so a typo doesn't just quietly vanish from the batch. All three
          scoped modes look at their product(s) whether or not they already have candidates, so you
          can re-check the same ones as often as you like. Only enabled competitors are ever scanned.
          <br />
          <br />
          A scoped run — one product, one URL, or an uploaded list — searches each competitor's{' '}
          <em>already-cached</em> list of URLs rather than re-reading their sitemap — some publish
          tens of thousands of them, and walking the whole tree just to check a handful of SKUs
          could take minutes and looked like the run had hung. The cache is normally close enough;
          tick <strong>Re-harvest first</strong>, which appears once a run is scoped, only when a
          competitor's listing is new enough that it might not be cached yet. A run against the
          whole catalogue always re-reads every sitemap, which is what keeps the cache current the
          rest of the time.
          <br />
          <br />
          Discovery also does not chase a candidate that will not load. Opening a candidate page is
          tried once, not retried against a competitor's full retry policy — a candidate is a guess,
          and retrying an unproven guess three times over wastes minutes better spent on the next
          one. A competitor that will not respond at all is given a fixed amount of time in total
          before the run moves on to the next competitor, rather than being allowed to run
          indefinitely.
          <br />
          <br />
          <strong>Add a test product</strong>, at the top of the page, puts a single product in by
          hand without waiting on a feed — give it a SKU, brand, name and ideally a barcode, and it
          can scan straight away. A product added this way survives feed imports that do not mention
          it, unlike everything else, because it is a fixture rather than something the feed owns.
          Delete it from Price comparison when you have finished with it.
        </Term>
        <Term label="Import feed">
          Where products and prices come in. One Google feed per site.{' '}
          <strong>The feed is the whole truth for that site</strong>: whatever is in the file is
          what we hold, and anything missing from it stops being tracked. The one exception is a
          product added by hand on Scrape runs, which is kept because no feed will ever mention it.
        </Term>
        <Term label="Admin">
          Setup and housekeeping, all in one place. It holds what is actually in the database;{' '}
          <strong>Competitors</strong>, the retailers we watch; their logos;{' '}
          <strong>Crawl permissions</strong> and <strong>Sitemaps</strong>, which say whether a site
          can be read at all and by what route; and <strong>Test a product URL</strong>. Nothing
          here changes a price or starts a run.
          <br />
          <br />
          Adding a competitor is a JSON file in the <span className="mono">competitors</span>{' '}
          directory plus <em>Re-sync from config</em> — never a code change. Toggle one off to
          exclude it from runs without losing its history. <em>Test a product URL</em> fetches a
          single page and shows exactly what was extracted, which is the quickest way to tell a
          layout change from a genuine absence; it stores nothing.
        </Term>
      </Section>

      <Section id="prices" title="How prices work" subtitle="Per site, and taken from the feed">
        <Term label="A price belongs to a site, not to a product">
          The same watch can be a different price at Goldsmiths and at Mappin &amp; Webb. Each site's
          feed sets its own price, and every page that shows "our price" asks you which site you
          mean. A product with no price at the selected site reads as awaiting a price rather than
          quietly borrowing another site's.
        </Term>
        <Term label="Sale prices">
          Where the feed carries a <span className="mono">sale_price</span> that is genuinely
          cheaper <em>and</em> currently active, that becomes our price and the regular price is kept
          as the struck-through "was". A sale scheduled for next month is not applied early, and a
          "sale" that is not actually cheaper is ignored.
        </Term>
        <Term label="Prices are VAT inclusive">
          Feed prices are gross, which is what a customer pays and what competitor sites display, so
          the two are directly comparable.
        </Term>
        <Term label="Products with no visible price">
          Rows marked <span className="mono">price_visible=FALSE</span> get no price recorded —
          there is nothing for a customer to compare against.
        </Term>
        <Term label="Out-of-stock products">
          A row whose <span className="mono">availability</span> is not an in-stock value — out of
          stock, preorder, backorder — gets no price recorded either, the same as a hidden price:
          only what is actually sellable is worth comparing. This is checked separately from{' '}
          <span className="mono">price_visible</span>, since a feed can mark something visible and
          out of stock at the same time. A product with no price anywhere is treated as
          discontinued: it drops out of scans and the comparison, though its price history is kept,
          and it comes straight back the moment a later feed lists it in stock again.
        </Term>
      </Section>

      <Section id="matching" title="How matching works" subtitle="And why some things need a human">
        <p>
          The scraper finds candidate pages, then scores how confident it is that a candidate is the
          same product. Confidence comes mostly from how it was matched:
        </p>
        <Term label="EAN / MPN exact — the strongest">
          The competitor publishes the same barcode or manufacturer reference. This is as certain as
          it gets and is confirmed automatically.
        </Term>
        <Term label="Brand and specifications">
          Same brand, and the attributes that define the product agree — case size, metal, dial
          colour, carat weight. Strong, but usually worth a glance.
        </Term>
        <Term label="Fuzzy name and specs — always review">
          The names look alike and nothing contradicts. This is a suggestion, not a conclusion. Two
          watches in a family often differ only by a detail the page does not state.
        </Term>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Brand is a gate: a candidate is rejected outright unless the brand can be confirmed, whatever
          else matches. That includes a page that genuinely is the right product but simply does not
          state its brand anywhere the scraper can read — not published as structured data, and not
          in the visible title — which reads identically to a wrong-brand rejection in the run detail.
          Your confirmations and rejections always outrank the scraper — an automated run will not
          overturn a human decision.
        </p>
      </Section>

      <Section id="runs" title="Reading a scrape run">
        <Term label="OK">
          The competitor was searched or a price page was fetched, and nothing went wrong. For a
          price target that means a price was recorded. For discovery it can also mean a listing
          was found, opened and <em>rejected</em> — brand not identified, a different EAN published,
          or too little in common with our record. Read the <strong>Detail</strong> column: it
          names the candidate URL tried and exactly why it did not stick, rather than leaving a
          rejected candidate looking identical to nothing having been found at all.
        </Term>
        <Term label="Skipped">
          Nothing was even tried. Either the competitor does not stock the brand, or no candidate
          URL in their sitemap resembled the product closely enough to be worth opening. Most of
          our range is not carried by most competitors, so this is the normal majority.
        </Term>
        <Term label="Blocked by robots.txt">
          The competitor's rules do not permit that page. We honour that rather than working around
          it.
        </Term>
        <Term label="Listing 404s">
          A page we previously matched has gone. Usually the product was discontinued; occasionally
          the URL moved and the match needs re-making.
        </Term>
        <Term label="Layout changed / no price found">
          The page loaded but we could not read a price from it. This is the one that needs
          attention — use <em>Test a product URL</em> on the Admin page to see what came back.
        </Term>
      </Section>

      <Section id="gotchas" title="Things that will bite you">
        <Alert tone="warn" title="Never open a feed in Excel before uploading it">
          Excel rewrites long numbers as scientific notation — a barcode becomes{' '}
          <span className="mono">7.32E+11</span> and is destroyed. In the first feed we received,
          263 of 266 barcodes were ruined this way. Barcodes are the strongest matching signal we
          have, so this single habit costs more accuracy than anything else. Export the file and
          upload it untouched.
        </Alert>
        <Alert tone="info" title="A feed replaces everything for its site">
          Importing a feed with five products means that site now sells exactly those five. Anything
          missing from the file stops being scanned and disappears from the comparison. This is
          deliberate — it is how the app follows your latest file — but it does mean a partial
          export looks like a catalogue collapse. Recorded price history is never deleted, and a
          product returning in a later feed comes straight back.
        </Alert>
        <Alert tone="info" title="A scan only looks at enabled competitors">
          A single-product scan that finds nothing usually means the retailer you had in mind is
          switched off, not that they do not list the product. Enable them on Admin → Competitors
          first. A competitor configured as not stocking that brand is skipped too, and says so in
          the run detail.
        </Alert>
        <Alert tone="warn" title="'OK' in a run does not always mean a match was made">
          The status only says nothing went wrong technically — the competitor's page loaded, or
          their listing was opened and read. It does not promise a price was recorded. A test scan
          that finds a plausible page but rejects it (wrong or missing brand, a different EAN, too
          little in common with our record) still reports "ok", with the reason spelled out in the
          run's Detail column. If a product you know is stocked shows nothing on Price comparison,
          check that Detail column before assuming the scan failed.
        </Alert>
        <Alert tone="warn" title="Competitors block their own search pages">
          Every competitor we have checked disallows their site search in robots.txt. Finding their
          listings therefore relies on the sitemaps they publish for crawlers. If a competitor
          neither allows search nor publishes a usable sitemap, we cannot read their prices, and the
          right answer is to drop that source rather than work around the block.
        </Alert>
        <Alert tone="info" title="Reading the Crawl permissions and Sitemaps checks">
          These two look alarming the first time and mostly are not. A column of{' '}
          <strong>search disallowed</strong> on Crawl permissions is the expected result, not a
          failure — it is the reason we read sitemaps instead, and it is what the Sitemaps card then
          measures. On Sitemaps, a competitor showing thousands of URLs is working. A blank count
          carries a <strong>verdict</strong> beside it saying which of three things happened:{' '}
          <em>Index only</em> means the survey stopped early by design and the source is untested,
          not unusable; <em>Sitemap unreadable</em> and <em>Blocked at robots.txt</em> are the real
          problems. A handful of unreadable sources still leaves plenty to compare against — the
          question is whether enough competitors work, not whether all of them do.
        </Alert>
        <Alert tone="info" title="Unreachable can mean where the app is running, not the retailer">
          Both checks report what <em>this deployment</em> can reach. Some retailers refuse traffic
          from data centres, so a site that is fine in a browser on your desk can read as{' '}
          <span className="mono">HTTP 403</span> or a timeout from the server. That is a hosting
          question rather than a verdict on the retailer, and it is worth re-checking before writing
          a source off.
        </Alert>
        <Alert tone="warn" title="'Cannot reach the API' can mean the server is mid-restart">
          The hosting platform restarts the app if it stops answering its health check for long
          enough — most often after a long-running scrape has used up the container's resources.
          While that restart is in progress, a page load can get a plain "server unavailable"
          response instead of real data, which shows here as a short, clear error rather than
          anything from the failed page itself. Waiting a minute and reloading is usually all that
          is needed; if it persists, that is worth reporting, not something to work around.
        </Alert>
        <Alert tone="info" title="The price trend chart has one real line and one reference line">
          Competitor prices accumulate a genuine history — every observation is kept, so the chart's
          competitor lines are real. Our own price does not: each feed import overwrites it, so there
          is only ever a current figure, never a past one. The dashed line is that current price
          shown for comparison, not a claim about what it used to be.
        </Alert>
        <Alert tone="info" title="An alert is per site, like everything else about price">
          The same competitor can undercut Goldsmiths without undercutting Mappin &amp; Webb, since
          each of our sites charges its own price. An alert always names which site it is about, and
          resolves for that site alone — the same competitor's price can still be open against one
          site while resolved against another.
        </Alert>
        <Alert tone="warn" title="A red 'Seen' age means re-check before you act on it">
          Nothing re-scrapes a competitor automatically — a price stays exactly as recorded until a
          run touches that product again. A figure 14+ days old (shown bold red) may no longer be
          what the competitor actually charges; re-run <strong>Scan</strong> on that product before
          treating an old "they are cheaper" figure, or an alert built from one, as still true.
        </Alert>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Guide last updated {GUIDE_UPDATED}.
        </p>
      </Section>
    </div>
  );
}
