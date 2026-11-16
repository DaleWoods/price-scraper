import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

/**
 * The SQL functions used in index expressions must work with the search path
 * cut down to pg_catalog.
 *
 * Postgres 17 builds and rebuilds indexes that way. A function that calls
 * another of ours by its short name works in every query and in tests on
 * Postgres 16, then fails the moment Postgres 17 builds an index on it — which
 * is how migration 022 first failed to deploy ("function ident_key(text) does
 * not exist"). Calling each one under the same restriction reproduces that on
 * any version.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('SQL functions used in indexes', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let pool: typeof import('../src/db/pool.ts');

  after(async () => {
    await pool?.closePool();
  });

  for (const [fn, input, expected] of [
    ['gtin_key', '0703200164298', '703200164298'],
    ['ident_key', '220.13.41-21', '220134121'],
    ['ref_key', 'O21030422004001', '21030422004001'],
  ] as const) {
    it(`${fn} works with only pg_catalog on the search path`, async () => {
      pool ??= await import('../src/db/pool.ts');
      const result = await pool.withTransaction(async (client) => {
        await client.query('SET LOCAL search_path = pg_catalog');
        const { rows } = await client.query<{ value: string }>(`SELECT public.${fn}($1) AS value`, [input]);
        return rows[0]!.value;
      });
      assert.equal(result, expected);
    });
  }
});
