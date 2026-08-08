/**
 * Price selection from the SAP loadsheet.
 *
 * Pure functions, no database — this is the part most likely to be wrong in a
 * way that silently produces plausible numbers, so it is kept separate and
 * tested directly against the rules documented on the Pricing Confluence page.
 */

/** Sales-organisation-wide rows carry '-' rather than a store code. */
export const ANY_STORE = '-';

/** Condition types that mark a row as a sale price rather than a regular one. */
const SALE_KSCHL = new Set(['VKA0', 'VKA1']);

export interface LoadsheetRow {
  rowNumber: number;
  code: string;
  kschl: string;
  vkorg: string;
  werks: string;
  price: number;
  validFrom: Date | null;
  validTo: Date | null;
}

export interface FasciaDefinition {
  code: string;
  name: string;
  salesOrg: string;
}

export type SelectionWarning =
  | 'sale_not_cheaper'
  | 'precedence_ambiguous'
  | 'no_validity_dates';

export interface SelectedPrice {
  price: number;
  regularPrice: number | null;
  onSale: boolean;
  sourceKschl: string;
  sourceWerks: string;
  validFrom: Date | null;
  validTo: Date | null;
  warnings: SelectionWarning[];
}

export function isSaleKschl(kschl: string): boolean {
  return SALE_KSCHL.has(kschl.trim().toUpperCase());
}

/** Rows that could apply to this fascia: its own store code, or org-wide. */
export function rowsForFascia(rows: LoadsheetRow[], fascia: FasciaDefinition): LoadsheetRow[] {
  return rows.filter(
    (row) =>
      row.vkorg === fascia.salesOrg && (row.werks === fascia.code || row.werks === ANY_STORE),
  );
}

/** A row is live if `asOf` falls inside its validity window; no dates means unknown, not expired. */
export function isValidAt(row: LoadsheetRow, asOf: Date): boolean {
  if (row.validFrom && asOf < row.validFrom) return false;
  if (row.validTo && asOf > row.validTo) return false;
  return true;
}

/**
 * Pick the winning row from a set of candidates, by the documented precedence:
 * a store-specific price beats a sales-organisation-wide one, and among rows of
 * equal specificity the most recently started price wins.
 *
 * (Price-list precedence sits between the two, but the loadsheet carries no
 * `pltyp` column, so only the outer two levels can be applied here.)
 */
export function pickByPrecedence(
  candidates: LoadsheetRow[],
  fascia: FasciaDefinition,
): LoadsheetRow | null {
  if (candidates.length === 0) return null;

  const ranked = [...candidates].sort((a, b) => {
    const specificity = Number(b.werks === fascia.code) - Number(a.werks === fascia.code);
    if (specificity !== 0) return specificity;

    // Most recent start date wins; rows without dates rank last so a dated
    // price is always preferred over one we cannot place in time.
    const aFrom = a.validFrom?.getTime() ?? -Infinity;
    const bFrom = b.validFrom?.getTime() ?? -Infinity;
    if (aFrom !== bFrom) return bFrom - aFrom;

    // Final tie-break: later in the file, so re-exported rows supersede.
    return b.rowNumber - a.rowNumber;
  });

  return ranked[0] ?? null;
}

/**
 * Resolve one fascia's selling price from the rows that apply to it.
 *
 * Regular and sale prices are resolved independently by precedence, then the
 * sale is taken only where it is genuinely cheaper — a "sale" priced at or above
 * the regular price is reported rather than applied.
 */
export function selectFasciaPrice(
  rows: LoadsheetRow[],
  fascia: FasciaDefinition,
  asOf: Date,
): SelectedPrice | null {
  const applicable = rowsForFascia(rows, fascia).filter((row) => isValidAt(row, asOf));
  if (applicable.length === 0) return null;

  const regular = pickByPrecedence(
    applicable.filter((row) => !isSaleKschl(row.kschl)),
    fascia,
  );
  const sale = pickByPrecedence(
    applicable.filter((row) => isSaleKschl(row.kschl)),
    fascia,
  );

  const warnings: SelectionWarning[] = [];
  if (applicable.every((row) => !row.validFrom && !row.validTo)) {
    warnings.push('no_validity_dates');
  }

  // Documented quirk: where a sale is only sales-org-wide but the regular price
  // is fascia-specific, the live site may return the regular price instead of
  // the sale. We apply the intended rule and flag it for checking.
  if (sale && regular && sale.werks === ANY_STORE && regular.werks === fascia.code) {
    warnings.push('precedence_ambiguous');
  }

  if (sale && regular && sale.price >= regular.price) {
    warnings.push('sale_not_cheaper');
    return {
      price: regular.price,
      regularPrice: null,
      onSale: false,
      sourceKschl: regular.kschl,
      sourceWerks: regular.werks,
      validFrom: regular.validFrom,
      validTo: regular.validTo,
      warnings,
    };
  }

  const winner = sale ?? regular;
  if (!winner) return null;

  const onSale = winner === sale;
  return {
    price: winner.price,
    // Only meaningful as a "was" price when there is a regular price to compare.
    regularPrice: onSale && regular ? regular.price : null,
    onSale,
    sourceKschl: winner.kschl,
    sourceWerks: winner.werks,
    validFrom: winner.validFrom,
    validTo: winner.validTo,
    warnings,
  };
}
