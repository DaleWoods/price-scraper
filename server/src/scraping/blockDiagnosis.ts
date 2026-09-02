/**
 * Work out *what kind* of wall we hit, and what would get past it.
 *
 * "Blocked" on its own is not actionable. A 429 with a Retry-After means slow
 * down and we are fine. A Cloudflare interstitial means the site gates
 * automated clients and no amount of politeness changes that. A plain 403 with
 * no challenge markup is often just our user agent. A 200 that renders a
 * "checking your browser" page looks like a layout change and is really a
 * block. Each of those has a different remedy and a different cost, and
 * telling them apart is the whole point of this module.
 *
 * Nothing here circumvents anything. It reads what the response already says
 * about itself so a person can decide whether to slow down, ask the retailer
 * for access, pay a vendor, or drop the source.
 */

/** The distinct walls worth telling apart, because each has its own remedy. */
export type BlockCause =
  | 'rate_limited'
  | 'bot_challenge'
  | 'ua_or_waf'
  | 'login_required'
  | 'geo_or_legal'
  | 'soft_block'
  | 'unclassified';

export interface BlockDiagnosis {
  cause: BlockCause;
  /** The protection product, when it names itself. */
  vendor: string | null;
  /** One line for a person reading a run detail. */
  label: string;
  /** What to actually do about it. */
  remedy: string;
  /** Seconds the site asked us to wait, when it said. */
  retryAfterSeconds: number | null;
  /**
   * Whether a commercial unblocking service plausibly addresses this. False
   * for the cases where the answer is ours to fix (slow down, identify
   * ourselves) or where no tool helps (a legal block).
   */
  vendorWouldHelp: boolean;
}

/**
 * Signatures the major protection products leave in a response.
 *
 * These are self-identifications — headers and markup the product puts there
 * deliberately, mostly so operators can debug. Matching on them tells us who
 * is in front of the site, nothing more.
 */
const VENDOR_SIGNATURES: ReadonlyArray<{
  vendor: string;
  headers?: string[];
  body?: RegExp;
}> = [
  { vendor: 'Cloudflare', headers: ['cf-ray', 'cf-mitigated'], body: /cf-browser-verification|__cf_chl|cf_chl_opt|Attention Required!\s*\|\s*Cloudflare|Checking your browser before accessing/i },
  { vendor: 'Akamai', headers: ['x-akamai-transformed'], body: /AkamaiGHost|Reference&#32;#[0-9a-f.]+|_abck|ak_bmsc/i },
  { vendor: 'DataDome', headers: ['x-datadome', 'x-dd-b'], body: /datadome|captcha-delivery\.com/i },
  { vendor: 'HUMAN (PerimeterX)', headers: ['x-px'], body: /_px[A-Za-z0-9]*=|px-captcha|perimeterx/i },
  { vendor: 'Imperva (Incapsula)', headers: ['x-iinfo', 'x-cdn'], body: /_Incapsula_Resource|incap_ses|Request unsuccessful\. Incapsula/i },
  { vendor: 'Queue-it', body: /queue-it\.net|queueittoken/i },
  { vendor: 'Kasada', headers: ['x-kpsdk-ct'], body: /kpsdk|kasada/i },
  { vendor: 'F5 Shape', body: /shape_?security|_bm_sv/i },
];

/** Copy a challenge page shows even when the vendor does not name itself. */
const CHALLENGE_COPY =
  /verify(ing)? you are (a )?human|enable javascript and cookies to continue|checking your browser|are you a robot|unusual traffic from your (computer|network)|access denied|bot detection|please complete the security check/i;

const GEO_COPY =
  /not available in your (country|region)|unavailable in your location|geo(graphic|graphically)? restricted|blocked for legal reasons/i;

function findVendor(headers: Headers | Record<string, string> | null, html: string): string | null {
  const has = (name: string): boolean => {
    if (!headers) return false;
    if (headers instanceof Headers) return headers.has(name);
    return Object.keys(headers).some((key) => key.toLowerCase() === name);
  };

  for (const signature of VENDOR_SIGNATURES) {
    if (signature.headers?.some(has)) return signature.vendor;
    if (signature.body?.test(html)) return signature.vendor;
  }
  return null;
}

function parseRetryAfter(headers: Headers | Record<string, string> | null): number | null {
  if (!headers) return null;
  const raw =
    headers instanceof Headers
      ? headers.get('retry-after')
      : Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
  if (!raw) return null;

  // The header is either a count of seconds or an HTTP date.
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.round((at - Date.now()) / 1000));
}

export interface DiagnoseInput {
  status: number;
  headers?: Headers | Record<string, string> | null;
  /** The response body, when we have it. Diagnosis degrades without it. */
  html?: string;
  /**
   * True when the page returned 200 but nothing usable could be read from it.
   * That is how a soft block presents: a normal status hiding an interstitial.
   */
  extractionFailed?: boolean;
}

