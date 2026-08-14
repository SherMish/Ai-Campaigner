// DB integration for outcome measurement (AIC-76). Requires DATABASE_URL;
// self-skips otherwise.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { PgSnapshotStore } from "../meta/snapshot-store.js";
import { listDueForMeasurement, detectConfounds, measureOne, runOutcomeTick } from "./outcome-measurement.js";
import { measurementWindows } from "../recommendations/outcomes.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

// Executed 2026-08-10 → before 08-03..08-09, after 08-11..08-17, due from 08-18.
const EXECUTED_AT = new Date("2026-08-10T14:30:00.000Z");
const NOW = new Date("2026-08-20T00:00:00.000Z"); // comfortably past the after-window

async function seedCampaign(tag: string, overrides?: Record<string, number>): Promise<{ campaignId: string; customerId: string }> {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name) VALUES ($1) RETURNING id`,
    [`__it_outcome_${tag}`],
  );
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(`INSERT INTO meta_connections (customer_id) VALUES ($1) RETURNING id`, [customerId]);
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_o_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, agreed_budget_agorot, threshold_overrides)
     VALUES ($1,$2,7000,$3) RETURNING id`,
    [customerId, acct.rows[0].id, JSON.stringify(overrides ?? {})],
  );
  return { campaignId: camp.rows[0].id, customerId };
}

