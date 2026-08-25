// AIC-131: the reaper that deletes ad creatives which never became ads.
// Requires DATABASE_URL; self-skips otherwise.
//
// The tests are all about what it must NOT delete. Deleting an orphan is
// worthless if the same code can also delete a creative that is live in an ad,
// or one the customer made themselves.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { pool } from "../db/pool.js";
import {
  recordCreatedCreative, markCreativesAttached, listReapCandidates, reapAccount,
  type ReaperReader, type ReaperWriter,
} from "./creative-reaper.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;
const ACC = "act__it_reap";

class FakeMeta implements ReaperReader, ReaperWriter {
  public deleted: string[] = [];
  public failOn = new Set<string>();
  constructor(public inUse: string[] = [], public readFails = false) {}
  async listAdCreativeIdsInUse(): Promise<string[]> {
    if (this.readFails) throw new Error("graph 500");
    return this.inUse;
  }
  async deleteCreative(id: string): Promise<void> {
    if (this.failOn.has(id)) throw new Error("graph 400");
    this.deleted.push(id);
  }
}

// Backdate, because age is the whole mechanism.
async function age(id: string, hours: number) {
  await pool.query(
    `UPDATE created_creatives SET created_at = now() - ($2 || ' hours')::interval WHERE meta_creative_id = $1`,
    [id, String(hours)],
  );
}

d("creative reaper (AIC-131)", () => {
  beforeAll(async () => {
    await pool.query(`DELETE FROM created_creatives WHERE meta_ad_account_id = $1`, [ACC]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM created_creatives WHERE meta_ad_account_id = $1`, [ACC]);
    await pool.end();
  });

  it("deletes an old, unattached, unreferenced creative", async () => {
    await recordCreatedCreative(pool, "cr_orphan", ACC, null);
    await age("cr_orphan", 48);

    const meta = new FakeMeta([]);
    const r = await reapAccount({
      pool, reader: meta, writer: meta, adAccountId: ACC,
      candidates: await listReapCandidates(pool),
    });

    expect(r.deleted).toContain("cr_orphan");
    expect(meta.deleted).toContain("cr_orphan");
    // Marked, so it can never be rediscovered and deleted twice.
    const { rows } = await pool.query(`SELECT reaped_at FROM created_creatives WHERE meta_creative_id = 'cr_orphan'`);
    expect(rows[0].reaped_at).not.toBeNull();
    expect(await listReapCandidates(pool)).toHaveLength(0);
  });

  it("NEVER deletes one still referenced by an ad, even if our record says unattached", async () => {
    // An ad can be created outside our flow. Trusting attached_at instead of
    // asking Meta would delete the content out of a running ad.
    await recordCreatedCreative(pool, "cr_live", ACC, null);
    await age("cr_live", 48);

    const meta = new FakeMeta(["cr_live"]);
    const r = await reapAccount({
      pool, reader: meta, writer: meta, adAccountId: ACC,
      candidates: await listReapCandidates(pool),
    });

    expect(meta.deleted).toEqual([]);
    expect(r.reattached).toEqual(["cr_live"]);
    // Recorded as attached so it stops being reconsidered every tick.
    expect(await listReapCandidates(pool)).toHaveLength(0);
  });

  it("NEVER deletes a young one — that is a customer mid-form, not litter", async () => {
    await recordCreatedCreative(pool, "cr_fresh", ACC, null);
    // Left at now(): created moments ago.
    expect((await listReapCandidates(pool)).map((c) => c.creativeId)).not.toContain("cr_fresh");
  });

  it("NEVER deletes one we did not create", async () => {
    // The safety boundary: a creative the customer made in Ads Manager has no
    // row here, so it can never become a candidate. Meta reporting it as
    // unreferenced is not enough — it is theirs.
    const meta = new FakeMeta([]);
    const r = await reapAccount({
      pool, reader: meta, writer: meta, adAccountId: ACC,
      candidates: [], // nothing recorded ⇒ nothing considered
    });
    expect(r.considered).toBe(0);
    expect(meta.deleted).toEqual([]);
  });

  it("deletes NOTHING when the in-use read fails", async () => {
    // Without that read we cannot tell an orphan from a live creative, and the
    // failure mode of guessing is destroying a running ad's content.
    await recordCreatedCreative(pool, "cr_unknown", ACC, null);
    await age("cr_unknown", 48);

    const meta = new FakeMeta([], true);
    const r = await reapAccount({
      pool, reader: meta, writer: meta, adAccountId: ACC,
      candidates: await listReapCandidates(pool),
    });

    expect(meta.deleted).toEqual([]);
    expect(r.deleted).toEqual([]);
    // Still a candidate, so a transient failure just means "next tick".
    expect((await listReapCandidates(pool)).map((c) => c.creativeId)).toContain("cr_unknown");
  });

  it("leaves a failed delete unmarked, so it retries rather than silently vanishing", async () => {
    const meta = new FakeMeta([]);
    meta.failOn.add("cr_unknown");
    const r = await reapAccount({
      pool, reader: meta, writer: meta, adAccountId: ACC,
      candidates: await listReapCandidates(pool),
    });
    expect(r.failed.map((f) => f.creativeId)).toContain("cr_unknown");
    expect((await listReapCandidates(pool)).map((c) => c.creativeId)).toContain("cr_unknown");
  });

  it("markCreativesAttached takes a creative out of scope immediately", async () => {
    await recordCreatedCreative(pool, "cr_used", ACC, null);
    await age("cr_used", 48);
    expect((await listReapCandidates(pool)).map((c) => c.creativeId)).toContain("cr_used");

    await markCreativesAttached(pool, ["cr_used"]);
    expect((await listReapCandidates(pool)).map((c) => c.creativeId)).not.toContain("cr_used");
  });
});
