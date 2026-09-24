import pg from "pg";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

// bigint (int8) and numeric come back as strings by default; the counts and
// costs this app stores fit comfortably in a JS number.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  if (!pool) {
    const url = env().DATABASE_URL;
    pool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Railway's public Postgres proxy requires TLS; the private network does not.
      ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
    });
    pool.on("error", (err) => logger.error({ err }, "postgres pool error"));
  }
  return pool;
}

export type Queryable = Pick<pg.Pool, "query">;

export async function one<T extends pg.QueryResultRow>(sql: string, params: unknown[] = [], q: Queryable = db()): Promise<T | undefined> {
  const r = await q.query<T>(sql, params);
  return r.rows[0];
}

export async function many<T extends pg.QueryResultRow>(sql: string, params: unknown[] = [], q: Queryable = db()): Promise<T[]> {
  const r = await q.query<T>(sql, params);
  return r.rows;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}
