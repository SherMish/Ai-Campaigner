// DB + HTTP integration for the customer overview (AIC-22/24). Requires
// DATABASE_URL with migrations applied; self-skips otherwise. Seeds a full
// account→customer→connection→campaign chain and asserts the service output,
// the JWT-scoped /api/app/overview endpoint, and the lead-quality write.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { buildCustomerOverview } from "./customer-overview.js";
import { recordNoRecReason } from "./evaluation-reason.js";
import { recordLiveBudget } from "./live-budget.js";
import { signAuthToken } from "../auth/tokens.js";
import { rollingPeriods } from "../meta/scheduled-ingestion.js";
import { PgSnapshotStore } from "../meta/snapshot-store.js";
import type { SnapshotUpsert } from "../meta/insights.js";
import type { RecommendationDraft } from "../recommendations/types.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

const { current, previous } = rollingPeriods();

function snap(campaignId: string, o: Partial<SnapshotUpsert>): SnapshotUpsert {
  return {
    campaignId, grain: "campaign", metaObjectId: "meta_camp_ov", parentMetaId: null,
    // A single DAY inside the current window — campaign totals are summed, and
    // summing must only see disjoint rows (migration 030). Creative-grain rows
    // still match creativeStats' containment predicate.
    creativeName: null, periodStart: current.start, periodEnd: current.start,
    spendAgorot: 0, leads: 0, cplAgorot: null, impressions: 0, linkClicks: 0,
    deliveryStatus: "active", raw: {}, ...o,
  };
}

// Seed a user + linked customer with a managed campaign. Returns ids.
async function seedChain(tag: string, status = "active") {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test, onboarding_status, contact_name)
     VALUES ($1, true, 'ready', 'Test Owner') RETURNING id`,
    [`__it_ov_${tag}`],
  );
  const customerId = cust.rows[0].id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO app_users (email, password_hash, name, customer_id)
     VALUES ($1, 'x', 'Owner Name', $2) RETURNING id`,
    [`__it_ov_${tag}@example.com`, customerId],
  );
  const userId = user.rows[0].id;
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, system_user_id, access_health, page_id)
     VALUES ($1, '999', 'ok', 'page_it_1') RETURNING id`,
    [customerId],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id, name)
     VALUES ($1, $2, 'IT Ad Account') RETURNING id`,
    [conn.rows[0].id, `act_ov_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    // AIC-158: meta_campaign_id was ABSENT here, so every homeState assertion
    // in this file was made against a campaign that does not exist on Meta —
    // the fixture was defending the bug. A real managed campaign always has
    // one; the tests that care about its absence set it back to NULL
    // explicitly.
    // …and launch_approved_at, for the same reason: a linked, active campaign
    // with no approval is `ready_to_launch`, which would now outrank every
    // state these tests are actually about. The launch flow has its own tests
    // further down, which set both columns explicitly.
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, name, status, agreed_budget_agorot, budget_period, meta_campaign_id, launch_approved_at)
     VALUES ($1, $2, 'IT Campaign', $3, 800, 'daily', $4, now()) RETURNING id`,
    [customerId, acct.rows[0].id, status, `meta_camp_ov_${tag}`],
  );
  return { customerId, userId, campaignId: camp.rows[0].id };
}

