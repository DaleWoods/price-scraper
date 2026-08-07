/** Open/extensible spec attributes from the master catalogue export (Spec §5.1). */
export type SpecAttributes = Record<string, string>;

export interface Product {
  id: number;
  internal_sku: string;
  brand: string;
  product_name: string;
  ean_mpn: string | null;
  our_price: number;
  currency: string;
  category: string | null;
  our_product_url: string | null;
  specs: SpecAttributes;
  created_at: string;
  updated_at: string;
}

/**
 * A competitor is a row plus a JSONB config blob — adding a retailer is
 * configuration, not code (Spec §5.2). See competitors/*.json for the shape.
 */
export interface CompetitorConfig {
  /** 'http' uses fetch + cheerio; 'browser' uses Playwright for JS-rendered pages. */
  rendering: 'http' | 'browser';
  userAgent?: string;
  rateLimit?: {
    minDelayMs?: number;
    jitterMs?: number;
    maxConcurrent?: number;
  };
  retry?: {
    attempts?: number;
    backoffMs?: number;
  };
  product?: {
    /** Prefer schema.org JSON-LD when the site publishes it — far more stable than CSS. */
    useJsonLd?: boolean;
    selectors?: {
      title?: string[];
      price?: string[];
      wasPrice?: string[];
      availability?: string[];
      promoBadge?: string[];
      ean?: string[];
    };
    /** Page must contain one of these for the scrape to be trusted; else it's an error. */
    sanityContains?: string[];
  };
  search?: {
    resultItem?: string[];
    resultLink?: string[];
    resultTitle?: string[];
    resultPrice?: string[];
    maxCandidates?: number;
  };
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
  config: CompetitorConfig;
  created_at: string;
  updated_at: string;
}

export type MatchStatus = 'pending' | 'confirmed' | 'rejected';
export type MatchTier = 'ean_mpn_exact' | 'brand_spec_attributes' | 'fuzzy_name_specs' | 'manual';

export interface ProductMatch {
  id: number;
  product_id: number;
  competitor_id: number;
  competitor_url: string;
  competitor_title: string | null;
  competitor_ean: string | null;
  confidence: number;
  match_tier: MatchTier;
  status: MatchStatus;
  evidence: MatchEvidence;
  confirmed_at: string | null;
  confirmed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface MatchEvidence {
  tier?: MatchTier;
  gatesPassed?: string[];
  gatesFailed?: string[];
  attributeHits?: { attribute: string; weight: string; ours: string; theirs: string }[];
  attributeMisses?: { attribute: string; weight: string; ours: string; theirs: string }[];
  nameSimilarity?: number;
  notes?: string[];
}

export interface PriceObservation {
  id: number;
  product_id: number;
  competitor_id: number;
  match_id: number | null;
  scrape_run_id: number | null;
  price: number | null;
  was_price: number | null;
  currency: string;
  promo: boolean;
  in_stock: boolean | null;
  availability_text: string | null;
  source_url: string;
  observed_at: string;
}

export type PricePosition = 'lower' | 'equal' | 'higher';

/** One row of the comparison view (Spec §5.5). */
export interface ComparisonRow {
  product: Product;
  bestCompetitorPrice: number | null;
  bestCompetitorId: number | null;
  bestCompetitorName: string | null;
  /** Our position relative to the cheapest competitor. */
  position: PricePosition | null;
  deltaAbs: number | null;
  deltaPct: number | null;
  observedAt: string | null;
  competitorPrices: {
    competitorId: number;
    competitorName: string;
    price: number | null;
    wasPrice: number | null;
    promo: boolean;
    inStock: boolean | null;
    position: PricePosition | null;
    deltaAbs: number | null;
    deltaPct: number | null;
    sourceUrl: string;
    observedAt: string;
  }[];
  matchStatus: {
    confirmed: number;
    pending: number;
  };
}

export interface ScrapeRun {
  id: number;
  trigger: string;
  status: 'running' | 'completed' | 'failed';
  competitor_id: number | null;
  ok_count: number;
  error_count: number;
  skipped_count: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}
