import pg from "pg";
import { describeTarget, TEST_MARKER_TABLE } from "./test-db-guard.js";

// AIC-84 — mark a database as disposable, so the integration guard allows it.
//
// Deliberately a SEPARATE, explicit command rather than something the suite
// can do for itself. A guard that creates its own permission is not a guard;
// the whole value is that somebody had to decide, once, that this particular
// database is safe to destroy.
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set — nothing to mark.");
    process.exit(1);
  }
  const target = describeTarget(url);
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${TEST_MARKER_TABLE} (
         marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         note TEXT NOT NULL DEFAULT 'Disposable database. The AIC integration suite may seed, mutate and delete freely here.'
       )`,
    );
    console.log(`[test-db] marked ${target.host}/${target.database} as disposable.`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