d("customer overview (DB + HTTP)", () => {
  beforeAll(() => {
    process.env.JWT_SECRET ||= "test-secret-overview-padding-to-32-chars-minimum";
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM app_users WHERE email LIKE '__it_ov_%'`);
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_ov_%'`);
    await pool.end();
  });

  it("assembles the full chain and derives 'ok' when data exists", async () => {
    const { userId, campaignId } = await seedChain("full");
    const store = new PgSnapshotStore(pool);
    await store.upsert([
      snap(campaignId, { spendAgorot: 18000, leads: 6, cplAgorot: 3000 }),
      snap(campaignId, { grain: "creative", metaObjectId: "cr_ov_1", creativeName: "A", spendAgorot: 18000, leads: 6, cplAgorot: 3000 }),
      snap(campaignId, { periodStart: previous.start, periodEnd: previous.start, spendAgorot: 15000, leads: 5, cplAgorot: 3000 }),
    ]);

    const ov = await buildCustomerOverview(pool, userId);
    expect(ov).not.toBeNull();
    expect(ov!.account.email).toBe("__it_ov_full@example.com");
    expect(ov!.customer?.businessName).toBe("__it_ov_full");
    expect(ov!.connection?.adAccount?.name).toBe("IT Ad Account");
    expect(ov!.connection?.accessHealth).toBe("ok");
    expect(ov!.campaign?.agreedBudgetAgorot).toBe(800);
    expect(ov!.readout?.current.leads).toBe(6);
    expect(ov!.readout?.delta.leadsPct).toBe(20);
    expect(ov!.homeState).toBe("ok");

    // Over HTTP, scoped by the caller's JWT.
    const token = signAuthToken(userId);
    const res = await request(createApp())
      .get("/api/app/overview")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.campaign.name).toBe("IT Campaign");
    expect(res.body.homeState).toBe("ok");
  });

  it("derives 'collecting' when the campaign has no snapshots", async () => {
    const { userId } = await seedChain("empty");
    const ov = await buildCustomerOverview(pool, userId);
    expect(ov!.homeState).toBe("collecting");
    expect(ov!.readout?.current.leads).toBe(0);
  });

  // AIC-158, found live on a real customer. The wizard's connect-only branch
  // writes a SHELL campaign — budget and nothing else — and hands off to the
  // builder. That customer never finished it, so `meta_campaign_id` was NULL:
  // no campaign exists on Meta at all. The dashboard said "הקמפיין פעיל
  // ואנחנו ממשיכים לעקוב" with the badge "אוספים נתונים", ₪15/day and
  // "פניות 0" — which reads as "your ads are running and nobody is calling".
  //
  // Every branch below the top of deriveHomeState was reasoning about an
  // object that did not exist. add-content had it right the whole time
  // (classifyConnectionReadiness → not_launched); Home just never asked.
  it("says the campaign was never built when there is no meta_campaign_id — AIC-158", async () => {
    const { userId } = await seedChain("unbuilt");
    await pool.query(
      `UPDATE managed_campaigns SET meta_campaign_id = NULL WHERE customer_id = (SELECT customer_id FROM app_users WHERE id = $1)`,
      [userId],
    );
    const ov = await buildCustomerOverview(pool, userId);
    expect(ov!.homeState).toBe("unbuilt");
    expect(ov!.campaign?.metaCampaignId).toBeNull();
  });

  it("a lost connection still outranks the unbuilt state — you cannot finish a build without one", async () => {
    const { userId, customerId } = await seedChain("unbuiltconn");
    await pool.query(`UPDATE managed_campaigns SET meta_campaign_id = NULL WHERE customer_id = $1`, [customerId]);
    await pool.query(`UPDATE meta_connections SET access_health = 'revoked' WHERE customer_id = $1`, [customerId]);
    const ov = await buildCustomerOverview(pool, userId);
    expect(ov!.homeState).toBe("attention");
  });

  it("surfaces a delivery problem as attention (kind = delivery) — AIC-39", async () => {
    const { userId, campaignId } = await seedChain("delivery");
    await pool.query(`UPDATE managed_campaigns SET delivery_ok = false, delivery_reason = 'not delivering' WHERE id = $1`, [campaignId]);
    const ov = await buildCustomerOverview(pool, userId);
    expect(ov!.homeState).toBe("attention");
    expect(ov!.attentionKind).toBe("delivery");
    expect(ov!.campaign?.deliveryOk).toBe(false);
  });

  // AIC-71: real GelNails case — customer paused their only ad set (AIC-66),
  // nothing is broken (delivery_ok stays true, no ops item), but nothing is
  // delivering either. `stopped` must outrank `collecting`: this campaign will
  // never accumulate data no matter how long we wait, so "still collecting" is
  // actively misleading here.
  it("surfaces 'stopped' when nothing is broken but nothing is delivering — even with no snapshot data", async () => {
    const { userId, campaignId } = await seedChain("stopped");
    await pool.query(`UPDATE managed_campaigns SET delivering = false, delivering_ad_count = 0 WHERE id = $1`, [campaignId]);
    const ov = await buildCustomerOverview(pool, userId);
    expect(ov!.homeState).toBe("stopped");
    expect(ov!.campaign?.delivering).toBe(false);
    expect(ov!.campaign?.deliveringAdCount).toBe(0);
    expect(ov!.attentionKind).toBeNull(); // not a delivery PROBLEM (AIC-39) — deliberate, not broken
  });

  it("defaults delivering=true before the engine's first tick, so a brand-new campaign still reads 'collecting'", async () => {
    const { userId } = await seedChain("predefault");
    const ov = await buildCustomerOverview(pool, userId);
    expect(ov!.campaign?.delivering).toBe(true);
    expect(ov!.campaign?.deliveringAdCount).toBeNull();
    expect(ov!.homeState).toBe("collecting");
  });

  it("surfaces the engine's no-rec reason (AIC-64)", async () => {
    const { userId, campaignId } = await seedChain("norec");
    const draft: RecommendationDraft = {
      campaignId, type: "no_action", targetMetaId: null,
      evidence: { reason: "budget_below_threshold", detail: { currentBudgetAgorot: 1000, maxWindowSpendAgorot: 7000, requiredSpendAgorot: 15000 } },
      currentBudgetAgorot: null, proposedBudgetAgorot: null, maxSpendImpactAgorot: null, rationale: "test",
    };
    await recordNoRecReason({ pool, campaignId, draft });

    const ov = await buildCustomerOverview(pool, userId);
    expect(ov!.campaign?.noRecReason).toBe("budget_below_threshold");
    expect(ov!.campaign?.noRecDetail).toMatchObject({ maxWindowSpendAgorot: 7000 });

    // An acting draft clears it back to null — nothing to explain once a
    // recommendation exists.
    await recordNoRecReason({
      pool, campaignId,
      draft: { campaignId, type: "decrease_budget", targetMetaId: null, evidence: {}, currentBudgetAgorot: 1000, proposedBudgetAgorot: 800, maxSpendImpactAgorot: -200, rationale: "test" },
    });
    const ov2 = await buildCustomerOverview(pool, userId);
    expect(ov2!.campaign?.noRecReason).toBeNull();
  });

  // REGRESSION (real, found 2026-08-14 live): the ready_to_launch hero claims
  // "we built the campaign and it passed review". `readyToLaunch` was derived
  // purely from status/launch_approved_at/meta_campaign_id, with nothing
  // distinguishing a builder-built campaign from one connected from outside
  // the app — so a real connected Pixel campaign got told it was built here,
  // which is false on both counts (nobody built it, nothing went through
  // campaign_reviews). `wasBuiltHere` is derived from a REAL create_campaign
  // action_history row rather than a separately-set flag, so it can't drift.
  // AIC-164, found the first time an adoption ever succeeded through the
  // wizard. The customer's Home opened with "מצאנו את הקמפיין שלכם ב-Meta, אבל
  // הוא עדיין מושהה ולא מוציא כסף" about a campaign Meta reported as ACTIVE at
  // ₪30/day — and its button would have called activateCampaign on it.
  it("an ADOPTED campaign is never ready_to_launch, however its columns look", async () => {
    const { userId, campaignId } = await seedChain("adopted");
    // The exact shape provisioning used to leave: linked, active, never
    // launch-approved, and nothing in action_history that built it.
    await pool.query(
      `UPDATE managed_campaigns SET meta_campaign_id = 'meta_camp_adopted', launch_approved_at = NULL WHERE id = $1`,
      [campaignId],
    );
    const ov = await buildCustomerOverview(pool, userId);

    expect(ov!.campaign?.wasBuiltHere).toBe(false);
    expect(ov!.campaign?.readyToLaunch).toBe(false);
    // Its real state comes from the machinery built for it, not the launch gate.
    expect(ov!.homeState).toBe("collecting");
  });

  // REWRITTEN by AIC-164. This asserted `readyToLaunch: true` and
  // `homeState: "ready_to_launch"` for a campaign nothing built here — which
  // was the behaviour AIC-89 found and fixed the COPY for, without questioning
  // the state itself. AIC-164 removed the state: the launch gate exists so a
  // customer approves before OUR build first spends, and a campaign that was
  // already running when we adopted it has no such moment. Leaving the old
  // assertion would have been a passing test defending the very claim
  // ("עדיין מושהה ולא מוציא כסף") that turned out to be false on a live
  // campaign spending ₪30 a day.
  //
  // What the test is actually FOR survives untouched: was_built_here is
  // derived from real action_history, so a campaign we did not build reports
  // false.
  it("wasBuiltHere is false for a campaign with no create_campaign action_history row (AIC-89)", async () => {
    const { userId, campaignId } = await seedChain("connected");
    await pool.query(
      `UPDATE managed_campaigns SET meta_campaign_id = 'meta_camp_connected', launch_approved_at = NULL WHERE id = $1`,
      [campaignId],
    );

    const ov = await buildCustomerOverview(pool, userId);
    expect(ov!.campaign?.wasBuiltHere).toBe(false);
    // …and therefore NOT awaiting a launch we never held it back from.
    expect(ov!.campaign?.readyToLaunch).toBe(false);
    expect(ov!.homeState).not.toBe("ready_to_launch");
  });

  it("wasBuiltHere is true once a real, successful create_campaign action_history row exists", async () => {
    const { userId, campaignId } = await seedChain("builtHere");
    await pool.query(
      `UPDATE managed_campaigns SET meta_campaign_id = 'meta_camp_built', launch_approved_at = NULL WHERE id = $1`,
      [campaignId],
    );
    await pool.query(
      `INSERT INTO action_history (campaign_id, what, action_type, previous_state, new_state, human_involved, result)
       VALUES ($1, 'created campaign', 'create_campaign', '{}'::jsonb, '{}'::jsonb, true, 'success')`,
      [campaignId],
    );

    const ov = await buildCustomerOverview(pool, userId);
    expect(ov!.campaign?.wasBuiltHere).toBe(true);
  });

  it("a FAILED create_campaign attempt does not count as wasBuiltHere", async () => {
    const { userId, campaignId } = await seedChain("failedbuild");
    await pool.query(
      `UPDATE managed_campaigns SET meta_campaign_id = 'meta_camp_failed', launch_approved_at = NULL WHERE id = $1`,
      [campaignId],
    );
    await pool.query(
      `INSERT INTO action_history (campaign_id, what, action_type, previous_state, new_state, human_involved, result)
       VALUES ($1, 'attempted create', 'create_campaign', '{}'::jsonb, '{}'::jsonb, true, 'failed')`,
      [campaignId],
    );

    const ov = await buildCustomerOverview(pool, userId);
    expect(ov!.campaign?.wasBuiltHere).toBe(false);
  });

  // REGRESSION (real, found 2026-08-14 live): the dashboard's "recommendation
  // waiting" teaser rendered a hardcoded headline ("worth pausing one of the
  // ads") regardless of what the actual pending recommendation was — because
  // pendingRecommendations was only ever a bare count, never the type. Once
  // AIC-86 introduced a genuinely different pending type, the teaser
  // confidently stated the wrong thing. The customer clicked through to find
  // "add more ads" behind a headline that said "pause an ad".
  it("surfaces the pending recommendation's TYPE, not just a count (AIC-86 dashboard mismatch)", async () => {
    const { userId, campaignId } = await seedChain("pendingtype");
    let ov = await buildCustomerOverview(pool, userId);
    expect(ov!.pendingRecommendations).toBe(0);
    expect(ov!.pendingRecommendationType).toBeNull();

    await pool.query(
      `INSERT INTO recommendations (campaign_id, type, state, rationale)
       VALUES ($1, 'add_creatives_for_comparison', 'proposed', 'test')`,
      [campaignId],
    );
    ov = await buildCustomerOverview(pool, userId);
    expect(ov!.pendingRecommendations).toBe(1);
    expect(ov!.pendingRecommendationType).toBe("add_creatives_for_comparison");
  });

  it("surfaces the live-synced budget, not the static agreed ceiling (real bug fix)", async () => {
    const { userId, campaignId } = await seedChain("livebudget");
    // seedChain sets agreed_budget_agorot=800; before any engine tick, null.
    let ov = await buildCustomerOverview(pool, userId);
    expect(ov!.campaign?.liveBudgetAgorot).toBeNull();

    await recordLiveBudget({ pool, campaignId, liveBudgetAgorot: 3000 });
    ov = await buildCustomerOverview(pool, userId);
    expect(ov!.campaign?.liveBudgetAgorot).toBe(3000);
  });

  it("rejects the overview without a token", async () => {
    const res = await request(createApp()).get("/api/app/overview");
    expect(res.status).toBe(401);
  });

  // AIC-67: incremental delta review — the customer is only ever asked about
  // leads NEW since their last review, never a cumulative total they have to
  // do their own mental math against. This is the real bug pin: answering
  // twice as more leads arrive must never re-count the ones already rated.
  // leads_to_date is set directly here, NOT via snapshot upserts — it's a
  // cached column (generation.ts's tick), never derived from summing
  // insight_snapshots (see the regression test below for exactly why).
  it("lead quality: only asks about the delta, watermark advances, double-counting is impossible", async () => {
    const { userId, campaignId } = await seedChain("lq");
    const token = signAuthToken(userId);

    // No leads yet.
    let ov = await request(createApp()).get("/api/app/overview").set("Authorization", `Bearer ${token}`);
    expect(ov.body.leadQuality).toMatchObject({ pending: 0, reviewedSoFar: 0, relevantSoFar: 0 });

    // 5 leads to date → 5 pending.
    await pool.query(`UPDATE managed_campaigns SET leads_to_date = 5 WHERE id = $1`, [campaignId]);
    ov = await request(createApp()).get("/api/app/overview").set("Authorization", `Bearer ${token}`);
    expect(ov.body.leadQuality).toMatchObject({ pending: 5, reviewedSoFar: 0 });

    // Answer 3 of 5 relevant — watermark advances, nothing left pending.
    const first = await request(createApp())
      .post("/api/app/lead-quality")
      .set("Authorization", `Bearer ${token}`)
      .send({ relevant: 3 });
    expect(first.status).toBe(200);
    expect(first.body.leadQuality).toMatchObject({ pending: 0, reviewedSoFar: 5, relevantSoFar: 3 });

    // 2 more leads arrive (7 to date) — the prompt must ask about ONLY the
    // new 2, never re-surface the first 5 that were already rated.
    await pool.query(`UPDATE managed_campaigns SET leads_to_date = 7 WHERE id = $1`, [campaignId]);
    ov = await request(createApp()).get("/api/app/overview").set("Authorization", `Bearer ${token}`);
    expect(ov.body.leadQuality.pending).toBe(2);

    const second = await request(createApp())
      .post("/api/app/lead-quality")
      .set("Authorization", `Bearer ${token}`)
      .send({ relevant: 1 });
    expect(second.status).toBe(200);
    // Cumulative, not overwritten: 3 (first batch) + 1 (second batch) = 4.
    expect(second.body.leadQuality).toMatchObject({ pending: 0, reviewedSoFar: 7, relevantSoFar: 4 });

    // relevant > pending is nonsense → 400, and nothing is recorded.
    await pool.query(`UPDATE managed_campaigns SET leads_to_date = 8 WHERE id = $1`, [campaignId]); // 1 pending
    const bad = await request(createApp())
      .post("/api/app/lead-quality")
      .set("Authorization", `Bearer ${token}`)
      .send({ relevant: 9 });
    expect(bad.status).toBe(400);

    // Nothing pending → posting anyway is rejected, not silently accepted.
    const okOne = await request(createApp())
      .post("/api/app/lead-quality")
      .set("Authorization", `Bearer ${token}`)
      .send({ relevant: 1 });
    expect(okOne.status).toBe(200);
    const nothingToReview = await request(createApp())
      .post("/api/app/lead-quality")
      .set("Authorization", `Bearer ${token}`)
      .send({ relevant: 0 });
    expect(nothingToReview.status).toBe(400);
  });

  // REGRESSION (real bug, found live the same day AIC-67 shipped): a customer
  // saw "1 פניות" on the main KPI but "3 לדירוג" on the lead-quality card for
  // the SAME campaign with only 1 real lead. Root cause: the ingestion tick
  // writes a NEW overlapping rolling-7-day snapshot row every day (shifted by
  // one day each time), so summing `leads` across insight_snapshots counted
  // the same real lead once per overlapping row (3 daily ticks → "3"). Pins
  // that leadQuality.pending reads the cached leads_to_date column, and is
  // completely unaffected by however many overlapping snapshot rows exist.
  it("overlapping rolling-window snapshots never inflate leadQuality (the real 1-lead-read-as-3 bug)", async () => {
    const { userId, campaignId } = await seedChain("overlap");
    const token = signAuthToken(userId);
    const store = new PgSnapshotStore(pool);

    // Same real shape: 3 daily ticks, each writing an overlapping 7-day
    // window that (over)laps the same single real lead.
    await store.upsert([snap(campaignId, { periodStart: "2026-08-02", periodEnd: "2026-08-08", spendAgorot: 369, leads: 1 })]);
    await store.upsert([snap(campaignId, { periodStart: "2026-08-03", periodEnd: "2026-08-09", spendAgorot: 369, leads: 1 })]);
    await store.upsert([snap(campaignId, { periodStart: "2026-08-04", periodEnd: "2026-08-10", spendAgorot: 1182, leads: 1 })]);

    // The engine tick would have cached the TRUE lifetime total (1) here —
    // simulate that directly, since this test isn't exercising the Meta read.
    await pool.query(`UPDATE managed_campaigns SET leads_to_date = 1 WHERE id = $1`, [campaignId]);

    const ov = await request(createApp()).get("/api/app/overview").set("Authorization", `Bearer ${token}`);
    // NOT 3 — the bug would have summed the three overlapping snapshot rows.
    expect(ov.body.leadQuality.pending).toBe(1);
  });

  it("401 without a token", async () => {
    const res = await request(createApp()).post("/api/app/lead-quality").send({ relevant: 1 });
    expect(res.status).toBe(401);
  });
});
