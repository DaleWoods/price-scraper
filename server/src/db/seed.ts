import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { syncCompetitorsToDatabase } from '../scraping/competitorRegistry.js';
import { runMigrations } from './migrate.js';
import { closePool } from './pool.js';

/** Applies migrations, then loads competitors/*.json into the database. */
async function seed(): Promise<void> {
  await runMigrations();
  const results = await syncCompetitorsToDatabase();
  for (const { slug, action } of results) console.log(`[seed] competitor ${slug}: ${action}`);
  console.log(`[seed] ${results.length} competitor definition(s) synced`);
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  seed()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}

export { seed };
