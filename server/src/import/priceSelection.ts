/**
 * Price selection from the SAP loadsheet.
 *
 * Pure functions, no database — this is the part most likely to be wrong in a
 * way that silently produces plausible numbers, so it is kept separate and
 * tested directly against the rules documented on the Pricing Confluence page.
 */

/** Sales-organisation-wide rows carry '-' rather than a store code. */
export const ANY_STORE = '-';
/** Rows that are not tied to a price list also carry '-'. */
export const ANY_PRICE_LIST = '-';

/**
 * The only condition types that describe what a UK customer pays.
 *
 * VKP0 is UK RRP and VKA0 is the UK sale price. VKP1 and VKA1 are US condition
 * types and are out of scope here.
 *
 * Deliberately an allow-list rather than "anything that is not a sale". Under
 * that earlier rule the VKP1 rows in the export counted as regular prices, and
 * being equally specific they won the tie-break — resolving the regular price
 * to £466.67 instead of £560, which both corrupted the was-price and put a
 * figure carrying `p_net = 1` into comparisons against gross competitor prices.
 * Any condition type outside this list is counted and reported rather than
 * guessed at.
 */
export const REGULAR_KSCHL = 'VKP0';
export const SALE_KSCHL = 'VKA0';

export function isPricingKschl(kschl: string): boolean {
  const value = kschl.trim().toUpperCase();
  return value === REGULAR_KSCHL || value === SALE_KSCHL;
}

export interface LoadsheetRow {
  rowNumber: number;
  code: string;
  kschl: string;
  vkorg: string;
  vtweg: string;
  werks: string;
  pltyp: string;
  price: number;
  validFrom: Date | null;
  validTo: Date | null;
}

export interface FasciaDefinition {
  code: string;
  name: string;
  salesOrg: string;
  distributionChannel: string;
  /** The fascia's SAP price list, or null when it does not use one. */
  priceListType: string | null;
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
  return kschl.trim().toUpperCase() === SALE_KSCHL;
}

/**
 * How specific a row is to this fascia — lower is more specific. Null means the
 * row does not apply at all.
 *
 * This is the documented precedence: store/fascia, then price list, then the
 * sales organisation as a whole.
 */
export function specificityFor(row: LoadsheetRow, fascia: FasciaDefinition): number | null {
  if (row.vkorg !== fascia.salesOrg) return null;
  if (row.vtweg !== fascia.distributionChannel) return null;

  // A price list row only applies when this fascia actually uses that list.
  const priceListMatches =
    row.pltyp === ANY_PRICE_LIST ||
    (fascia.priceListType !== null && row.pltyp === fascia.priceListType);
  if (!priceListMatches) return null;

  if (row.werks === fascia.code) return 0;
  if (row.werks !== ANY_STORE) return null;
  return row.pltyp === ANY_PRICE_LIST ? 2 : 1;
}

/** Rows that could apply to this fascia at all. */
export function rowsForFascia(rows: LoadsheetRow[], fascia: FasciaDefinition): LoadsheetRow[] {
  return rows.filter((row) => isPricingKschl(row.kschl) && specificityFor(row, fascia) !== null);
}

/** A row is live if `asOf` falls inside its validity window; no dates means unknown, not expired. */
export function isValidAt(row: LoadsheetRow, asOf: Date): boolean {
  if (row.validFrom && asOf < row.validFrom) return false;
  if (row.validTo && asOf > row.validTo) return false;
  return true;
}

/**
 * Pick the winning row from a set of candidates, by the documented precedence:
 * store/fascia, then price list, then sales organisation; and among rows of
 * equal specificity the most recently started price wins.
 */
export function pickByPrecedence(
  candidates: LoadsheetRow[],
  fascia: FasciaDefinition,
): LoadsheetRow | null {
  if (candidates.length === 0) return null;

  const ranked = [...candidates].sort((a, b) => {
    const specificity =
      (specificityFor(a, fascia) ?? Number.MAX_SAFE_INTEGER) -
      (specificityFor(b, fascia) ?? Number.MAX_SAFE_INTEGER);
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
  if (
    sale &&
    regular &&
    (specificityFor(sale, fascia) ?? 0) > (specificityFor(regular, fascia) ?? 0)
  ) {
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
