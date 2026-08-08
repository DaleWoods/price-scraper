import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hueFor, initialsFor } from '../src/components/CompetitorLogo.tsx';

describe('initialsFor', () => {
  it('takes two initials from a multi-word name', () => {
    assert.equal(initialsFor('Ernest Jones'), 'EJ');
    assert.equal(initialsFor('Fraser Hart'), 'FH');
  });

  it('takes one initial from a single-word name', () => {
    assert.equal(initialsFor('Beaverbrooks'), 'B');
    assert.equal(initialsFor('Watchfinder'), 'W');
  });

  it('handles digits, hyphens and punctuation the way a reader would', () => {
    assert.equal(initialsFor('77 Diamonds'), '7D');
    assert.equal(initialsFor('Chisholm-Hunter'), 'CH');
    assert.equal(initialsFor('H. Samuel'), 'HS');
    // An apostrophe must not count as a word break.
    assert.equal(initialsFor("Berry's Jewellers"), 'BJ');
    assert.equal(initialsFor('Berry’s Jewellers'), 'BJ');
  });

  it('never returns an empty badge', () => {
    assert.equal(initialsFor(''), '?');
    assert.equal(initialsFor('   '), '?');
  });
});

describe('hueFor', () => {
  it('is stable, so a competitor keeps the same colour between loads', () => {
    assert.equal(hueFor('beaverbrooks'), hueFor('beaverbrooks'));
  });

  it('stays out of the red/green band used for price position', () => {
    for (const slug of ['beaverbrooks', 'ernest-jones', 'h-samuel', '77-diamonds', 'watch-shop']) {
      const hue = hueFor(slug);
      assert.ok(hue >= 190 && hue <= 330, `${slug} produced hue ${hue}, outside the safe band`);
    }
  });

  it('spreads real competitor slugs across distinct colours', () => {
    const slugs = [
      '77-diamonds',
      'austen-blake',
      'beaverbrooks',
      'berrys-jewellers',
      'chisholm-hunter',
      'ernest-jones',
      'fraser-hart',
      'h-samuel',
      'purely-diamonds',
      'watch-shop',
      'watchfinder',
    ];
    const hues = slugs.map(hueFor);
    // Allow a little collision, but the palette must not collapse to a few colours.
    assert.ok(new Set(hues).size >= slugs.length - 1, `only ${new Set(hues).size} distinct hues`);
  });
});
