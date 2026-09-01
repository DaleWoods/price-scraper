/**
 * Plain-English names for the typed scrape failures the server records in
 * `scrape_run_items.error_kind`.
 *
 * One definition, shared by every surface that shows a failure — a run's detail
 * table and the scrape-health report. Two copies of these strings drift, and
 * then the same failure reads as two different things depending which page you
 * happen to be on.
 */
export const ERROR_KIND_COPY: Record<string, string> = {
  robots_disallowed: 'Blocked by robots.txt',
  blocked: 'Site actively blocked us',
  not_found: 'Listing 404s',
  layout_changed: 'Page layout changed',
  no_price_found: 'No price on the page',
  implausible_price: 'Price failed sanity check',
  timeout: 'Timed out',
  http_error: 'HTTP error',
  navigation_failed: 'Navigation failed',
  brand_not_stocked: 'Brand not stocked',
  not_listed: 'Not in their listings',
};

/** The human label for an error kind, falling back to the raw kind itself. */
export function errorKindLabel(kind: string | null | undefined): string {
  if (!kind) return '—';
  return ERROR_KIND_COPY[kind] ?? kind;
}
