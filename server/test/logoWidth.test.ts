import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { imageWidth } from '../src/competitors/logos.ts';

/** The logo fetcher keeps looking past a small icon; these read an icon's width. */
describe('reading an icon’s width', () => {
  it('reads a PNG', () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(png);
    png.writeUInt32BE(180, 16);
    assert.equal(imageWidth(png), 180);
  });

  it('takes the largest image in an ICO, where 0 means 256', () => {
    const ico = Buffer.alloc(6 + 32);
    ico.writeUInt16LE(1, 2);
    ico.writeUInt16LE(2, 4);
    ico[6] = 32;
    ico[22] = 0;
    assert.equal(imageWidth(ico), 256);
    ico[22] = 16;
    assert.equal(imageWidth(ico), 32);
  });

  it('reads a lossy WebP', () => {
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBP', 8, 'latin1');
    webp.write('VP8 ', 12, 'latin1');
    webp.writeUInt16LE(32, 26);
    assert.equal(imageWidth(webp), 32);
  });

  it('gives no width for a format it does not measure', () => {
    assert.equal(imageWidth(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  });
});
