import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { query } from '../db/pool.js';
import type { Competitor } from '../domain/types.js';

/** Resolves identically from src/scraping (tsx) and dist/scraping (compiled). */
const COMPETITORS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../competitors',
);

const selectorListSchema = z.array(z.string()).optional();

export const competitorConfigSchema = z.object({
  /**
   * Where candidate listings come from. Defaults to the sitemap because every
   * competitor examined disallows /search in robots.txt; 'search' remains for
   * any site that permits it.
   */
  discovery: z.enum(['sitemap', 'search']).default('sitemap'),
  rendering: z.enum(['http', 'browser']).default('browser'),
  userAgent: z.string().optional(),
  rateLimit: z
    .object({
      minDelayMs: z.number().int().nonnegative().optional(),
      jitterMs: z.number().int().nonnegative().optional(),
      maxConcurrent: z.number().int().positive().optional(),
    })
    .optional(),
  retry: z
    .object({
      attempts: z.number().int().positive().max(6).optional(),
      backoffMs: z.number().int().nonnegative().optional(),
    })
    .optional(),
  product: z
    .object({
      useJsonLd: z.boolean().optional(),
      sanityContains: selectorListSchema,
      selectors: z
        .object({
          title: selectorListSchema,
          price: selectorListSchema,
          wasPrice: selectorListSchema,
          availability: selectorListSchema,
          promoBadge: selectorListSchema,
          ean: selectorListSchema,
        })
        .optional(),
    })
    .optional(),
  search: z
    .object({
      resultItem: selectorListSchema,
      resultLink: selectorListSchema,
      resultTitle: selectorListSchema,
      resultPrice: selectorListSchema,
      maxCandidates: z.number().int().positive().max(50).optional(),
    })
    .optional(),
});

export const competitorFileSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, 'slug must be lowercase, hyphenated'),
  displayName: z.string().min(1),
  baseUrl: z.string().url(),
  /** Optional explicit logo; when absent the site's own icons are discovered. */
  logoUrl: z.string().url().optional(),
  searchUrlPattern: z.string().min(1).includes('{query}', {
    message: 'searchUrlPattern must contain the {query} placeholder',
  }),
  enabled: z.boolean().default(true),
  scrapeFrequency: z.string().default('daily'),
  brands: z.array(z.string()).default([]),
  config: competitorConfigSchema,
  // Free-form documentation inside the config files; ignored by the loader.
  _notes: z.array(z.string()).optional(),
});

export type CompetitorFile = z.infer<typeof competitorFileSchema>;

/**
 * Load every competitor definition from competitors/*.json.
 *
 * Adding a retailer is dropping a JSON file here and re-running the seed —
 * no code changes (Spec §5.2).
 */
export async function loadCompetitorFiles(): Promise<CompetitorFile[]> {
  const files = (await readdir(COMPETITORS_DIR)).filter((f) => f.endsWith('.json')).sort();
  const parsed: CompetitorFile[] = [];

  for (const file of files) {
    const raw = await readFile(path.join(COMPETITORS_DIR, file), 'utf8');
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new Error(`competitors/${file} is not valid JSON: ${(err as Error).message}`);
    }

    const result = competitorFileSchema.safeParse(json);
    if (!result.success) {
      throw new Error(
        `competitors/${file} is not a valid competitor definition:\n` +
          result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n'),
      );
    }
    parsed.push(result.data);
  }

  return parsed;
}

/** Upsert the JSON definitions into the competitors table, preserving `enabled` overrides made in the UI. */
export async function syncCompetitorsToDatabase(): Promise<{ slug: string; action: 'created' | 'updated' }[]> {
  const definitions = await loadCompetitorFiles();
  const results: { slug: string; action: 'created' | 'updated' }[] = [];

  for (const definition of definitions) {
    const { rows } = await query<{ existed: boolean }>(
      `INSERT INTO competitors
         (slug, display_name, base_url, search_url_pattern, brands, enabled, scrape_frequency, config, logo_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (slug) DO UPDATE SET
         display_name       = EXCLUDED.display_name,
         base_url           = EXCLUDED.base_url,
         search_url_pattern = EXCLUDED.search_url_pattern,
         brands             = EXCLUDED.brands,
         scrape_frequency   = EXCLUDED.scrape_frequency,
         config             = EXCLUDED.config,
         -- Only overwrite the logo source when the definition names one, so a
         -- discovered icon is not wiped out by a routine re-sync.
         logo_url           = COALESCE(EXCLUDED.logo_url, competitors.logo_url),
         updated_at         = now()
       RETURNING (xmax <> 0) AS existed`,
      [
        definition.slug,
        definition.displayName,
        definition.baseUrl,
        definition.searchUrlPattern,
        definition.brands,
        definition.enabled,
        definition.scrapeFrequency,
        JSON.stringify(definition.config),
        definition.logoUrl ?? null,
      ],
    );

    results.push({ slug: definition.slug, action: rows[0]?.existed ? 'updated' : 'created' });
  }

  return results;
}

/**
 * Every competitor column except `logo_data`, plus a `has_logo` flag.
 *
 * Deliberately not `SELECT *`: the logo bytes would otherwise be base64'd into
 * every competitor list response, for pictures the client fetches separately
 * and caches anyway.
 */
const COMPETITOR_COLUMNS = `id, slug, display_name, base_url, search_url_pattern, brands,
  enabled, scrape_frequency, config, logo_url, logo_fetched_at, logo_error,
  (logo_data IS NOT NULL) AS has_logo, created_at, updated_at`;

export async function listCompetitors(onlyEnabled = false): Promise<Competitor[]> {
  const { rows } = await query<Competitor>(
    `SELECT ${COMPETITOR_COLUMNS} FROM competitors ${onlyEnabled ? 'WHERE enabled = TRUE' : ''}
     ORDER BY display_name`,
  );
  return rows;
}

export async function getCompetitorBySlug(slug: string): Promise<Competitor | null> {
  const { rows } = await query<Competitor>(
    `SELECT ${COMPETITOR_COLUMNS} FROM competitors WHERE slug = $1`,
    [slug],
  );
  return rows[0] ?? null;
}

export async function getCompetitorById(id: number): Promise<Competitor | null> {
  const { rows } = await query<Competitor>(
    `SELECT ${COMPETITOR_COLUMNS} FROM competitors WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Build a competitor's search URL for a query string. */
export function buildSearchUrl(competitor: Competitor, searchTerm: string): string {
  return competitor.search_url_pattern.replace('{query}', encodeURIComponent(searchTerm));
}
