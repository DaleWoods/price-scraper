import * as cheerio from 'cheerio';
import type { Competitor, SpecAttributes } from '../domain/types.js';
import { canonicalAttributeName } from '../matching/attributes.js';
import { ScrapeError } from './errors.js';
import type { FetchedPage } from './fetcher.js';

export interface ExtractedListing {
  title: string | null;
  price: number | null;
  wasPrice: number | null;
  currency: string;
  promo: boolean;
  inStock: boolean | null;
  availabilityText: string | null;
  ean: string | null;
  brand: string | null;
  attributes: SpecAttributes;
  /** Which path produced the price — useful when diagnosing a layout change. */
  source: 'json-ld' | 'selector' | 'none';
}

const MAX_PLAUSIBLE_PRICE = 5_000_000;

/** "£1,234.00", "1.234,00 GBP", "From £950" -> 1234 / 950 */
export function parsePrice(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const text = String(raw).replace(/ /g, ' ').trim();
  if (!text) return null;

  const match = text.match(/(\d[\d.,\s]*\d|\d)/);
  if (!match?.[1]) return null;

  let digits = match[1].replace(/\s/g, '');

  // Decide which separator is the decimal point by looking at the last one.
  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');
  if (lastComma > lastDot) {
    digits = digits.replace(/\./g, '').replace(',', '.');
  } else {
    digits = digits.replace(/,/g, '');
  }

  const value = Number.parseFloat(digits);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100) / 100;
}

function firstText($: cheerio.CheerioAPI, selectors: string[] | undefined): string | null {
  for (const selector of selectors ?? []) {
    const element = $(selector).first();
    if (element.length === 0) continue;

    const content = element.attr('content') ?? element.attr('data-price') ?? element.text();
    const text = content?.replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return null;
}

/** Flatten schema.org graphs so @graph / arrays / nested nodes are all reachable. */
function collectJsonLdNodes($: cheerio.CheerioAPI): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];

  const visit = (value: unknown, depth = 0): void => {
    if (depth > 6 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const node = value as Record<string, unknown>;
    nodes.push(node);
    for (const key of ['@graph', 'offers', 'mainEntity', 'itemListElement', 'hasVariant']) {
      if (key in node) visit(node[key], depth + 1);
    }
  };

  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).contents().text().trim();
    if (!raw) return;
    try {
      visit(JSON.parse(raw));
    } catch {
      // Malformed JSON-LD is common; selectors remain as the fallback path.
    }
  });

  return nodes;
}

function typeOf(node: Record<string, unknown>): string[] {
  const raw = node['@type'];
  if (typeof raw === 'string') return [raw.toLowerCase()];
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase());
  return [];
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    const named = value as Record<string, unknown>;
    if (typeof named.name === 'string') return named.name.trim() || null;
    if (typeof named['@value'] === 'string') return (named['@value'] as string).trim() || null;
  }
  return null;
}

interface JsonLdProduct {
  title: string | null;
  price: number | null;
  currency: string | null;
  availability: string | null;
  ean: string | null;
  brand: string | null;
  attributes: SpecAttributes;
}

function extractFromJsonLd($: cheerio.CheerioAPI): JsonLdProduct | null {
  const nodes = collectJsonLdNodes($);
  const product = nodes.find((node) => typeOf(node).some((t) => t === 'product' || t === 'individualproduct'));
  if (!product) return null;

  const offerNode =
    nodes.find((node) => typeOf(node).some((t) => t === 'offer' || t === 'aggregateoffer')) ?? null;

  const price =
    parsePrice(asString(offerNode?.price)) ??
    parsePrice(asString(offerNode?.lowPrice)) ??
    parsePrice(asString((offerNode?.priceSpecification as Record<string, unknown>)?.price));

  const attributes: SpecAttributes = {};
  const properties = product.additionalProperty;
  if (Array.isArray(properties)) {
    for (const entry of properties) {
      if (!entry || typeof entry !== 'object') continue;
      const property = entry as Record<string, unknown>;
      const name = asString(property.name);
      const value = asString(property.value);
      if (name && value) attributes[canonicalAttributeName(name)] = value;
    }
  }
  for (const [key, target] of [
    ['color', 'dial_colour'],
    ['material', 'case_material'],
    ['size', 'case_size'],
    ['model', 'model'],
  ] as const) {
    const value = asString(product[key]);
    if (value && !attributes[target]) attributes[target] = value;
  }

  return {
    title: asString(product.name),
    price: price ?? null,
    currency: asString(offerNode?.priceCurrency) ?? asString(product.priceCurrency),
    availability: asString(offerNode?.availability),
    ean:
      asString(product.gtin13) ??
      asString(product.gtin) ??
      asString(product.gtin12) ??
      asString(product.gtin8) ??
      asString(product.mpn) ??
      asString(product.sku),
    brand: asString(product.brand),
    attributes,
  };
}

function interpretAvailability(text: string | null): boolean | null {
  if (!text) return null;
  const value = text.toLowerCase();
  if (/outofstock|out of stock|sold\s*out|unavailable|discontinued/.test(value)) return false;
  if (/instock|in stock|available|limitedavailability|preorder|pre-order|backorder/.test(value)) return true;
  return null;
}

