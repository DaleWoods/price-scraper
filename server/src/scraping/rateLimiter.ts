import { env } from '../config/env.js';

interface DomainState {
  /** Earliest wall-clock time the next request to this domain may start. */
  nextAllowedAt: number;
  inFlight: number;
  waiters: (() => void)[];
}

const domains = new Map<string, DomainState>();

export interface RateLimitOptions {
  minDelayMs?: number;
  jitterMs?: number;
  maxConcurrent?: number;
}

function stateFor(domain: string): DomainState {
  let state = domains.get(domain);
  if (!state) {
    state = { nextAllowedAt: 0, inFlight: 0, waiters: [] };
    domains.set(domain, state);
  }
  return state;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Per-domain politeness (Spec §5.4, §9): a minimum gap between requests plus
 * randomised jitter, and a hard cap on concurrent requests to one host. The
 * configured delay can raise the global floor but never lower it.
 */
export async function withRateLimit<T>(
  url: string,
  options: RateLimitOptions,
  task: () => Promise<T>,
): Promise<T> {
  const domain = new URL(url).host;
  const state = stateFor(domain);

  const minDelay = Math.max(env.minRequestDelayMs, options.minDelayMs ?? 0);
  const jitter = Math.max(0, options.jitterMs ?? 1000);
  const maxConcurrent = Math.max(1, Math.min(options.maxConcurrent ?? 1, env.maxConcurrentScrapes));

  while (state.inFlight >= maxConcurrent) {
    await new Promise<void>((resolve) => state.waiters.push(resolve));
  }
  state.inFlight += 1;

  try {
    const waitMs = state.nextAllowedAt - Date.now();
    if (waitMs > 0) await sleep(waitMs);

    // Reserve the next slot before the request runs, so parallel callers space out.
    const gap = minDelay + Math.floor(Math.random() * jitter);
    state.nextAllowedAt = Date.now() + gap;

    return await task();
  } finally {
    state.inFlight -= 1;
    state.nextAllowedAt = Math.max(state.nextAllowedAt, Date.now() + minDelay);
    const next = state.waiters.shift();
    if (next) next();
  }
}

