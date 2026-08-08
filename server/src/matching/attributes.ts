/**
 * Attribute rulebook — Spec Appendix A.
 *
 * Tiers:
 *   gate   — must agree or it is not the same product; a mismatch rejects outright.
 *   high   — strong discriminators; each agreement adds significant confidence.
 *   medium — supporting signals, useful in combination.
 *   ignore — variants of the SAME product (ring size, strap length, water
 *            resistance, packaging). Never treat these as distinguishing, or one
 *            product splits into many false non-matches.
 *
 * This table is data, not control flow — new categories are added here, and the
 * scorer needs no changes.
 */

export type Weight = 'gate' | 'high' | 'medium' | 'ignore';

export interface CategoryRules {
  /** Matches against the product's `category` field, case-insensitive substring. */
  categoryKeywords: string[];
  gate: string[];
  high: string[];
  medium: string[];
  ignore: string[];
}

export const WEIGHT_POINTS: Record<Exclude<Weight, 'gate' | 'ignore'>, number> = {
  high: 18,
  medium: 8,
};

/** Confidence at or above this auto-accepts; below it routes to manual review (Spec §5.3). */
export const AUTO_ACCEPT_THRESHOLD = 85;
/** Below this a candidate is not even worth showing in the review queue. */
export const MIN_CANDIDATE_THRESHOLD = 25;

export const WATCH_RULES: CategoryRules = {
  categoryKeywords: ['watch', 'watches', 'timepiece'],
  gate: ['brand', 'model', 'collection'],
  high: ['case_size', 'dial_colour', 'case_material', 'reference_number'],
  medium: ['strap_material', 'bracelet_material', 'movement', 'bezel_type'],
  ignore: ['water_resistance', 'strap_length', 'warranty', 'packaging'],
};

export const RING_RULES: CategoryRules = {
  categoryKeywords: ['ring', 'rings', 'engagement', 'eternity', 'bridal'],
  gate: ['brand', 'designer', 'metal_type'],
  high: ['centre_stone', 'carat_weight', 'stone_cut'],
  medium: ['diamond_colour', 'diamond_clarity', 'setting_style', 'collection'],
  ignore: ['ring_size', 'engraving', 'gift_wrap'],
};

export const JEWELLERY_RULES: CategoryRules = {
  categoryKeywords: ['jewellery', 'jewelry', 'necklace', 'bracelet', 'earring', 'pendant', 'chain'],
  gate: ['brand', 'designer', 'product_type', 'metal_type'],
  high: ['gemstone', 'carat_weight', 'collection'],
  medium: ['length', 'drop', 'chain_style', 'clasp_type'],
  ignore: ['adjustable_length', 'packaging'],
};

/**
 * Watch winders, cufflinks, straps, care kits and gift lines. These are ordinary
 * manufactured goods rather than jewellery: the model name does the work, and
 * finish or colour is a variant rather than a different product.
 */
export const ACCESSORY_RULES: CategoryRules = {
  categoryKeywords: ['winder', 'accessor', 'cufflink', 'strap', 'gift', 'care kit'],
  gate: ['brand', 'product_type'],
  high: ['model', 'collection', 'capacity'],
  medium: ['material', 'colour', 'dimensions'],
  ignore: ['packaging', 'gift_wrap', 'engraving', 'warranty'],
};

/** Fallback when the category is missing or unrecognised — brand gates, name carries. */
export const DEFAULT_RULES: CategoryRules = {
  categoryKeywords: [],
  gate: ['brand'],
  high: ['collection', 'metal_type', 'gemstone'],
  medium: ['carat_weight', 'length'],
  ignore: ['packaging'],
};

/**
 * Order matters: the first rulebook whose keyword appears in the category wins.
 * Accessories lead so "watch winders" is not captured by the watch rules, whose
 * case-size and dial-colour attributes mean nothing for a winder.
 */
const ALL_RULES = [ACCESSORY_RULES, WATCH_RULES, RING_RULES, JEWELLERY_RULES];