/**
 * Turn a fetched product page into a listing. Throws a typed ScrapeError when the
 * page can't be understood, so a competitor layout change surfaces as a scrape
 * error rather than a silently wrong price (Spec §5.4).
 */
export function extractListing(competitor: Competitor, page: FetchedPage): ExtractedListing {
  const $ = cheerio.load(page.html);
  const config = competitor.config.product ?? {};
  const selectors = config.selectors ?? {};

  // A page that redirected away from the product URL (to search, or a category)
  // is a dead listing, not a price of zero.
  const sanity = config.sanityContains ?? [];
  if (sanity.length > 0 && !sanity.some((selector) => $(selector).length > 0)) {
    throw new ScrapeError(
      'layout_changed',
      `None of the expected product-page markers (${sanity.join(', ')}) were present on ${page.finalUrl}. ` +
        'The page layout has probably changed — selectors need review before these prices can be trusted.',
      { url: page.finalUrl, retryable: false },
    );
  }

  const jsonLd = config.useJsonLd === false ? null : extractFromJsonLd($);

  const selectorPrice = parsePrice(firstText($, selectors.price));
  const price = jsonLd?.price ?? selectorPrice;
  const source: ExtractedListing['source'] = jsonLd?.price != null ? 'json-ld' : selectorPrice != null ? 'selector' : 'none';

  if (price == null) {
    throw new ScrapeError(
      'no_price_found',
      `No price found on ${page.finalUrl}. Tried JSON-LD and selectors [${(selectors.price ?? []).join(', ')}]. ` +
        'Either the listing is gone or the page layout has changed.',
      { url: page.finalUrl, retryable: false },
    );
  }
  if (price <= 0 || price > MAX_PLAUSIBLE_PRICE) {
    throw new ScrapeError(
      'implausible_price',
      `Extracted price ${price} from ${page.finalUrl} is outside the plausible range — refusing to record it.`,
      { url: page.finalUrl, retryable: false },
    );
  }

  const wasPrice = parsePrice(firstText($, selectors.wasPrice));
  const availabilityText = firstText($, selectors.availability) ?? jsonLd?.availability ?? null;
  const promoBadge = firstText($, selectors.promoBadge);

  const attributes: SpecAttributes = { ...(jsonLd?.attributes ?? {}) };
  // Spec tables: <dt>/<dd> and two-cell <tr> are the two common shapes.
  $('dl dt').each((_, element) => {
    const key = $(element).text().replace(/\s+/g, ' ').trim();
    const value = $(element).next('dd').text().replace(/\s+/g, ' ').trim();
    if (key && value && key.length < 60) attributes[canonicalAttributeName(key)] ??= value;
  });
  $('table tr').each((_, element) => {
    const cells = $(element).find('th, td');
    if (cells.length !== 2) return;
    const key = $(cells[0]).text().replace(/\s+/g, ' ').trim();
    const value = $(cells[1]).text().replace(/\s+/g, ' ').trim();
    if (key && value && key.length < 60) attributes[canonicalAttributeName(key)] ??= value;
  });

  return {
    title: jsonLd?.title ?? firstText($, selectors.title) ?? ($('h1').first().text().trim() || null),
    price,
    wasPrice: wasPrice && wasPrice > price ? wasPrice : null,
    currency: jsonLd?.currency ?? 'GBP',
    promo: Boolean(promoBadge) || (wasPrice != null && wasPrice > price),
    inStock: interpretAvailability(availabilityText),
    availabilityText,
    ean: jsonLd?.ean ?? firstText($, selectors.ean),
    brand: jsonLd?.brand ?? null,
    attributes,
    source,
  };
}

export interface SearchResult {
  url: string;
  title: string;
  price: number | null;
}

/** Parse a competitor search-results page into candidate listings (Spec §5.4). */
export function extractSearchResults(competitor: Competitor, page: FetchedPage): SearchResult[] {
  const $ = cheerio.load(page.html);
  const config = competitor.config.search ?? {};
  const maxCandidates = config.maxCandidates ?? 10;
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  const containerSelector = (config.resultItem ?? []).join(', ');
  if (!containerSelector) return results;

  $(containerSelector).each((_, element) => {
    if (results.length >= maxCandidates) return false;

    const item = $(element);
    const linkSelector = (config.resultLink ?? ['a']).join(', ');
    const href = item.find(linkSelector).first().attr('href') ?? item.attr('href');
    if (!href) return;

    let absolute: string;
    try {
      absolute = new URL(href, competitor.base_url).toString();
    } catch {
      return;
    }
    if (seen.has(absolute)) return;
    seen.add(absolute);

    const titleSelector = (config.resultTitle ?? []).join(', ');
    const title =
      (titleSelector ? item.find(titleSelector).first().text() : '') ||
      item.find('a').first().attr('title') ||
      item.text();

    const priceSelector = (config.resultPrice ?? []).join(', ');
    const price = priceSelector ? parsePrice(item.find(priceSelector).first().text()) : null;

    results.push({
      url: absolute,
      title: title.replace(/\s+/g, ' ').trim().slice(0, 300),
      price,
    });
    return;
  });

  return results;
}
