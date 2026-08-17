import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { Competitor } from '../src/domain/types.ts';
import { fetchPage } from '../src/scraping/fetcher.ts';

/**
 * Coverage for the retry override discovery relies on.
 *
 * Reported: a single-product test run took over eight minutes and the app
 * became unreachable — Render restarted it after its health check timed out.
 * Root cause: discovery opened up to three unproven candidate pages per
 * competitor, and each one retried against the competitor's full retry policy
 * (three attempts at a 30s timeout by default) even though the candidate might
 * not even be the right product. `maxAttempts` lets a caller override that for
 * a single call, which discovery now does for every candidate it opens.
 *
 * Each case gets its own server/origin: the rate limiter enforces a floor
 * between requests to the *same* host (3s by default, not overridable per
 * competitor — that part is intentional politeness), which would otherwise
 * swamp the timing this test is actually checking: attempt count, not delay.
 */
describe('fetchPage maxAttempts override', () => {
  function competitor(origin: string, overrides: Partial<Competitor['config']> = {}): Competitor {
    return {
      id: 1,
      slug: 'test-co',
      display_name: 'Test Co',
      base_url: origin,
      search_url_pattern: `${origin}/search?q={query}`,
      brands: [],
      enabled: true,
      scrape_frequency: 'daily',
      config: {
        rendering: 'http',
        rateLimit: { minDelayMs: 0, jitterMs: 0, maxConcurrent: 1 },
        retry: { attempts: 3, backoffMs: 1 },
        ...overrides,
      },
      logo_url: null,
      logo_fetched_at: null,
      logo_error: null,
      has_logo: false,
      created_at: '',
      updated_at: '',
    } as Competitor;
  }

  async function failingServer(): Promise<{ origin: string; server: Server; hits: () => number }> {
    let hitCount = 0;
    const server = createServer((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('User-agent: *\n');
        return;
      }
      // Every other request fails with a retryable status, quickly — no
      // artificial delay, so the test proves attempt *count*, not timing.
      hitCount += 1;
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('unavailable');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    return { origin, server, hits: () => hitCount };
  }

  let serverA: Server;
  let serverB: Server;

  after(async () => {
    await Promise.all([
      serverA ? new Promise<void>((resolve) => serverA.close(() => resolve())) : Promise.resolve(),
      serverB ? new Promise<void>((resolve) => serverB.close(() => resolve())) : Promise.resolve(),
    ]);
  });

  it('retries up to the competitor-configured attempts by default', async () => {
    const { origin, server, hits } = await failingServer();
    serverA = server;
    await assert.rejects(() => fetchPage(competitor(origin), `${origin}/p/one`));
    assert.equal(hits(), 3, 'the competitor is configured for 3 attempts');
  });

  it('makes exactly one attempt when maxAttempts overrides it', async () => {
    const { origin, server, hits } = await failingServer();
    serverB = server;
    await assert.rejects(() => fetchPage(competitor(origin), `${origin}/p/two`, { maxAttempts: 1 }));
    assert.equal(hits(), 1, 'a discovery candidate should not be retried against a full policy');
  });
});
