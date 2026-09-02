// AIC-84 — integration tests must never be able to write to production.
//
// The hazard is not hypothetical and it is not about discipline. `server/.env`
// holds the PRODUCTION DATABASE_URL, because the server needs it to run. The
// integration suite reads the same variable. So the default outcome of typing
// `npm run test:integration` in a checkout is that ~460 tests seed, mutate and
// delete rows in the live database — and the only thing standing between that
// and permanent debris is every `afterAll` running, which a failed assertion,
// a timeout or a Ctrl-C all prevent.
//
// That has already happened twice (leaked `__it_outbox` customers visible in
// the ops console; the AIC-76 verification seeding). Cleanup-on-success is not
// isolation.
//
// CI is already safe — AIC-109 gave it a throwaway postgres:16 service
// container. This closes the local half, which is the one that actually bit.
//
// The rule is deliberately about the DATABASE rather than about intent: a
// guard you can forget to invoke is the same kind of promise as a cleanup
// hook you can fail to reach.

/** The marker a non-local database must carry to be usable by the suite. */
export const TEST_MARKER_TABLE = "aic_test_database";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);

export interface TargetDescription {
  host: string;
  database: string;
  local: boolean;
}

/**
 * Where a connection string points, and whether that is a local database.
 *
 * Local is the fast path because it is the true one: production is Neon and
 * therefore remote, CI is a service container on localhost, and a developer's
 * throwaway is on localhost. A remote target is not automatically refused —
 * it just has to prove it is a test database (see the marker below), which is
 * what keeps a future ephemeral Neon branch possible.
 *
 * An unparseable URL is treated as NOT local. The failure mode of guessing
 * wrong in the other direction is writing to production.
 */
export function describeTarget(url: string): TargetDescription {
  try {
    const u = new URL(url);
    const host = u.hostname;
    return { host, database: u.pathname.replace(/^\//, ""), local: LOCAL_HOSTS.has(host) };
  } catch {
    return { host: "(unparseable)", database: "(unknown)", local: false };
  }
}

/** The message a developer sees instead of a suite that quietly hits prod. */
export function refusalMessage(t: TargetDescription): string {
  return [
    "",
    "  ✗ Integration tests refused to run.",
    "",
    `    DATABASE_URL points at a REMOTE database: ${t.host}/${t.database}`,
    "    server/.env holds the production URL, so this is almost certainly production.",
    "",
    "    Run them against a local throwaway instead:",
    "",
    `      createdb aic_test && DATABASE_URL="postgresql://$(whoami)@localhost:5432/aic_test" npm run --workspace server db:migrate`,
    `      DATABASE_URL="postgresql://$(whoami)@localhost:5432/aic_test" npm run --workspace server test:integration`,
    "",
    "    If this target really IS a disposable test database (an ephemeral Neon",
    "    branch, say), mark it once and this guard will allow it:",
    "",
    "      npm run --workspace server db:test:prepare",
    "",
  ].join("\n");
}
