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
const GUIDE_UPDATED = '9 August 2026';

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
            the first run against a new competitor, then review what it found under Match review.
          </li>
        </ol>
      </Section>

      <Section id="pages" title="The pages, one by one">
        <Term label="Price comparison">
          Our price against each competitor's most recent observed price. Pick which of our sites
          you are comparing with using <strong>Our site</strong> — prices differ between them, so
          every figure on the page follows that choice. <strong>They are cheaper</strong> is the
          column that needs action. Click any row to see every competitor price and the observation
          history.
        </Term>
        <Term label="Match review">
          Candidate matches the scraper found, strongest first. Confirm the ones that are genuinely
          the same product and reject the rest. A rejection is remembered — a later run will not
          re-suggest it. This page also has an <strong>Our site</strong> selector, because the price
          shown beside a candidate is the price at that site.
        </Term>
        <Term label="Scrape runs">
          Start a run and see what each one did. <em>Prices</em> re-checks products already matched;{' '}
          <em>Discovery</em> looks for new matches; <em>Both</em> does prices then discovery. Every
          target produces a row, so a competitor changing their page layout shows up as an error
          rather than a silently wrong price. Runs can be deleted individually or cleared in bulk —
          recorded prices are always kept.
        </Term>
        <Term label="Import feed">
          Where products and prices come in. One Google feed per site.{' '}
          <strong>The feed is the whole truth for that site</strong>: whatever is in the file is
          what we hold, and anything missing from it stops being tracked.
        </Term>
        <Term label="Competitors">
          Which retailers we watch. Adding one is a JSON file in the{' '}
          <span className="mono">competitors</span> directory plus <em>Re-sync from config</em> —
          never a code change. Toggle one off to exclude it from runs without losing its history.{' '}
          <em>Test a product URL</em> fetches a single page and shows exactly what was extracted,
          which is the quickest way to tell a layout change from a genuine absence.
        </Term>
        <Term label="Admin">
          Setup and housekeeping: what is actually in the database, what each competitor's
          robots.txt permits, what their sitemaps contain, and competitor logos. Nothing on it runs
          a scrape or changes a price.
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
          Brand is a gate: a candidate from the wrong brand is never offered, whatever else matches.
          Your confirmations and rejections always outrank the scraper — an automated run will not
          overturn a human decision.
        </p>
      </Section>

      <Section id="runs" title="Reading a scrape run">
        <Term label="OK">A page was fetched and a price recorded.</Term>
        <Term label="Skipped">
          Nothing was wrong. Either the competitor does not stock the brand, or nothing they list
          resembles the product. Most of our range is not carried by most of them, so this is the
          normal majority.
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
          attention — use <em>Test a product URL</em> on the Competitors page to see what came back.
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
        <Alert tone="warn" title="Competitors block their own search pages">
          Every competitor we have checked disallows their site search in robots.txt. Finding their
          listings therefore relies on the sitemaps they publish for crawlers. If a competitor
          neither allows search nor publishes a usable sitemap, we cannot read their prices, and the
          right answer is to drop that source rather than work around the block.
        </Alert>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Guide last updated {GUIDE_UPDATED}.
        </p>
      </Section>
    </div>
  );
}
