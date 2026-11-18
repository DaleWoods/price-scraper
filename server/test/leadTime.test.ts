import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { leadFromDate, leadFromPhrase, parseDayMonth, readLeadTime } from '../src/scraping/leadTime.ts';

// Wednesday 18 November 2026, 21:30 — after every retailer's next-day cut-off.
const now = new Date('2026-11-18T21:30:00Z');

/**
 * The wording below is what each site published on 18 November 2026, cut down
 * to the part that states the delivery time.
 */
describe('reading a lead time from a product page', () => {
  it('Beaverbrooks: the promised date in page data is its next-day service', () => {
    const html =
      '{"currentDateTime":"2026-11-18T21:29:48.637Z","nddCountdown":[{"countdownSeconds":81012,' +
      '"leadTime":"2026-11-20T20:00:00.000Z","deliveryPrice":0,"sku":"0159885","free":true}]}';
    assert.deepEqual(readLeadTime(html, { inStock: true, now }), { text: 'Next day', days: 1 });
  });

  it('Ernest Jones: the date shown beside "Estimated Express Delivery"', () => {
    const page = (date: string) =>
      `<span class="delivery-message__text body-one"> Estimated Express Delivery </span>` +
      `<span class="mr-2 delivery-date">${date}</span>` +
      `<p>We aim to deliver within 2-3 working days, Monday to Saturday.</p>`;
    assert.deepEqual(readLeadTime(page('Friday 20th November.'), { inStock: true, now }), { text: 'Next day', days: 1 });
    assert.deepEqual(readLeadTime(page('Saturday 21st November.'), { inStock: true, now }), { text: '3 days', days: 3 });
  });

  it('Fraser Hart: "delivery tomorrow" when in stock', () => {
    const html =
      '<div class="countdown__timer"> Order within <span class="countdownTimer">--:--:--</span> for ' +
      '<span>delivery tomorrow,</span> <span class="nextDay"></span>. </div>';
    assert.deepEqual(readLeadTime(html, { inStock: true, now }), { text: 'Next day', days: 1 });
  });

  it('Fraser Hart: a pre-order states its wait in the description', () => {
    const html =
      '<div class="countdown__timer"> Order within for <span>delivery tomorrow,</span></div>' +
      '<p>**Pre-order today to ensure your piece when stock arrives! Estimated delivery for this model is 1-2 weeks. ' +
      'Please note that delivery times noted are estimates.</p>';
    assert.deepEqual(
      readLeadTime(html, { inStock: true, availabilityText: 'https://schema.org/PreOrder', now }),
      { text: 'Pre-order, 1-2 weeks', days: 14 },
    );
  });

  it('reports nothing for a product that is out of stock, whatever the page promises elsewhere', () => {
    const html =
      '<span>delivery tomorrow,</span><p>We aim to deliver within 2-3 working days.</p>' +
      '{"nddCountdown":[{"leadTime":"2026-11-20T20:00:00.000Z"}]}';
    assert.equal(readLeadTime(html, { inStock: false, now }), null);
  });

  it('does not mistake returns or finance wording for a lead time', () => {
    const html =
      '<p>Pay up to 30 days after delivery or in 3 monthly instalments.</p>' +
      '<p>Free delivery and 30 days returns.</p><p>Free next day delivery on orders over £150</p>';
    assert.equal(readLeadTime(html, { inStock: true, now }), null);
  });

  it('reads a stated wait of weeks: made to order, dispatched within', () => {
    assert.deepEqual(readLeadTime('<p>This ring is made to order and takes 4-6 weeks.</p>', { inStock: true, now }), {
      text: '4-6 weeks',
      days: 42,
    });
    assert.deepEqual(readLeadTime('<p>Usually dispatched within 3 weeks</p>', { inStock: null, now }), {
      text: '3 weeks',
      days: 21,
    });
  });
});

describe('our own delivery message', () => {
  it('reads the short message our pages carry', () => {
    assert.deepEqual(leadFromPhrase('Next Day Delivery'), { text: 'Next day', days: 1 });
    assert.deepEqual(leadFromPhrase('1-2 Business Days'), { text: '1-2 working days', days: 2 });
    assert.deepEqual(leadFromPhrase('4-6 Weeks'), { text: '4-6 weeks', days: 42 });
    assert.equal(leadFromPhrase(''), null);
    assert.equal(leadFromPhrase('Free delivery'), null);
  });
});

describe('a delivery date as a lead time', () => {
  it('treats the day after tomorrow, and Monday seen from Saturday, as next day', () => {
    assert.equal(leadFromDate(new Date('2026-11-19T12:00:00Z'), now)?.text, 'Next day');
    assert.equal(leadFromDate(new Date('2026-11-20T12:00:00Z'), now)?.text, 'Next day');
    // Saturday 21st -> Tuesday 24th crosses a Sunday.
    assert.equal(leadFromDate(new Date('2026-11-24T12:00:00Z'), new Date('2026-11-21T21:00:00Z'))?.text, 'Next day');
  });

  it('reports a longer wait in days, then weeks', () => {
    assert.deepEqual(leadFromDate(new Date('2026-11-25T12:00:00Z'), now), { text: '7 days', days: 7 });
    assert.deepEqual(leadFromDate(new Date('2026-12-30T12:00:00Z'), now), { text: 'About 6 weeks', days: 42 });
  });

  it('reads a day and month, rolling into next year when needed', () => {
    assert.equal(parseDayMonth('Friday 20th November.', now)?.toISOString().slice(0, 10), '2026-11-20');
    assert.equal(parseDayMonth('Monday 4th January', new Date('2026-12-28T10:00:00Z'))?.toISOString().slice(0, 10), '2027-01-04');
  });
});
