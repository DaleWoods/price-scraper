import { chromium, type Browser } from 'playwright';
import { logger } from '../lib/logger.js';

let browserPromise: Promise<Browser> | null = null;

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
        throw new Error(
          `Could not launch Chromium: ${(err as Error).message}\n` +
            'Run `npx playwright install --with-deps chromium`, or set ' +
            'PLAYWRIGHT_CHROMIUM_EXECUTABLE to an existing Chromium binary.',
          { cause: err },
        );
      });
  }
  return browserPromise;
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
