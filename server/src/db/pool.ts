import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn(
    "[db] DATABASE_URL is not set. The server will start but DB queries will fail.",
  );
}

// Neon (and any hosted Postgres) requires SSL; local Postgres typically
// doesn't and rejects it. Anything not pointing at localhost gets SSL with
// rejectUnauthorized:false so we accept the provider's chain-trusted certs.
function needsSsl(url: string | undefined): boolean {
  if (!url) return false;
  return !/localhost|127\.0\.0\.1/.test(url);
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : undefined,
  max: 10,
});

pool.on("error", (err) => {
  console.error("[db] unexpected pool error", err);
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

// Run `fn` inside a single BEGIN/COMMIT transaction on one pooled client,
// rolling back on any throw. The single home for transactional work — the
// safe-execute pipeline (AIC-12) and every multi-step write route through
// here so BEGIN/COMMIT/ROLLBACK is never hand-rolled inconsistently.
export async function withTx<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
