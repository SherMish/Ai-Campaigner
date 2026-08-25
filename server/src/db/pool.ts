import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn(
    "[db] DATABASE_URL is not set. The server will start but DB queries will fail.",
  );
}

// Neon (and any hosted Postgres) requires SSL; local Postgres typically
// doesn't and rejects it.
function needsSsl(url: string | undefined): boolean {
  if (!url) return false;
  return !/localhost|127\.0\.0\.1/.test(url);
}

// SECURITY (security audit 2026-08-25). This used to pass `rejectUnauthorized: false`, whose
// comment claimed we "accept the provider's chain-trusted certs" — the exact
// opposite of what the flag does. It disables certificate verification
// entirely, so ANY server presenting ANY certificate was trusted: a
// man-in-the-middle on the path to the database could read and rewrite every
// query, which on this database means every customer's ads, budgets and
// credentials.
//
// Verified against the real production Neon instance before changing it: full
// verification connects successfully, because Neon serves a normal publicly
// trusted certificate. There was never a reason to disable it.
//
// The escape hatch exists because a CA rotation that Node's bundled store
// doesn't yet trust would otherwise be a hard outage with no lever. It is
// deliberately loud, and deliberately not the default.
function sslConfig(): { rejectUnauthorized: boolean } | undefined {
  if (!needsSsl(process.env.DATABASE_URL)) return undefined;
  if (process.env.DATABASE_SSL_NO_VERIFY === "1") {
    console.error(
      "[db] ⚠️  DATABASE_SSL_NO_VERIFY=1 — TLS certificate verification is OFF. " +
        "The connection is encrypted but NOT authenticated, so it is open to a " +
        "man-in-the-middle. Use only to ride out a CA problem, and remove it after.",
    );
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

// `sslmode` is stripped from the URL rather than left for pg-connection-string
// to interpret. Two reasons: it emits a deprecation warning on every boot
// because 'require' currently means verify-full and will silently WEAKEN to
// libpq semantics in pg v9 — a security posture that changes under us on a
// dependency bump is not one we want to inherit — and leaving it there means
// the effective setting is split between the URL and the code, where the two
// can disagree. The `ssl` object above is now the single source of truth.
function connectionString(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    u.searchParams.delete("sslmode");
    u.searchParams.delete("channel_binding");
    return u.toString();
  } catch {
    return raw; // not a parseable URL — hand it to pg unchanged and let it complain
  }
}

export const pool = new Pool({
  connectionString: connectionString(),
  ssl: sslConfig(),
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