async function seedRec(
  campaignId: string,
  opts: { state?: string; type?: string; executedAt?: Date | null } = {},
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO recommendations (campaign_id, type, state, executed_at, rationale)
     VALUES ($1,$2,$3,$4,'test') RETURNING id`,
    [campaignId, opts.type ?? "pause_creative", opts.state ?? "executed", opts.executedAt ?? EXECUTED_AT],
  );
  return r.rows[0].id;
}

// Disjoint per-day campaign rows (the only shape campaignTotals/dailySeries
// read — insight_snapshot_daily, migration 030).
async function seedDays(campaignId: string, days: Array<{ date: string; spendAgorot: number; leads: number }>) {
  for (const day of days) {
    await pool.query(
      `INSERT INTO insight_snapshots
         (campaign_id, grain, meta_object_id, period_start, period_end, spend_agorot, leads, cpl_agorot)
       VALUES ($1,'campaign','camp',$2,$2,$3,$4,$5)`,
      [campaignId, day.date, day.spendAgorot, day.leads, day.leads > 0 ? Math.round(day.spendAgorot / day.leads) : null],
    );
  }
}

const range = (start: string, n: number) =>
  Array.from({ length: n }, (_, i) => new Date(new Date(`${start}T00:00:00Z`).getTime() + i * 86400000).toISOString().slice(0, 10));

d("outcome measurement (DB)", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_outcome_%'`);
    await pool.end();
  });

  it("lists an executed recommendation whose after-window has closed", async () => {
    const { campaignId } = await seedCampaign("due");
    const recId = await seedRec(campaignId);

    const due = await listDueForMeasurement(pool, NOW);
    const mine = due.find((x) => x.recommendationId === recId);
    expect(mine).toBeDefined();
    expect(mine!.cooldownDays).toBe(7); // global default, no override
  });

  it("does NOT list it while the after-window is still open", async () => {
    const { campaignId } = await seedCampaign("notyet");
    const recId = await seedRec(campaignId);

    // 2026-08-15 is inside the after-window (08-11..08-17).
    const due = await listDueForMeasurement(pool, new Date("2026-08-15T00:00:00Z"));
    expect(due.find((x) => x.recommendationId === recId)).toBeUndefined();
  });

  // The trap: completeExecution stamps executed_at on the FAILED path too, so
  // filtering on `executed_at IS NOT NULL` alone would measure a change that
  // never actually landed on Meta.
  it("EXCLUDES a failed recommendation even though its executed_at is set", async () => {
    const { campaignId } = await seedCampaign("failed");
    const recId = await seedRec(campaignId, { state: "failed" });

    const { rows } = await pool.query(`SELECT executed_at FROM recommendations WHERE id = $1`, [recId]);
    expect(rows[0].executed_at).not.toBeNull(); // precondition: the trap is real

    const due = await listDueForMeasurement(pool, NOW);
    expect(due.find((x) => x.recommendationId === recId)).toBeUndefined();
  });

  it("excludes a recommendation that already has an outcome row", async () => {
    const { campaignId } = await seedCampaign("measured");
    const recId = await seedRec(campaignId);
    await seedDays(campaignId, [
      ...range("2026-08-03", 7).map((date) => ({ date, spendAgorot: 4000, leads: 1 })),
      ...range("2026-08-11", 7).map((date) => ({ date, spendAgorot: 3000, leads: 1 })),
    ]);

    expect((await listDueForMeasurement(pool, NOW)).some((x) => x.recommendationId === recId)).toBe(true);
    await measureOne({
      pool,
      snapshotStore: new PgSnapshotStore(pool),
      due: { recommendationId: recId, campaignId, type: "pause_creative", executedAt: EXECUTED_AT, cooldownDays: 7 },
    });
    expect((await listDueForMeasurement(pool, NOW)).some((x) => x.recommendationId === recId)).toBe(false);
  });

  // Pins the OTHER half of the invariant: the production caller really does
  // use COOLDOWN_DAYS (the pure test pins that, given one N, due-ness and
  // cooldown-expiry coincide).
  it("a per-account COOLDOWN_DAYS override changes when it becomes due", async () => {
    const { campaignId } = await seedCampaign("override", { COOLDOWN_DAYS: 3 });
    const recId = await seedRec(campaignId);

    // 3-day window → after-window 08-11..08-13, due from 08-14. The default 7
    // would NOT be due yet on that date.
    const due = await listDueForMeasurement(pool, new Date("2026-08-14T00:00:00Z"));
    const mine = due.find((x) => x.recommendationId === recId);
    expect(mine).toBeDefined();
    expect(mine!.cooldownDays).toBe(3);
  });

  it("measures a real improvement end-to-end and persists the raw delta alongside the bucket", async () => {
    const { campaignId } = await seedCampaign("improved");
    const recId = await seedRec(campaignId);
    // before: ₪40/day, 1 lead/day → CPL 4000. after: ₪30/day, 1 lead/day → CPL 3000. -25%.
    await seedDays(campaignId, [
      ...range("2026-08-03", 7).map((date) => ({ date, spendAgorot: 4000, leads: 1 })),
      ...range("2026-08-11", 7).map((date) => ({ date, spendAgorot: 3000, leads: 1 })),
    ]);

    const verdict = await measureOne({
      pool,
      snapshotStore: new PgSnapshotStore(pool),
      due: { recommendationId: recId, campaignId, type: "pause_creative", executedAt: EXECUTED_AT, cooldownDays: 7 },
    });
    expect(verdict).toBe("improved");

    // DATE columns read back via to_char, not raw — pg parses `DATE` as a
    // local-midnight JS Date, and .toISOString() (UTC) shifts it a day
    // backward outside UTC (the same reason dailySeries reads period_start
    // via to_char in snapshot-store.ts). Casting in SQL is the exact string
    // stored, no timezone in the round-trip at all.
    const { rows } = await pool.query(
      `SELECT *, to_char(before_start, 'YYYY-MM-DD') AS before_start_text,
              to_char(after_end, 'YYYY-MM-DD') AS after_end_text
       FROM recommendation_outcomes WHERE recommendation_id = $1`,
      [recId],
    );
    expect(rows).toHaveLength(1);
    const o = rows[0];
    expect(o.verdict).toBe("improved");
    expect(o.before_features.cplAgorot).toBe(4000);
    expect(o.after_features.cplAgorot).toBe(3000);
    expect(o.delta.cplPct).toBe(-25); // the raw movement, stored regardless of bucket
    expect(o.confound_detail).toBeNull();
    // The exact days compared, so a verdict is always auditable.
    expect(o.before_start_text).toBe("2026-08-03");
    expect(o.after_end_text).toBe("2026-08-17");
  });

  it("insufficient_data when the after-window produced no leads (CPL is null, never a fake 0)", async () => {
    const { campaignId } = await seedCampaign("insufficient");
    const recId = await seedRec(campaignId);
    await seedDays(campaignId, [
      ...range("2026-08-03", 7).map((date) => ({ date, spendAgorot: 4000, leads: 1 })),
      ...range("2026-08-11", 7).map((date) => ({ date, spendAgorot: 3000, leads: 0 })),
    ]);

    const verdict = await measureOne({
      pool,
      snapshotStore: new PgSnapshotStore(pool),
      due: { recommendationId: recId, campaignId, type: "pause_creative", executedAt: EXECUTED_AT, cooldownDays: 7 },
    });
    expect(verdict).toBe("insufficient_data");
    const { rows } = await pool.query(`SELECT after_features FROM recommendation_outcomes WHERE recommendation_id = $1`, [recId]);
    expect(rows[0].after_features.cplAgorot).toBeNull();
  });

  it("detects a manual action inside the window as a confound, and says which", async () => {
    const { campaignId } = await seedCampaign("confound");
    const recId = await seedRec(campaignId);
    // A manual AIC-66 pause (recommendation_id NULL) mid-after-window.
    await pool.query(
      `INSERT INTO action_history (campaign_id, what, action_type, human_involved, result, occurred_at)
       VALUES ($1,'manual pause','pause_ad_set', true, 'success', '2026-08-13T09:00:00Z')`,
      [campaignId],
    );

    const { before, after } = measurementWindows(EXECUTED_AT, 7);
    const confound = await detectConfounds(pool, {
      campaignId,
      recommendationId: recId,
      before,
      after,
      afterDaily: [],
    });
    expect(confound).not.toBeNull();
    expect(confound!.otherActions).toHaveLength(1);
    expect(confound!.otherActions![0].actionType).toBe("pause_ad_set");
  });

  it("does NOT count the measured recommendation's OWN action row as a confound", async () => {
    const { campaignId } = await seedCampaign("ownaction");
    const recId = await seedRec(campaignId);
    await pool.query(
      `INSERT INTO action_history (campaign_id, recommendation_id, what, action_type, human_involved, result, occurred_at)
       VALUES ($1,$2,'paused the weak creative','pause_creative', true, 'success', '2026-08-10T14:30:00Z')`,
      [campaignId, recId],
    );

    const { before, after } = measurementWindows(EXECUTED_AT, 7);
    const confound = await detectConfounds(pool, { campaignId, recommendationId: recId, before, after, afterDaily: [] });
    expect(confound).toBeNull(); // its own execution is the thing being measured, not a confound
  });

  it("a zero-spend day in the after-window is a delivery-interruption confound", async () => {
    const { campaignId } = await seedCampaign("zerospend");
    const recId = await seedRec(campaignId);
    const { before, after } = measurementWindows(EXECUTED_AT, 7);
    const confound = await detectConfounds(pool, {
      campaignId,
      recommendationId: recId,
      before,
      after,
      afterDaily: [
        { date: "2026-08-11", spendAgorot: 3000 },
        { date: "2026-08-12", spendAgorot: 0 },
      ],
    });
    expect(confound!.zeroSpendDays).toEqual(["2026-08-12"]);
  });

  it("replace_creative is recorded as not_measurable — no Meta write happened", async () => {
    const { campaignId } = await seedCampaign("replace");
    const recId = await seedRec(campaignId, { type: "replace_creative" });
    await seedDays(campaignId, [
      ...range("2026-08-03", 7).map((date) => ({ date, spendAgorot: 4000, leads: 1 })),
      ...range("2026-08-11", 7).map((date) => ({ date, spendAgorot: 2000, leads: 1 })), // would be a big "improvement"
    ]);

    const verdict = await measureOne({
      pool,
      snapshotStore: new PgSnapshotStore(pool),
      due: { recommendationId: recId, campaignId, type: "replace_creative", executedAt: EXECUTED_AT, cooldownDays: 7 },
    });
    expect(verdict).toBe("not_measurable");
  });

  it("runOutcomeTick measures everything due, and a second tick is a no-op (measured once)", async () => {
    const { campaignId } = await seedCampaign("tick");
    const recId = await seedRec(campaignId);
    await seedDays(campaignId, [
      ...range("2026-08-03", 7).map((date) => ({ date, spendAgorot: 4000, leads: 1 })),
      ...range("2026-08-11", 7).map((date) => ({ date, spendAgorot: 3000, leads: 1 })),
    ]);
    const snapshotStore = new PgSnapshotStore(pool);

    const first = await runOutcomeTick({ pool, snapshotStore, now: NOW });
    expect(first.measured).toBeGreaterThanOrEqual(1);
    expect(first.failed).toBe(0);

    const countAfterFirst = await pool.query(`SELECT count(*)::int n FROM recommendation_outcomes WHERE recommendation_id = $1`, [recId]);
    expect(countAfterFirst.rows[0].n).toBe(1);

    const second = await runOutcomeTick({ pool, snapshotStore, now: NOW });
    expect(second.due).toBe(0); // already measured — never re-scored with revised attribution
    const countAfterSecond = await pool.query(`SELECT count(*)::int n FROM recommendation_outcomes WHERE recommendation_id = $1`, [recId]);
    expect(countAfterSecond.rows[0].n).toBe(1);
  });
});
