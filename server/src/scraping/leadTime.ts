/**
 * What a product page says about how soon the product arrives: "Next day",
 * "1-2 weeks", "4-6 weeks".
 *
 * A cheaper competitor that takes six weeks to deliver is a different
 * proposition from one that delivers tomorrow, so the lead time is read
 * alongside the price. Written against what the three main competitors and our
 * own sites published on 18 November 2026:
 *
 *  - Beaverbrooks: the delivery date, in page data (`nddCountdown.leadTime`).
 *  - Ernest Jones: the delivery date, shown as "Estimated Express Delivery
 *    Friday 20th November."
 *  - Fraser Hart: "Order within … for delivery tomorrow" when in stock, and a
 *    sentence in the description for a pre-order ("Estimated delivery for this
 *    model is 1-2 weeks").
 *  - Our sites: a short message per product ("Next Day Delivery",
 *    "1-2 Business Days").
 *
 * Nothing is reported for a product that is out of stock: it cannot be
 * delivered at all, and the site-wide delivery promise on its page is not
 * about it.
 */
export interface LeadTime {
  /** As shown to the user: "Next day", "1-2 weeks". */
  text: string;
  /** Days until it has arrived — the end of a stated range — for comparing one retailer with another. */
  days: number | null;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const dayNumber = (date: Date) => Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000);

/**
 * A lead time from the date a retailer says the product will arrive.
 *
 * A next-day service read in the evening, after that day's cut-off, shows the
 * day after tomorrow — and one read on a Saturday shows Monday. Both are still
 * the retailer's next-day service (Beaverbrooks heads its date "Free next day
 * delivery"), so they are reported as "Next day" rather than as two or three
 * days, which would make a retailer look slower purely because of the hour
 * the page was read.
 */
export function leadFromDate(delivery: Date, now: Date): LeadTime | null {
  const days = dayNumber(delivery) - dayNumber(now);
  if (!Number.isFinite(days) || days < 0 || days > 400) return null;
  let crossesSunday = false;
  for (let offset = 1; offset < days; offset += 1) {
    if (new Date((dayNumber(now) + offset) * 86_400_000).getUTCDay() === 0) crossesSunday = true;
  }
  if (days <= 2 || (days === 3 && crossesSunday)) return { text: 'Next day', days: 1 };
  if (days < 14) return { text: `${days} days`, days };
  const weeks = Math.round(days / 7);
  return { text: `About ${weeks} weeks`, days };
}

/** "Friday 20th November" → that date, in the year that puts it nearest ahead of now. */
export function parseDayMonth(text: string, now: Date): Date | null {
  const match = text.toLowerCase().match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})/);
  if (!match) return null;
  const month = MONTHS.findIndex((name) => name.startsWith(match[2]!));
  const day = Number(match[1]);
  if (month < 0 || day < 1 || day > 31) return null;
  let date = new Date(Date.UTC(now.getUTCFullYear(), month, day));
  // "3rd January" read in December is next year's.
  if (dayNumber(date) < dayNumber(now) - 7) date = new Date(Date.UTC(now.getUTCFullYear() + 1, month, day));
  return date;
}

/** A short delivery message — "Next Day Delivery", "1-2 Business Days", "4-6 weeks" — as a lead time. */
export function leadFromPhrase(phrase: string | null | undefined): LeadTime | null {
  const text = (phrase ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return null;
  if (/\b(next|following)[ -]day\b|\btomorrow\b/.test(text)) return { text: 'Next day', days: 1 };
  if (/\bsame[ -]day\b/.test(text)) return { text: 'Same day', days: 0 };
  const match = text.match(/\b(\d{1,2})(?:\s*(?:-|–|—|to)\s*(\d{1,2}))?\s*(weeks?|months?|working days?|business days?|days?)\b/);
  if (!match) return null;
  const low = Number(match[1]);
  const high = match[2] != null ? Number(match[2]) : null;
  if (low <= 0 || (high != null && high < low)) return null;
  const unit = match[3]!;
  const range = high != null ? `${low}-${high}` : `${low}`;
  if (unit.startsWith('week')) return { text: `${range} ${high == null && low === 1 ? 'week' : 'weeks'}`, days: (high ?? low) * 7 };
  if (unit.startsWith('month')) return { text: `${range} ${high == null && low === 1 ? 'month' : 'months'}`, days: (high ?? low) * 30 };
  const working = unit.startsWith('working') || unit.startsWith('business');
  if (high == null && low === 1) return { text: 'Next day', days: 1 };
  return { text: `${range} ${working ? 'working days' : 'days'}`, days: high ?? low };
}

/**
 * A sentence that states a delivery time for the product itself. The words
 * before the number are what make it one: "Estimated delivery for this model
 * is 1-2 weeks", "dispatched within 4-6 weeks", "made to order … 3 weeks". A
 * bare "30 days" (returns, finance) is not picked up.
 */
const STATED =
  /(?:estimated (?:delivery|dispatch)|deliver(?:y|ed)\s+(?:is\s+|time\s+(?:is\s+)?)?(?:with)?in|dispatch(?:ed)?\s+(?:with)?in|lead[ -]?time|made to order|special order|ships?\s+(?:with)?in|available (?:with)?in)[^.<>!?]{0,60}?\b(\d{1,2}(?:\s*(?:-|–|—|to)\s*\d{1,2})?\s*(?:weeks?|months?|working days?|business days?|days?))\b/i;

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ');
}

export interface LeadTimeContext {
  /** false: out of stock. */
  inStock: boolean | null;
  /** The availability as the page gives it, e.g. "https://schema.org/PreOrder". */
  availabilityText?: string | null;
  /** When the page was read. */
  now?: Date;
}

/** The lead time a competitor's product page states, or null when it states none. */
export function readLeadTime(html: string, context: LeadTimeContext): LeadTime | null {
  if (context.inStock === false) return null;
  const now = context.now ?? new Date();
  const preOrder = /pre-?order|backorder/i.test(context.availabilityText ?? '');

  if (!preOrder) {
    // Beaverbrooks: the promised delivery date, beside the site's own clock.
    const promised = html.match(/"nddCountdown"\s*:\s*\[\s*\{[^\]]*?"leadTime"\s*:\s*"(\d{4}-\d\d-\d\dT[^"]+)"/)?.[1];
    if (promised) {
      const siteNow = html.match(/"currentDateTime"\s*:\s*"(\d{4}-\d\d-\d\dT[^"]+)"/)?.[1];
      const lead = leadFromDate(new Date(promised), siteNow ? new Date(siteNow) : now);
      if (lead) return lead;
    }

    // Ernest Jones (and H.Samuel, the same shop software): the date as shown.
    const shown = html.match(/class="[^"]*\bdelivery-date\b[^"]*"[^>]*>([^<]{4,40})</)?.[1];
    if (shown) {
      const date = parseDayMonth(shown, now);
      const lead = date ? leadFromDate(date, now) : null;
      if (lead) return lead;
    }
  }

  // A sentence stating a delivery time for this product.
  const stated = visibleText(html).match(STATED)?.[1];
  const fromSentence = leadFromPhrase(stated);
  if (fromSentence) {
    return preOrder ? { text: `Pre-order, ${fromSentence.text}`, days: fromSentence.days } : fromSentence;
  }
  if (preOrder) return { text: 'Pre-order', days: null };

  // Fraser Hart: "Order within 03:12:45 for delivery tomorrow".
  if (context.inStock === true && /for\s*(?:<[^>]+>\s*)*delivery tomorrow/i.test(html)) {
    return { text: 'Next day', days: 1 };
  }
  return null;
}
