import { existsSync, readdirSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { logger } from '../lib/logger.js';

let browserPromise: Promise<Browser> | null = null;

/** Where the Playwright base image keeps its pre-installed browsers. */
const IMAGE_BROWSERS_PATH = '/ms-playwright';

/**
 * Setting PLAYWRIGHT_BROWSERS_PATH to a directory that holds no browsers is the
 * single easiest way to break this app in a container — Playwright then reports
 * a missing executable, which reads like a build problem rather than the config
 * mistake it is. Turn it into a message that names the actual cause.
 */
function diagnoseBrowsersPath(): string | null {
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (!configured || configured === '0') return null;

  const populated = (dir: string): boolean => {
    try {
      return existsSync(dir) && readdirSync(dir).some((entry) => entry.startsWith('chromium'));
    } catch {
      return false;
    }
  };

  if (populated(configured)) return null;

  const hint = populated(IMAGE_BROWSERS_PATH)
    ? ` Chromium IS present at ${IMAGE_BROWSERS_PATH} — unset PLAYWRIGHT_BROWSERS_PATH so Playwright uses it.`
    : '';

  return (
    `PLAYWRIGHT_BROWSERS_PATH is set to "${configured}", which contains no Chromium build.` + hint
  );
}

/**
 * One shared Chromium instance for the process. Contexts are created per fetch
 * so cookies never leak between competitor sites.
 */
export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    // Hosts that ship their own Chromium (or pin a different Playwright build)
    // can point at it directly instead of downloading a second copy.
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?.trim();

    browserPromise = chromium
      .launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      })
      .catch((err) => {
        browserPromise = null;
        const misconfiguration = diagnoseBrowsersPath();
        throw new Error(
          `Could not launch Chromium: ${(err as Error).message}\n` +
            (misconfiguration
              ? misconfiguration
              : 'Run `npx playwright install --with-deps chromium`, or set ' +
                'PLAYWRIGHT_CHROMIUM_EXECUTABLE to an existing Chromium binary.'),
          { cause: err },
        );
      });
  }
  return browserPromise;
}

/** Surface a broken browsers path at boot, not on the first failed scrape. */
export function warnIfBrowsersPathMisconfigured(): void {
  const problem = diagnoseBrowsersPath();
  if (problem) logger.warn('browser', `${problem} Every scrape will fail until this is corrected.`);
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch (err) {
    logger.warn('browser', `error closing browser: ${(err as Error).message}`);
  } finally {
    browserPromise = null;
  }
}
