import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';

/**
 * How hard the app can work, from how much memory its server has.
 *
 * Reading competitors' sites costs memory: every page in flight is held while
 * it is parsed (some are over a megabyte), and a page that needs a real
 * browser starts Chromium, which alone takes a good part of 512 MB. On
 * 17 November 2026 the free Render instance (512 MB) ran out and restarted
 * once every competitor was read at once, two pages each. So the pace is set
 * by the memory available: gentle on a small server, full speed on a larger
 * one, with no setting to remember to change when the plan changes.
 */
function memoryLimitBytes(): number {
  // A container's limit is in its cgroup; the machine's total memory is not
  // what this process may use.
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = readFileSync(file, 'utf8').trim();
      const value = Number(raw);
      if (raw !== 'max' && Number.isFinite(value) && value > 0 && value < 1e15) return value;
    } catch {
      /* not this kind of container */
    }
  }
  const fromEnv = Number(process.env.APP_MEMORY_MB);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv * 1024 * 1024;
  // On Render with no readable limit, the machine's total memory is the
  // host's, not ours: assume the smallest plan rather than run out. On a
  // larger plan, set APP_MEMORY_MB (e.g. 2048) to go full speed.
  if (process.env.RENDER) return 512 * 1024 * 1024;
  return totalmem();
}

const GB = 1024 * 1024 * 1024;
const memory = memoryLimitBytes();
/** Under about 1 GB: the free and Starter plans. */
export const smallServer = memory < 0.9 * GB;

export const capacity = {
  memoryMb: Math.round(memory / 1024 / 1024),
  /** Competitors read at the same time in one check. */
  competitorsAtOnce: smallServer ? 3 : 16,
  /** Pages read at the same time from any one competitor. */
  pagesPerSite: smallServer ? 1 : 2,
  /** Pages open in the browser at the same time, across everything. */
  browserPages: smallServer ? 1 : 2,
};
