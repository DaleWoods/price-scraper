import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Product } from '../src/domain/types.ts';
import { nameSimilarity, scoreCandidate } from '../src/matching/score.ts';
import {
  normaliseAttribute,
  normaliseCarat,
  normaliseCaseSize,
  normaliseMaterial,
  rulesForCategory,
} from '../src/matching/attributes.ts';

function watch(overrides: Partial<Product> = {}): Product {
  return {
    id: 1,
    internal_sku: 'GS-12345',
    brand: 'TAG Heuer',
    product_name: 'Carrera Chronograph 41mm',
    ean_mpn: '7612345678901',
    our_price: 4250,
    currency: 'GBP',
    category: 'watches',
    our_product_url: null,
    specs: {
      model: 'Carrera',
      case_size: '41mm',
      dial_colour: 'Blue',
      case_material: 'Stainless steel',
      movement: 'Automatic',
      water_resistance: '100m',
    },
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

describe('attribute normalisation', () => {
  it('canonicalises case size regardless of spacing', () => {
    assert.equal(normaliseCaseSize('41mm'), '41');
    assert.equal(normaliseCaseSize('41 mm'), '41');
    assert.equal(normaliseCaseSize('40.5 MM'), '40.5');
  });

  it('canonicalises metal descriptions that differ in wording', () => {
    assert.equal(normaliseMaterial('Stainless Steel'), 'steel');
    assert.equal(normaliseMaterial('steel'), 'steel');
    assert.equal(normaliseMaterial('18ct Rose Gold'), '18ct rose gold');
    assert.equal(normaliseMaterial('18 carat red gold'), '18ct rose gold');
  });

  it('reads carat weights written as decimals or fractions', () => {
    assert.equal(normaliseCarat('0.50ct'), '0.5');
    assert.equal(normaliseCarat('1/2 carat'), '0.5');
    assert.equal(normaliseAttribute('carat_weight', '1.00 ct'), '1');
  });
});

describe('category rulebook (Appendix A)', () => {
  it('never treats water resistance as a watch discriminator', () => {
    const rules = rulesForCategory('watches');
    assert.ok(rules.ignore.includes('water_resistance'));
    assert.ok(!rules.high.includes('water_resistance'));
    assert.ok(!rules.medium.includes('water_resistance'));
  });

  it('never treats ring size as a ring discriminator', () => {
    const rules = rulesForCategory('engagement rings');
    assert.ok(rules.ignore.includes('ring_size'));
    assert.ok(rules.gate.includes('metal_type'));
  });
});

describe('tiered match scoring (Spec §5.3)', () => {
  it('scores an EAN/MPN exact match at 100 and auto-accepts, whatever the title says', () => {
    const result = scoreCandidate(watch(), {
      url: 'https://example.com/p/1',
      title: 'Completely differently worded listing',
      ean: '7612345678901',
    });

    assert.equal(result.confidence, 100);
    assert.equal(result.tier, 'ean_mpn_exact');
    assert.ok(result.autoAccept);
  });

  it('treats a normalised EAN with punctuation as the same identifier', () => {
    const result = scoreCandidate(watch(), {
      url: 'https://example.com/p/1',
      title: 'TAG Heuer Carrera',
      ean: '7612-345 678901',
    });
    assert.equal(result.confidence, 100);
  });

  it('rejects a candidate whose published EAN disagrees with ours', () => {
    const result = scoreCandidate(watch(), {
      url: 'https://example.com/p/2',
      title: 'TAG Heuer Carrera Chronograph 41mm Blue Dial Steel',
      ean: '9999999999999',
    });

    assert.equal(result.viable, false);
    assert.equal(result.confidence, 0);
    assert.deepEqual(result.evidence.gatesFailed, ['ean_mpn']);
  });

  it('rejects a different brand outright on the gate', () => {
    const result = scoreCandidate(watch({ ean_mpn: null }), {
      url: 'https://example.com/p/3',
      title: 'Omega Speedmaster 41mm Blue Dial Steel',
      brand: 'Omega',
    });

    assert.equal(result.viable, false);
    assert.ok(result.evidence.gatesFailed?.includes('brand'));
  });

  it('scores a strong brand + spec-attribute agreement highly when no EAN is published', () => {
    const result = scoreCandidate(watch({ ean_mpn: null }), {
      url: 'https://example.com/p/4',
      title: 'TAG Heuer Carrera Chronograph',
      brand: 'TAG Heuer',
      attributes: {
        model: 'Carrera',
        case_size: '41 mm',
        dial_colour: 'Blue',
        case_material: 'Stainless Steel',
        movement: 'Automatic',
      },
    });

    assert.equal(result.tier, 'brand_spec_attributes');
    assert.ok(result.confidence >= 85, `expected a high score, got ${result.confidence}`);
    assert.ok(result.viable);
  });

  it('scores lower when high-weight attributes disagree', () => {
    const strong = scoreCandidate(watch({ ean_mpn: null }), {
      url: 'https://example.com/p/5',
      title: 'TAG Heuer Carrera Chronograph',
      brand: 'TAG Heuer',
      attributes: { model: 'Carrera', case_size: '41mm', dial_colour: 'Blue', case_material: 'Steel' },
    });

    const weak = scoreCandidate(watch({ ean_mpn: null }), {
      url: 'https://example.com/p/6',
      title: 'TAG Heuer Carrera Chronograph',
      brand: 'TAG Heuer',
      attributes: { model: 'Carrera', case_size: '44mm', dial_colour: 'Black', case_material: 'Steel' },
    });

    assert.ok(weak.confidence < strong.confidence);
  });

  it('does not let water resistance influence the score either way', () => {
    const base = {
      url: 'https://example.com/p/7',
      title: 'TAG Heuer Carrera Chronograph',
      brand: 'TAG Heuer',
      attributes: { model: 'Carrera', case_size: '41mm', dial_colour: 'Blue' },
    };

    const agreeing = scoreCandidate(watch({ ean_mpn: null }), {
      ...base,
      attributes: { ...base.attributes, water_resistance: '100m' },
    });
    const disagreeing = scoreCandidate(watch({ ean_mpn: null }), {
      ...base,
      attributes: { ...base.attributes, water_resistance: '300m' },
    });

    assert.equal(agreeing.confidence, disagreeing.confidence);
    assert.ok(disagreeing.viable, 'a water-resistance difference must never reject a candidate');
  });

  it('does not let ring size split one product into false non-matches', () => {
    const ring = watch({
      brand: 'Goldsmiths',
      product_name: 'Solitaire Engagement Ring',
      category: 'rings',
      ean_mpn: null,
      specs: {
        metal_type: 'Platinum',
        centre_stone: 'Diamond',
        carat_weight: '0.50ct',
        stone_cut: 'Round',
        ring_size: 'L',
      },
    });

    const differentSize = scoreCandidate(ring, {
      url: 'https://example.com/p/8',
      title: 'Goldsmiths Platinum Round Diamond Solitaire Ring 0.50ct',
      brand: 'Goldsmiths',
      attributes: {
        metal_type: 'Platinum',
        centre_stone: 'Diamond',
        carat_weight: '0.50ct',
        stone_cut: 'Round',
        ring_size: 'Q',
      },
    });

    assert.ok(differentSize.viable);
    assert.ok(differentSize.confidence >= 85, `expected a high score, got ${differentSize.confidence}`);
  });

  it('falls back to a fuzzy name score that can never auto-accept', () => {
    const result = scoreCandidate(
      watch({ ean_mpn: null, specs: {} }),
      { url: 'https://example.com/p/9', title: 'TAG Heuer Carrera Chronograph 41mm' },
    );

    assert.equal(result.tier, 'fuzzy_name_specs');
    assert.equal(result.autoAccept, false, 'a name-only match must always be reviewed by a human');
  });
});

describe('nameSimilarity', () => {
  it('is 1 for identical names and 0 for disjoint ones', () => {
    assert.equal(nameSimilarity('TAG Heuer Carrera', 'tag heuer carrera'), 1);
    assert.equal(nameSimilarity('Rolex', 'Cartier'), 0);
  });

  it('rewards partial overlap proportionally', () => {
    const score = nameSimilarity('TAG Heuer Carrera Chronograph', 'TAG Heuer Carrera');
    assert.ok(score > 0.6 && score < 1);
  });
});