export function rulesForCategory(category: string | null | undefined): CategoryRules {
  if (!category) return DEFAULT_RULES;
  const needle = category.toLowerCase();
  for (const rules of ALL_RULES) {
    if (rules.categoryKeywords.some((keyword) => needle.includes(keyword))) return rules;
  }
  return DEFAULT_RULES;
}

export function weightOf(rules: CategoryRules, attribute: string): Weight | null {
  if (rules.gate.includes(attribute)) return 'gate';
  if (rules.high.includes(attribute)) return 'high';
  if (rules.medium.includes(attribute)) return 'medium';
  if (rules.ignore.includes(attribute)) return 'ignore';
  return null;
}

/* ------------------------------------------------------------------ *
 * Normalisation — competitor copy and our catalogue rarely agree on
 * spelling, so values are canonicalised before comparison.
 * ------------------------------------------------------------------ */

const COLOUR_SYNONYMS: Record<string, string> = {
  silver: 'silver',
  grey: 'grey',
  gray: 'grey',
  anthracite: 'grey',
  slate: 'grey',
  black: 'black',
  blue: 'blue',
  navy: 'blue',
  green: 'green',
  white: 'white',
  cream: 'white',
  ivory: 'white',
  champagne: 'champagne',
  gold: 'gold',
  rose: 'rose',
  pink: 'pink',
  brown: 'brown',
  chocolate: 'brown',
  mother_of_pearl: 'mother of pearl',
};

const MATERIAL_SYNONYMS: Array<[RegExp, string]> = [
  // Marque-specific metal names, matched before the generic patterns. Rolex calls
  // its steel "Oystersteel" and its rose gold "Everose"; competitors describe the
  // same metal generically, so both sides must normalise to the same value or
  // every case_material comparison misses.
  [/\boystersteel\b/i, 'steel'],
  [/\beverose\s*gold\b/i, 'rose gold'],
  [/\bcerachrom\b/i, 'ceramic'],
  [/\b(stainless\s*steel|steel)\b/i, 'steel'],
  [/\btwo[\s-]?tone\b/i, 'two-tone'],
  [/\b(18\s*ct|18k|18\s*carat)\s*(yellow)\s*gold\b/i, '18ct yellow gold'],
  [/\b(18\s*ct|18k|18\s*carat)\s*(white)\s*gold\b/i, '18ct white gold'],
  [/\b(18\s*ct|18k|18\s*carat)\s*(rose|red)\s*gold\b/i, '18ct rose gold'],
  [/\b(9\s*ct|9k)\s*(yellow)\s*gold\b/i, '9ct yellow gold'],
  [/\b(9\s*ct|9k)\s*(white)\s*gold\b/i, '9ct white gold'],
  [/\b(9\s*ct|9k)\s*(rose|red)\s*gold\b/i, '9ct rose gold'],
  [/\byellow\s*gold\b/i, 'yellow gold'],
  [/\bwhite\s*gold\b/i, 'white gold'],
  [/\b(rose|red)\s*gold\b/i, 'rose gold'],
  [/\bplatinum\b/i, 'platinum'],
  [/\btitanium\b/i, 'titanium'],
  [/\bceramic\b/i, 'ceramic'],
  [/\bleather\b/i, 'leather'],
  [/\brubber\b/i, 'rubber'],
  [/\b(nato|fabric|textile)\b/i, 'fabric'],
  [/\bsterling\s*silver\b/i, 'sterling silver'],
];

export function normaliseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9.\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** EAN/MPN: strip everything but alphanumerics so "AB-123 / 456" == "ab123456". */
export function normaliseIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** "40mm", "40 mm", "40.5 mm" -> "40" / "40.5" */
export function normaliseCaseSize(value: string): string | null {
  const match = value.match(/(\d{2}(?:\.\d)?)\s*mm/i) ?? value.match(/^\s*(\d{2}(?:\.\d)?)\s*$/);
  if (!match?.[1]) return null;
  return String(Number.parseFloat(match[1]));
}

