export interface Product {
  id: number;
  internal_sku: string;
  brand: string;
  product_name: string;
  ean_mpn: string | null;
  /** Null until a price file supplies it — the catalogue export carries no prices. */
  our_price: number | null;
  currency: string;
  category: string | null;
  our_product_url: string | null;
  specs: Record<string, string>;
}

export type PricePosition = 'lower' | 'equal' | 'higher';

export interface CompetitorPrice {
  competitorId: number;
  competitorName: string;
  competitorSlug: string;
  competitorHasLogo: boolean;
  price: number | null;
  wasPrice: number | null;
  promo: boolean;
  inStock: boolean | null;
  position: PricePosition | null;
  deltaAbs: number | null;
  deltaPct: number | null;
  sourceUrl: string;
  observedAt: string;
}

export interface ComparisonRow {
  product: Product;
  bestCompetitorPrice: number | null;
  bestCompetitorName: string | null;
  position: PricePosition | null;
  deltaAbs: number | null;
  deltaPct: number | null;
  observedAt: string | null;
  ourPriceMissing: boolean;
  competitorPrices: CompetitorPrice[];
  matchStatus: { confirmed: number; pending: number };
}

export interface ComparisonResponse {
  rows: ComparisonRow[];
  total: number;
  summary: {
    products: number;
    withCompetitorPrice: number;
    lower: number;
    equal: number;
    higher: number;
    unmatched: number;
    awaitingOurPrice: number;
    matchCoveragePct: number;
  };
}

export interface MatchEvidence {
  tier?: string;
  gatesPassed?: string[];
  gatesFailed?: string[];
  attributeHits?: { attribute: string; weight: string; ours: string; theirs: string }[];
  attributeMisses?: { attribute: string; weight: string; ours: string; theirs: string }[];
  nameSimilarity?: number;
  notes?: string[];
}

export interface MatchRow {
  id: number;
  product_id: number;
  competitor_id: number;
  competitor_url: string;
  competitor_title: string | null;
  competitor_ean: string | null;
  confidence: number;
  match_tier: string;
  status: 'pending' | 'confirmed' | 'rejected';
  evidence: MatchEvidence;
  internal_sku: string;
  brand: string;
  product_name: string;
  our_price: number | null;
  currency: string;
  category: string | null;
  ean_mpn: string | null;
  specs: Record<string, string>;
  competitor_name: string;
  competitor_slug: string;
}

export interface Competitor {
  id: number;
  slug: string;
  display_name: string;
  base_url: string;
  search_url_pattern: string;
  brands: string[];
  enabled: boolean;
  scrape_frequency: string;
  has_logo: boolean;
  logo_url: string | null;
  logo_fetched_at: string | null;
  logo_error: string | null;
}

export interface RobotsCheckRow {
  slug: string;
  name: string;
  enabled?: boolean;
  error?: string;
  origin?: string;
  status?: 'ok' | 'absent' | 'unreachable';
  failureDetail?: string | null;
  probe?: { url: string; allowed: boolean }[];
  crawlDelaySeconds?: number | null;
  sitemaps?: string[];
  disallowRules?: string[];
}

export interface RobotsCheckResult {
  userAgent: string;
  results: RobotsCheckRow[];
  summary: {
    searchAllowed: number;
    searchBlocked: number;
    unreachable: number;
    withSitemaps: number;
  };
}

export interface SitemapCheckRow {
  slug: string;
  name: string;
  error?: string | null;
  origin?: string;
  declared?: string[];
  fetched?: { url: string; ok: boolean; error: string | null; isIndex: boolean; urlCount: number }[];
  sampleUrls?: string[];
  totalUrls?: number;
}

export interface SitemapCheckResult {
  userAgent: string;
  results: SitemapCheckRow[];
  summary: { withUsableSitemap: number; declaringSitemaps: number; failed: number };
}

export interface Fascia {
  code: string;
  name: string;
  currency: string;
  priced: number;
}

