import { Agent, fetch as undiciFetch } from 'undici';

/**
 * The one HTTP client every request to a competitor goes through.
 *
 * It exists for a fault found the first time the app read Beaverbrooks for
 * real: their product pages answer with response headers larger than Node's
 * default 16 KB limit, and Node's built-in `fetch` rejects such a response
 * before any of it can be read. The failure surfaces as a bare "fetch failed"
 * — indistinguishable from the site being down — on a page that is in fact
 * perfectly healthy and loads in under a second. The built-in `fetch` has no
 * setting for that limit; a dispatcher from the `undici` package does.
 *
 * Connections are kept alive and reused per site, which is also what a browser
 * does: one connection carrying many requests is lighter on a retailer's
 * servers than a new TLS handshake for every page.
 */
const agent = new Agent({
  maxHeaderSize: 256 * 1024,
  connect: { timeout: 15_000 },
  keepAliveTimeout: 15_000,
});

export interface SiteFetchInit {
  headers?: Record<string, string>;
  redirect?: 'follow' | 'manual' | 'error';
  signal?: AbortSignal;
}

export function siteFetch(url: string, init: SiteFetchInit = {}): Promise<Response> {
  // undici's Response is the same Fetch-standard object as the global one; the
  // two are declared separately, hence the cast.
  return undiciFetch(url, { ...init, dispatcher: agent }) as unknown as Promise<Response>;
}