export function normaliseColour(value: string): string {
  const text = normaliseText(value);
  if (/mother\s*of\s*pearl|\bmop\b/.test(text)) return 'mother of pearl';
  for (const [word, canonical] of Object.entries(COLOUR_SYNONYMS)) {
    if (new RegExp(`\\b${word.replace(/_/g, '\\s*')}\\b`).test(text)) return canonical;
  }
  return text;
}

export function normaliseMaterial(value: string): string {
  for (const [pattern, canonical] of MATERIAL_SYNONYMS) {
    if (pattern.test(value)) return canonical;
  }
  return normaliseText(value);
}

/** "0.50ct", "1/2 carat", "0.5 ct" -> "0.5" */
export function normaliseCarat(value: string): string | null {
  const fraction = value.match(/(\d)\s*\/\s*(\d)/);
  if (fraction?.[1] && fraction[2]) {
    const denominator = Number.parseFloat(fraction[2]);
    if (denominator !== 0) return String(Number.parseFloat(fraction[1]) / denominator);
  }
  const decimal = value.match(/(\d+(?:\.\d+)?)\s*(?:ct|carat)/i) ?? value.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
  if (!decimal?.[1]) return null;
  return String(Number.parseFloat(decimal[1]));
}

export function normaliseMovement(value: string): string {
  const text = normaliseText(value);
  if (/automatic|self[\s-]?winding|mechanical/.test(text)) return 'automatic';
  if (/quartz|battery/.test(text)) return 'quartz';
  if (/solar|eco[\s-]?drive/.test(text)) return 'solar';
  if (/manual|hand[\s-]?wound/.test(text)) return 'manual';
  return text;
}

/** Per-attribute canonicalisation, keyed by attribute name. */
export function normaliseAttribute(attribute: string, value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;

  switch (attribute) {
    case 'case_size':
      return normaliseCaseSize(raw);
    case 'dial_colour':
    case 'diamond_colour':
      return normaliseColour(raw) || null;
    case 'case_material':
    case 'strap_material':
    case 'bracelet_material':
    case 'metal_type':
      return normaliseMaterial(raw) || null;
    case 'carat_weight':
      return normaliseCarat(raw);
    case 'movement':
      return normaliseMovement(raw) || null;
    case 'reference_number':
      return normaliseIdentifier(raw) || null;
    default:
      return normaliseText(raw) || null;
  }
}

/**
 * Our catalogue spec keys vary between exports; map common variants onto the
 * canonical names used by the rulebook above.
 */
const ATTRIBUTE_ALIASES: Record<string, string> = {
  case_colour: 'case_material',
  casematerial: 'case_material',
  case_size_mm: 'case_size',
  casesize: 'case_size',
  case_diameter: 'case_size',
  dial_color: 'dial_colour',
  dialcolour: 'dial_colour',
  dial: 'dial_colour',
  strap: 'strap_material',
  strap_type: 'strap_material',
  bracelet: 'bracelet_material',
  band_material: 'strap_material',
  movement_type: 'movement',
  metal: 'metal_type',
  metal_colour: 'metal_type',
  stone: 'centre_stone',
  centre_stone_type: 'centre_stone',
  center_stone: 'centre_stone',
  carat: 'carat_weight',
  total_carat_weight: 'carat_weight',
  cut: 'stone_cut',
  stone_shape: 'stone_cut',
  clarity: 'diamond_clarity',
  colour_grade: 'diamond_colour',
  setting: 'setting_style',
  range: 'collection',
  collection_name: 'collection',
  series: 'collection',
  model_name: 'model',
  reference: 'reference_number',
  ref: 'reference_number',
  water_resistant: 'water_resistance',
  type: 'product_type',
};

export function canonicalAttributeName(key: string): string {
  const slug = key.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
  return ATTRIBUTE_ALIASES[slug] ?? slug;
}