export interface FeedImportResult {
  totalRows: number;
  skippedBlank: number;
  skippedHeaderRepeat: number;
  productsCreated: number;
  productsUpdated: number;
  pricesWritten: number;
  onSale: number;
  saleNotYetActive: number;
  failed: number;
  errors: { row: number; id: string | null; error: string }[];
  damagedGtin: number;
  damagedMpn: number;
  withUsableIdentifier: number;
  priceHidden: number;
  availability: Record<string, number>;
  fascia: { code: string; name: string };
  stalePricesRemoved: number;
  productsDelisted: number;
  productsRelisted: number;
  feedImportId: number;
}

export interface SystemStatus {
  catalogue: {
    products: number;
    withPrice: number;
    awaitingPrice: number;
    brands: number;
    lastImportedAt: string | null;
    delisted: number;
  };
  competitors: { total: number; enabled: number; withLogo: number };
  fasciaCoverage: { code: string; name: string; priced: number; missing: number }[];
  matching: { confirmed: number; pending: number; rejected: number; productsMatched: number };
  observations: { total: number; lastObservedAt: string | null };
  runs: { total: number; lastRunAt: string | null; lastRunStatus: string | null };
  schema: { migrations: string[]; appliedAt: string | null };
}

export interface LogoRefreshResult {
  slug: string;
  displayName: string;
  status: 'fetched' | 'unchanged' | 'failed';
  source?: string;
  bytes?: number;
  error?: string;
}

export interface ScrapeRun {
  id: number;
  trigger: string;
  status: 'running' | 'completed' | 'failed';
  competitor_name?: string | null;
  /** Set when the run was aimed at a single product for testing. */
  product_sku?: string | null;
  product_name?: string | null;
  ok_count: number;
  error_count: number;
  skipped_count: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface RunItem {
  id: number;
  url: string | null;
  status: 'ok' | 'error' | 'skipped';
  error_kind: string | null;
  error: string | null;
  duration_ms: number | null;
  internal_sku: string | null;
  product_name: string | null;
  competitor_name: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly kind: string | undefined;

  constructor(message: string, status: number, kind?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...init?.headers,
    },
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }

  if (!response.ok) {
    const body = payload as { error?: string; kind?: string } | null;
    throw new ApiError(body?.error ?? `Request failed (${response.status})`, response.status, body?.kind);
  }

  return payload as T;
}

const qs = (params: Record<string, string | number | null | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
};

