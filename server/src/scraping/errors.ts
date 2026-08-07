/**
 * Scrape failures are typed so a competitor changing their page layout surfaces
 * as a loud, attributable error rather than a silently wrong price (Spec §5.4).
 */
export type ScrapeErrorKind =
  | 'robots_disallowed'
  | 'blocked'
  | 'not_found'
  | 'http_error'
  | 'timeout'
  | 'navigation_failed'
  | 'layout_changed'
  | 'no_price_found'
  | 'implausible_price'
  | 'invalid_url'
  | 'unknown';

export class ScrapeError extends Error {
  readonly kind: ScrapeErrorKind;
  readonly url: string | undefined;
  /** Retrying a transient failure is worthwhile; a layout change is not. */
  readonly retryable: boolean;

  constructor(
    kind: ScrapeErrorKind,
    message: string,
    options: { url?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ScrapeError';
    this.kind = kind;
    this.url = options.url;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE.has(kind);
  }
}

const DEFAULT_RETRYABLE = new Set<ScrapeErrorKind>(['timeout', 'navigation_failed', 'http_error']);

/**
 * Spec §9: a site actively blocking automated access is a signal to reconsider
 * that source, not to escalate. These statuses are never retried and never
 * worked around.
 */
export function isBlockingStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status === 451;
}
