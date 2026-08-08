import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { discoverIconUrls } from '../src/competitors/logos.ts';

describe('discoverIconUrls', () => {
  const base = 'https://www.example.co.uk';

  it('prefers apple-touch-icon over a 16px favicon', () => {
    const html = `
      <head>
        <link rel="shortcut icon" href="/favicon.ico">
        <link rel="apple-touch-icon" sizes="180x180" href="/touch.png">
      </head>`;
    assert.equal(discoverIconUrls(html, base)[0], 'https://www.example.co.uk/touch.png');
  });

  it('prefers the largest icon within a rel type', () => {
    const html = `
      <link rel="icon" sizes="32x32" href="/small.png">
      <link rel="icon" sizes="192x192" href="/large.png">`;
    assert.equal(discoverIconUrls(html, base)[0], 'https://www.example.co.uk/large.png');
  });

  it('resolves relative, root-relative and protocol-relative hrefs', () => {
    const html = `
      <link rel="icon" href="assets/icon.png">
      <link rel="apple-touch-icon" href="//cdn.example.com/icon.png">`;
    const urls = discoverIconUrls(html, `${base}/pages/home`);
    assert.ok(urls.includes('https://cdn.example.com/icon.png'));
    assert.ok(urls.includes('https://www.example.co.uk/pages/assets/icon.png'));
  });

  it('always offers /favicon.ico as a last resort, even with no declarations', () => {
    assert.deepEqual(discoverIconUrls('<head></head>', base), [
      'https://www.example.co.uk/favicon.ico',
    ]);
  });

  it('does not return the same URL twice', () => {
    const html = `
      <link rel="icon" href="/favicon.ico">
      <link rel="shortcut icon" href="/favicon.ico">`;
    const urls = discoverIconUrls(html, base);
    assert.equal(new Set(urls).size, urls.length);
  });

  it('ignores non-icon links and malformed hrefs', () => {
    const html = `
      <link rel="stylesheet" href="/site.css">
      <link rel="icon" href="ht tp://broken">`;
    assert.deepEqual(discoverIconUrls(html, base), ['https://www.example.co.uk/favicon.ico']);
  });
});
