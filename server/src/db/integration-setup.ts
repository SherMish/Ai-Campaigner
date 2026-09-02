import pg from "pg";
import { describeTarget, refusalMessage, TEST_MARKER_TABLE } from "./test-db-guard.js";

// AIC-84 — runs ONCE before the integration suite, and refuses the whole run
// rather than letting a single test touch production.
//
// globalSetup, not setupFiles: this must fail the run before any file opens a
// connection, and it should cost one check rather than one per file.
//
// A missing DATABASE_URL is not an error here — the suite already self-skips
// without one, which is what lets a developer with no database get a green
// run. Refusing that case would break the very thing it protects.
export default async function guardTestDatabase(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;

  const target = describeTarget(url);
  if (target.local) return;

  // Remote is not automatically production — an ephemeral Neon branch is
  // exactly the isolation this ticket asks for. But it has to SAY so, once,
  // by carrying the marker. Production never will.
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const { rows } = await pool.query<{ marked: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS marked`,
      [`public.${TEST_MARKER_TABLE}`],
    );
    if (!rows[0]?.marked) throw new Error(refusalMessage(target));
  } finally {
    await pool.end();
  }
}