/**
 * Classify a refusal.
 *
 * Deliberately conservative: an unrecognised refusal comes back
 * `unclassified` rather than being guessed at, because a wrong diagnosis sends
 * someone off to buy a vendor subscription they did not need.
 */
export function diagnoseBlock(input: DiagnoseInput): BlockDiagnosis {
  const html = input.html ?? '';
  const headers = input.headers ?? null;
  const vendor = findVendor(headers, html);
  const retryAfterSeconds = parseRetryAfter(headers);
  const challenged = vendor !== null || CHALLENGE_COPY.test(html);

  if (input.status === 429) {
    return {
      cause: 'rate_limited',
      vendor,
      label: retryAfterSeconds
        ? `Rate limited — they asked us to wait ${retryAfterSeconds}s`
        : 'Rate limited — we asked for too much, too fast',
      remedy:
        'Ours to fix, and the cheapest fix on the list: raise this competitor\'s minDelayMs, ' +
        'drop maxConcurrent to 1, and spread the scan over more hours. A 429 means they are ' +
        'willing to serve us, just not at this rate.',
      retryAfterSeconds,
      vendorWouldHelp: false,
    };
  }

  if (input.status === 451 || GEO_COPY.test(html)) {
    return {
      cause: 'geo_or_legal',
      vendor,
      label: 'Blocked for legal or regional reasons',
      remedy:
        'No tool answers this one. If the site is genuinely unavailable to UK traffic it is not ' +
        'a source we can use; record it and move on.',
      retryAfterSeconds,
      vendorWouldHelp: false,
    };
  }

  if (input.status === 401) {
    return {
      cause: 'login_required',
      vendor,
      label: 'The page needs an account',
      remedy:
        'Out of scope, and deliberately so: reading a price behind a login is a different thing ' +
        'legally to reading a public page. If the price is only shown to signed-in customers, ' +
        'this competitor cannot be compared automatically.',
      retryAfterSeconds,
      vendorWouldHelp: false,
    };
  }

  // Checked before the challenge case below, and deliberately so. A soft block
  // *is* a challenge — the thing that makes it worth its own name is the 200,
  // which is what makes it masquerade as a layout change and send someone
  // hunting for a selector that was never wrong.
  if (input.status === 200) {
    if (!input.extractionFailed || !challenged) {
      return {
        cause: 'unclassified',
        vendor,
        label: 'Served a normal page',
        remedy:
          'Nothing here says we were blocked. If extraction failed on a page carrying no ' +
          'challenge markers at all, that is a layout change and belongs in the selectors, ' +
          'not in a conversation about access.',
        retryAfterSeconds,
        vendorWouldHelp: false,
      };
    }
    return {
      cause: 'soft_block',
      vendor,
      label: vendor
        ? `${vendor} served an interstitial under a normal 200`
        : 'Served a page, but not the product page',
      remedy:
        'A soft block: a normal status hiding an interstitial, which otherwise reads as a ' +
        'layout change. Compare the returned HTML against the page in a browser before ' +
        'touching the config — the selectors are probably fine.',
      retryAfterSeconds,
      vendorWouldHelp: true,
    };
  }

  if (challenged) {
    return {
      cause: 'bot_challenge',
      vendor,
      label: vendor
        ? `${vendor} is challenging us before serving the page`
        : 'A bot challenge is being served instead of the page',
      remedy:
        'Politeness will not clear this — the gate is on what we are, not how fast we ask. ' +
        'Three real options: ask the retailer for access (a named crawler is often whitelisted ' +
        'on request), take the same prices from a licensed product feed instead, or use a ' +
        'commercial unblocking service. Which is a commercial decision, not a technical one.',
      retryAfterSeconds,
      vendorWouldHelp: true,
    };
  }

  if (input.status === 403) {
    return {
      cause: 'ua_or_waf',
      vendor,
      label: 'Refused outright, with no challenge page',
      remedy:
        'Most often our identity rather than our behaviour: plenty of edge rules reject any ' +
        'user agent that is not a browser. Worth trying before anything else — set a real ' +
        'contact address in SCRAPER_USER_AGENT, or set this competitor to fetch with the ' +
        'browser identity. If it still refuses, treat it as a bot challenge.',
      retryAfterSeconds,
      vendorWouldHelp: true,
    };
  }

  return {
    cause: 'unclassified',
    vendor,
    label: `Refused with HTTP ${input.status}`,
    remedy:
      'Not a pattern this recognises. Capture the response and look at it before deciding — ' +
      'guessing here is how a fixable config problem turns into a vendor subscription.',
    retryAfterSeconds,
    vendorWouldHelp: false,
  };
}

/** One-line summary for a run item's error text. */
export function describeBlock(diagnosis: BlockDiagnosis): string {
  const vendor = diagnosis.vendor ? ` [${diagnosis.vendor}]` : '';
  return `${diagnosis.label}${vendor}. ${diagnosis.remedy}`;
}
