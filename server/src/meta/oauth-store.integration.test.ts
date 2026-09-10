// DB integration for the OAuth state store (AIC-186). Requires DATABASE_URL with
// migrations applied; self-skips otherwise.
//
// The nonce is what stops a captured callback URL from being replayed, and that
// property lives in a SQL predicate — it cannot be proven by a unit test against
// a fake. Hence a real database.
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { rememberState, spendState, sweepExpiredStates, NonceError } from "./oauth-store.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

// This file's own rows only — suites run in parallel and a broader match would
// delete a concurrent suite's state.
const MINE: string[] = [];

function nonce(): string {
  const n = `__it_oauth_${randomUUID()}`;
  MINE.push(n);
  return n;
}

d("meta_oauth_states (DB)", () => {
  afterAll(async () => {
    if (MINE.length) {
      await pool.query(`DELETE FROM meta_oauth_states WHERE nonce = ANY($1)`, [MINE]);
    }
    await pool.end();
  });

  const soon = () => new Date(Date.now() + 15 * 60_000);

  it("spends a fresh nonce exactly once", async () => {
    const n = nonce();
    const user = randomUUID();
    await rememberState(pool, n, user, soon());

    await expect(spendState(pool, n, user)).resolves.toBeUndefined();
    // The replay. Second presentation of the same captured callback.
    await expect(spendState(pool, n, user)).rejects.toThrow(NonceError);
  });

  it("refuses a nonce belonging to a different user", async () => {
    // Binding the nonce to the user is what stops one customer's in-flight
    // consent from being redeemed against another customer's account.
    const n = nonce();
    await rememberState(pool, n, randomUUID(), soon());
    await expect(spendState(pool, n, randomUUID())).rejects.toThrow(NonceError);
  });

  it("refuses an expired nonce", async () => {
    const n = nonce();
    const user = randomUUID();
    await rememberState(pool, n, user, new Date(Date.now() - 1000));
    await expect(spendState(pool, n, user)).rejects.toThrow(NonceError);
  });

  it("refuses a nonce that was never issued", async () => {
    await expect(spendState(pool, "__it_oauth_never_existed", randomUUID())).rejects.toThrow(NonceError);
  });

  it("gives the same message for missing, spent and expired", async () => {
    // Different messages would tell an attacker which nonces are real.
    const spent = nonce(), expired = nonce();
    const user = randomUUID();
    await rememberState(pool, spent, user, soon());
    await spendState(pool, spent, user);
    await rememberState(pool, expired, user, new Date(Date.now() - 1000));

    const messages = await Promise.all(
      [spent, expired, "__it_oauth_absent"].map((n) =>
        spendState(pool, n, user).then(() => "resolved", (e: Error) => e.message)),
    );
    expect(new Set(messages).size).toBe(1);
  });

  it("only two concurrent callbacks race, and exactly one wins", async () => {
    // The single-statement UPDATE is what makes this true; a SELECT-then-UPDATE
    // would let both through.
    const n = nonce();
    const user = randomUUID();
    await rememberState(pool, n, user, soon());

    const results = await Promise.allSettled([
      spendState(pool, n, user),
      spendState(pool, n, user),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("the sweeper leaves live rows alone", async () => {
    const live = nonce();
    await rememberState(pool, live, randomUUID(), soon());
    await sweepExpiredStates(pool);
    const { rowCount } = await pool.query(`SELECT 1 FROM meta_oauth_states WHERE nonce = $1`, [live]);
    expect(rowCount).toBe(1);
  });
});
