import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contentTypeFor, isRenderableImage, sniffImageType } from '../src/competitors/logos.ts';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(8)]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const ico = Buffer.from([0x00, 0x00, 0x01, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const svgWithProlog = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="x"></svg>');

describe('sniffImageType', () => {
  it('identifies each format we accept from its bytes alone', () => {
    assert.equal(sniffImageType(png), 'image/png');
    assert.equal(sniffImageType(gif), 'image/gif');
    assert.equal(sniffImageType(jpeg), 'image/jpeg');
    assert.equal(sniffImageType(ico), 'image/x-icon');
    assert.equal(sniffImageType(webp), 'image/webp');
    assert.equal(sniffImageType(svg), 'image/svg+xml');
    assert.equal(sniffImageType(svgWithProlog), 'image/svg+xml', 'XML prolog before <svg>');
  });

  it('rejects things that are not images', () => {
    assert.equal(sniffImageType(Buffer.from('#!/bin/sh\nrm -rf /')), null);
    assert.equal(sniffImageType(Buffer.from('MZ\x90\x00')), null, 'a Windows executable');
    assert.equal(sniffImageType(Buffer.from('%PDF-1.7')), null);
    assert.equal(sniffImageType(Buffer.alloc(0)), null);
  });

  it('does not care what the file claims to be', () => {
    // The upload path relies on this: a script renamed to .png must not pass.
    assert.equal(sniffImageType(Buffer.from('<script>alert(1)</script>')), null);
  });
});

describe('contentTypeFor', () => {
  it('trusts the bytes over a wrong declaration', () => {
    assert.equal(contentTypeFor('image/jpeg', png), 'image/png');
    assert.equal(contentTypeFor('application/octet-stream', png), 'image/png');
  });

  it('falls back to the declared image type when bytes are unrecognised', () => {
    assert.equal(contentTypeFor('image/avif', Buffer.from([1, 2, 3, 4])), 'image/avif');
  });
});

describe('isRenderableImage (fetch path)', () => {
  it('accepts a declared image type it cannot sniff, for formats browsers know', () => {
    assert.equal(isRenderableImage('image/avif', Buffer.from([1, 2, 3, 4])), true);
  });

  it('accepts sniffable bytes sent as octet-stream', () => {
    assert.equal(isRenderableImage('application/octet-stream', png), true);
  });

  it('refuses non-images and oversized payloads', () => {
    assert.equal(isRenderableImage('text/html', Buffer.from('<html></html>')), false);
    assert.equal(isRenderableImage('image/png', Buffer.alloc(0)), false);
    assert.equal(isRenderableImage('image/png', Buffer.alloc(600 * 1024)), false);
  });
});