export const api = {
  session: () => request<{ authEnabled: boolean; authenticated: boolean }>('/api/auth/session'),
  login: (password: string) =>
    request<{ authenticated: boolean }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  logout: () => request<unknown>('/api/auth/logout', { method: 'POST' }),

  comparison: (filters: Record<string, string | number | null | undefined>) =>
    request<ComparisonResponse>(`/api/comparison${qs(filters)}`),

  facets: () => request<{ brands: string[]; categories: string[] }>('/api/products/facets'),

  productHistory: (productId: number) =>
    request<{
      observations: (CompetitorPrice & {
        id: number;
        competitor_name: string;
        competitor_slug: string;
        competitor_has_logo: boolean;
        price: number | null;
        observed_at: string;
      })[];
    }>(
      `/api/products/${productId}/history`,
    ),


  deleteRun: (id: number) =>
    request<{ deleted: number; observationsKept: number }>(`/api/runs/${id}`, { method: 'DELETE' }),

  deleteFinishedRuns: () =>
    request<{ deleted: number; skippedRunning: boolean }>('/api/runs', { method: 'DELETE' }),

  fascias: () => request<{ fascias: Fascia[] }>('/api/admin/fascias'),

  removeCompetitorPrice: (productId: number, competitorId: number) =>
    request<{ observationsRemoved: number; matchesRemoved: number }>(
      `/api/comparison/product/${productId}/competitor/${competitorId}`,
      { method: 'DELETE' },
    ),

  addProduct: (body: {
    internalSku: string;
    brand: string;
    productName: string;
    eanMpn?: string;
    referenceNumber?: string;
    category?: string;
    ourProductUrl?: string;
    price?: string;
    fascia?: string;
  }) =>
    request<{ productId: number; internalSku: string }>('/api/products', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteProduct: (productId: number) =>
    request<{ deleted: string; observationsRemoved: number }>(`/api/products/${productId}`, {
      method: 'DELETE',
    }),

  deleteAllProducts: () =>
    request<{ deleted: number }>('/api/products', { method: 'DELETE' }),

  removeProductComparisons: (productId: number) =>
    request<{ observationsRemoved: number; matchesRemoved: number }>(
      `/api/comparison/product/${productId}`,
      { method: 'DELETE' },
    ),

  clearAllComparisons: () =>
    request<{ observationsRemoved: number; matchesRemoved: number }>(
      '/api/comparison/observations',
      { method: 'DELETE' },
    ),

  importFeed: (file: File, fasciaCode: string) => {
    const form = new FormData();
    form.append('file', file);
    return request<FeedImportResult>(
      `/api/products/import-feed?fascia=${encodeURIComponent(fasciaCode)}`,
      { method: 'POST', body: form },
    );
  },

  systemStatus: () => request<SystemStatus>('/api/admin/status'),

  robotsCheck: () => request<RobotsCheckResult>('/api/admin/robots-check', { method: 'POST' }),

  sitemapCheck: () =>
    request<SitemapCheckResult>('/api/admin/sitemap-check', { method: 'POST' }),

  uploadLogo: (slug: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ slug: string; contentType: string; bytes: number }>(
      `/api/competitors/${encodeURIComponent(slug)}/logo`,
      { method: 'POST', body: form },
    );
  },

  clearLogo: (slug: string) =>
    request<{ slug: string; cleared: boolean }>(
      `/api/competitors/${encodeURIComponent(slug)}/logo`,
      { method: 'DELETE' },
    ),

  refreshLogos: (force = false) =>
    request<{ results: LogoRefreshResult[]; fetched: number; failed: number; unchanged: number }>(
      `/api/competitors/refresh-logos${force ? '?force=1' : ''}`,
      { method: 'POST' },
    ),



  matches: (status: string, fascia?: string | null) =>
    request<{ matches: MatchRow[]; total: number; fascia: { code: string; name: string } | null }>(
      `/api/matches${qs({ status, fascia: fascia ?? null })}`,
    ),
  confirmMatch: (id: number) => request<{ match: MatchRow }>(`/api/matches/${id}/confirm`, { method: 'POST' }),
  rejectMatch: (id: number) => request<{ match: MatchRow }>(`/api/matches/${id}/reject`, { method: 'POST' }),
  linkMatch: (productId: number, competitorId: number, url: string) =>
    request<{ match: MatchRow }>('/api/matches', {
      method: 'POST',
      body: JSON.stringify({ productId, competitorId, url }),
    }),

  competitors: () => request<{ competitors: Competitor[] }>('/api/competitors'),
  syncCompetitors: () => request<{ synced: { slug: string; action: string }[] }>('/api/competitors/sync', { method: 'POST' }),
  toggleCompetitor: (slug: string, enabled: boolean) =>
    request<{ competitor: Competitor }>(`/api/competitors/${slug}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  testUrl: (slug: string, url: string) =>
    request<{ ok: boolean; finalUrl: string; renderedWith: string; robots: { allowed: boolean; reason: string }; extracted: Record<string, unknown> }>(
      `/api/competitors/${slug}/test-url`,
      { method: 'POST', body: JSON.stringify({ url }) },
    ),

  runs: () => request<{ runs: ScrapeRun[]; activeRunId: number | null }>('/api/runs'),
  run: (id: number) => request<{ run: ScrapeRun; items: RunItem[] }>(`/api/runs/${id}`),
  startRun: (body: {
    mode: string;
    competitorId?: number | null;
    limit?: number | null;
    productId?: number | null;
    sku?: string;
    forceHarvest?: boolean;
  }) =>
    request<{ run: ScrapeRun }>('/api/runs', { method: 'POST', body: JSON.stringify(body) }),
  recentErrors: () =>
    request<{ errors: (RunItem & { run_id: number; created_at: string })[] }>('/api/runs/errors/recent'),
};

export function formatMoney(value: number | null | undefined, currency = 'GBP'): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value);
}

export function formatPct(value: number | null | undefined): string {
  if (value == null) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return 'never';
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
