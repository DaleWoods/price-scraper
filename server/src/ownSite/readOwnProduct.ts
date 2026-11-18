import { env } from '../config/env.js';
import { checkRobots } from '../scraping/robots.js';
import { siteFetch } from '../scraping/httpClient.js';

/**
 * Reading one of our own product pages: Goldsmiths, Mappin & Webb, Watches of
 * Switzerland.
 *
 * This is what lets someone paste a URL or a SKU and nothing else. All three
 * sites run on the same platform and serve every product at `/p/<SKU>`. The
 * page carries what we need twice over: a `dataLayerProduct` element with the
 * name, brand, price and stock as attributes (the analytics feed), and the
 * page's own state as JSON in `<script id="ng-state">`, which also holds the
 * manufacturer's reference and any previous price.
 *
 * What it does not carry is a barcode. Competitors that publish only a barcode
 * (Ernest Jones, H.Samuel) are reached by taking it from a retailer that
 * publishes both — see adoptBarcode() in matching/discovery.ts.
 */

import { leadFromPhrase } from '../scraping/leadTime.js';

export interface OwnSite {
  fasciaCode: string;
  name: string;
  origin: string;
}

/** Ours. The codes are the ones the Google feeds and `fascias` use. */
export const OWN_SITES: OwnSite[] = [
  { fasciaCode: '197', name: 'Goldsmiths', origin: 'https://www.goldsmiths.co.uk' },
  { fasciaCode: '439', name: 'Mappin & Webb', origin: 'https://www.mappinandwebb.com' },
  { fasciaCode: '470', name: 'Watches of Switzerland', origin: 'https://www.watches-of-switzerland.co.uk' },
];

export interface OwnProduct {
  fasciaCode: string;
  siteName: string;
  sku: string;
  name: string;
  brand: string;
  category: string | null;
  price: number;
  /** The price before a reduction, when the page shows one. */
  wasPrice: number | null;
  inStock: boolean | null;
  /** How soon it arrives, as our page states it ("Next day", "1-2 working days"), and that in days. */
  leadText: string | null;
  leadDays: number | null;
  mpn: string | null;
  url: string;
  imageUrl: string | null;
}

/** Which of our sites an address belongs to, or null if none. */
export function ownSiteFor(url: string): OwnSite | null {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  return OWN_SITES.find((site) => new URL(site.origin).host.replace(/^www\./, '') === host) ?? null;
}

/** The SKU in one of our product addresses: the part after `/p/`. */
export function skuFromUrl(url: string): string | null {
  try {
    return new URL(url).pathname.match(/\/p\/([A-Za-z0-9]+)\/?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Unescape an HTML attribute value. */
function attribute(tag: string, name: string): string | null {
  const raw = tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
  if (raw == null) return null;
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/** Find the product's own record in the page state: the object whose `code` is the SKU. */
function findStateProduct(html: string, sku: string): Record<string, unknown> | null {
  const raw = html.match(/<script id="ng-state" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  if (!raw) return null;
  let state: unknown;
  try {
    state = JSON.parse(raw);
  } catch {
    return null;
  }

  // The page holds several partial copies of the product (one with the
  // reference, another with the images); they are merged. Recommendations
  // elsewhere on the page are products too, with their own codes, so only
  // copies whose code is ours count.
  const copies: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 40 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.code === sku) copies.push(node);
    for (const child of Object.values(node)) visit(child, depth + 1);
  };
  visit(state, 0);
  if (copies.length === 0) return null;
  const merged: Record<string, unknown> = {};
  for (const copy of copies) {
    for (const [key, value] of Object.entries(copy)) {
      if (merged[key] == null || (Array.isArray(merged[key]) && (merged[key] as unknown[]).length === 0)) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function money(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? Math.round(number * 100) / 100 : null;
}

/** Read the product at an address on one of our sites. Null when there is no product there. */
export async function readOwnProductPage(url: string): Promise<OwnProduct | null> {
  const site = ownSiteFor(url);
  if (!site) return null;

  const robots = await checkRobots(url, env.scraperUserAgent);
  if (!robots.allowed) throw new Error(`Our own robots.txt does not allow ${url}: ${robots.reason}`);

  const response = await siteFetch(url, {
    headers: {
      'user-agent': env.scraperUserAgent,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-GB,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(env.requestTimeoutMs),
  });
  if (response.status === 404 || response.status === 410) return null;
  if (response.status !== 200) {
    throw new Error(`${site.name} answered HTTP ${response.status} for ${url}`);
  }
  const html = await response.text();

  const tag = html.match(/<div class="datalayer dataLayerProduct"[^>]*>/)?.[0];
  if (!tag) return null;
  const sku = attribute(tag, 'data-product-id');
  const name = attribute(tag, 'data-product-name');
  if (!sku || !name) return null;

  const state = findStateProduct(html, sku);
  const statePrice = (state?.price ?? null) as Record<string, unknown> | null;
  const price = money(attribute(tag, 'data-product-price')) ?? money(statePrice?.value);
  if (price == null) return null;

  const was = money(statePrice?.wasValue);
  const stock = attribute(tag, 'data-product-stock-status');
  const images = state?.aurumImages as { url?: string }[] | undefined;
  const canonical = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/)?.[1];
  const mpnFromState = typeof state?.mpn === 'string' ? state.mpn.trim() : '';

  // Our pages carry the delivery message with the product's stock details:
  // "Next Day Delivery", "1-2 Business Days". An out-of-stock product has none.
  const stockState = (state?.stock ?? null) as Record<string, unknown> | null;
  const lead = leadFromPhrase(
    typeof stockState?.shortProductDeliveryMessage === 'string'
      ? stockState.shortProductDeliveryMessage
      : typeof stockState?.productDeliveryMessage === 'string'
        ? stockState.productDeliveryMessage
        : null,
  );


  return {
    leadText: lead?.text ?? null,
    leadDays: lead?.days ?? null,
    fasciaCode: site.fasciaCode,
    siteName: site.name,
    sku,
    name,
    brand: attribute(tag, 'data-product-brand') || String(state?.manufacturer ?? '') || 'Unknown',
    category: attribute(tag, 'data-product-type') || null,
    price,
    wasPrice: statePrice?.hasWasPrice === true && was != null && was > price ? was : null,
    inStock: stock ? /in stock/i.test(stock) : null,
    mpn: mpnFromState || null,
    url: canonical && ownSiteFor(canonical) ? canonical : response.url || url,
    imageUrl: images?.[0]?.url ?? null,
  };
}

/**
 * Find one of our products by SKU, trying the site asked for first and then
 * the others: a SKU is shared across our sites, but not every product is on
 * every one of them.
 */
export async function readOwnProductBySku(
  sku: string,
  preferredFasciaCode?: string | null,
): Promise<OwnProduct | null> {
  const sites = [...OWN_SITES].sort(
    (a, b) => Number(b.fasciaCode === preferredFasciaCode) - Number(a.fasciaCode === preferredFasciaCode),
  );
  for (const site of sites) {
    const product = await readOwnProductPage(`${site.origin}/p/${encodeURIComponent(sku)}`);
    if (product) return product;
  }
  return null;
}
