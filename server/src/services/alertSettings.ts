import { query } from '../db/pool.js';

/**
 * Alert thresholds (Spec §5.5 — alerts are "threshold-driven and configurable").
 *
 * Deliberately not cached in a module variable: there is exactly one row, it is
 * read once per observation, and a stale cache after someone edits the settings
 * is a confusing bug bought for no measurable gain.
 */
export interface AlertSettings {
  /** Minimum percentage cheaper before an undercut is worth telling anyone about. */
  undercutMinPct: number;
  /** Minimum £ cheaper. Applied together with the percentage — see raiseIfUndercut. */
  undercutMinAbs: number;
  priceDropEnabled: boolean;
  /** How far a competitor's own price must fall, against their previous price. */
  priceDropMinPct: number;
  listingGoneEnabled: boolean;
}

interface SettingsRow {
  undercut_min_pct: string | number;
  undercut_min_abs: string | number;
  price_drop_enabled: boolean;
  price_drop_min_pct: string | number;
  listing_gone_enabled: boolean;
}

/** Defaults matching the migration, used if the singleton row is ever missing. */
const FALLBACK: AlertSettings = {
  undercutMinPct: 0,
  undercutMinAbs: 0,
  priceDropEnabled: true,
  priceDropMinPct: 5,
  listingGoneEnabled: true,
};

function toSettings(row: SettingsRow | undefined): AlertSettings {
  if (!row) return { ...FALLBACK };
  return {
    undercutMinPct: Number(row.undercut_min_pct),
    undercutMinAbs: Number(row.undercut_min_abs),
    priceDropEnabled: row.price_drop_enabled,
    priceDropMinPct: Number(row.price_drop_min_pct),
    listingGoneEnabled: row.listing_gone_enabled,
  };
}

export async function getAlertSettings(): Promise<AlertSettings> {
  const { rows } = await query<SettingsRow>('SELECT * FROM alert_settings WHERE id = TRUE');
  return toSettings(rows[0]);
}

/**
 * Update whichever fields were supplied, leaving the rest as they are.
 *
 * COALESCE against the existing column rather than reading-then-writing, so two
 * people saving different fields at once cannot clobber each other's change.
 */
export async function updateAlertSettings(patch: Partial<AlertSettings>): Promise<AlertSettings> {
  const { rows } = await query<SettingsRow>(
    `UPDATE alert_settings SET
       undercut_min_pct     = COALESCE($1::numeric, undercut_min_pct),
       undercut_min_abs     = COALESCE($2::numeric, undercut_min_abs),
       price_drop_enabled   = COALESCE($3::boolean, price_drop_enabled),
       price_drop_min_pct   = COALESCE($4::numeric, price_drop_min_pct),
       listing_gone_enabled = COALESCE($5::boolean, listing_gone_enabled),
       updated_at           = now()
     WHERE id = TRUE
     RETURNING *`,
    [
      patch.undercutMinPct ?? null,
      patch.undercutMinAbs ?? null,
      patch.priceDropEnabled ?? null,
      patch.priceDropMinPct ?? null,
      patch.listingGoneEnabled ?? null,
    ],
  );
  return toSettings(rows[0]);
}
