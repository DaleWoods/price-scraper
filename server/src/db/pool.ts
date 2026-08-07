import pg from 'pg';
import { env } from '../config/env.js';

const { Pool, types } = pg;

// NUMERIC comes back as a string by default (arbitrary precision). Prices in this
// app are money with 2dp and always well inside IEEE-754 exact range, so parsing
// to number here keeps the API JSON clean.
types.setTypeParser(types.builtins.NUMERIC, (value: string) => Number.parseFloat(value));
types.setTypeParser(types.builtins.INT8, (value: string) => Number.parseInt(value, 10));

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;

  const connectionString = env.databaseUrl;
  // Hosted Postgres providers (Neon, Supabase, Render) terminate TLS with certs
  // that aren't in Node's default trust store, so verification is relaxed unless
  // the connection string explicitly asks for full verification.
  const wantsStrictSsl = /sslmode=verify-(ca|full)/.test(connectionString);
  const disableSsl = /sslmode=disable/.test(connectionString);

  pool = new Pool({
    connectionString,
    ssl: disableSsl ? false : { rejectUnauthorized: wantsStrictSsl },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });

  pool.on('error', (err) => {
    console.error('[db] idle client error', err);
  });

  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
