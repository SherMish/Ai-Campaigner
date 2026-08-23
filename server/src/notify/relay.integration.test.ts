// DB integration for the ops notification relay (AIC-118).
// Requires DATABASE_URL; self-skips otherwise.
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import { pool } from "../db/pool.js";
import { buildNotificationRelay } from "./relay.js";
import { __resetTelegramThrottle } from "./telegram.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;
const PREFIX = "__it_notify_";

let sent: string[] = [];

beforeEach(() => {
  __resetTelegramThrottle();
  sent = [];
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_CHAT_ID = "-100123";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body).text);
      return { ok: true };
    }),
  );
});

afterEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  vi.unstubAllGlobals();
});

async function seed(tag: string): Promise<{ campaignId: string; customerId: string }> {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test) VALUES ($1, true) RETURNING id`,
    [`${PREFIX}${tag}`],
  );
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, access_health) VALUES ($1,'ok') RETURNING id`,
    [customerId],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_ntf_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, meta_campaign_id, name, status)
     VALUES ($1,$2,'m_ntf','Test Campaign','active') RETURNING id`,
    [customerId, acct.rows[0].id],
  );
  return { campaignId: camp.rows[0].id, customerId };
}

// The relay is GLOBAL by design — it claims every unnotified row, which is the
// whole point. So these tests must never assert on absolute counts: other
// integration files run concurrently against the same database and write their
// own action_history rows. Asserting `sent === 1` failed exactly that way (it
// saw 20). Every assertion below is scoped to this file's own rows.
function relayForTest() {
  return buildNotificationRelay(pool, undefined, { includeTestCustomers: true })!;
}

// The relay is bounded per pass (BATCH rows, and the transport caps sends per
// minute) — deliberately, so one busy period can't become one enormous burst.
// In production it simply runs again a minute later. A test that calls it once
// and asserts its row was sent is therefore asserting something the relay never
// promised: with other files writing rows concurrently, this file's row can sit
// behind a full batch of older ones. Drain the way production does instead.
async function drain(relay: () => Promise<{ claimed: number }>): Promise<void> {
  for (let i = 0; i < 20; i++) {
    __resetTelegramThrottle(); // each pass is a fresh "minute"
    if ((await relay()).claimed === 0) return;
  }
}

function mine(tag: string): string[] {
  return sent.filter((t) => t.includes(`${PREFIX}${tag}`));
}

async function addAction(
  campaignId: string,
  over: { actionType?: string; result?: string; occurredAt?: string; approvedBy?: string; humanInvolved?: boolean } = {},
) {
  await pool.query(
    `INSERT INTO action_history
       (campaign_id, what, action_type, target_meta_id, previous_state, new_state,
        why, approved_by, human_involved, result, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11::timestamptz, now()))`,
    [
      campaignId, "מודעה ad_1", over.actionType ?? "pause_ad", "ad_1",
      JSON.stringify({ status: "ACTIVE" }), JSON.stringify({ status: "PAUSED" }),
      "שינוי ידני על ידי הלקוח", over.approvedBy ?? "customer",
      over.humanInvolved ?? true, over.result ?? "success", over.occurredAt ?? null,
    ],
  );
}

d("ops notification relay (DB)", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '${PREFIX}%'`);
    await pool.end();
  });

  it("sends a new action once, and never again", async () => {
    const { campaignId } = await seed("once");
    await addAction(campaignId);

    const relay = relayForTest();
    await drain(relay);
    expect(mine("once")).toHaveLength(1);
    expect(mine("once")[0]).toContain("Test Campaign");
    expect(mine("once")[0]).toContain("השהיית מודעה");

    // The whole point of marking rows rather than keeping a timestamp
    // watermark: a second pass must not resend this row.
    sent = [];
    await drain(relay);
    expect(mine("once")).toHaveLength(0);

    const { rows } = await pool.query(
      `SELECT notified_at FROM action_history WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(rows.every((r) => r.notified_at !== null)).toBe(true);
  });

  it("covers action types the CUSTOMER's feed deliberately hides", async () => {
    const { campaignId } = await seed("rollback");
    await addAction(campaignId, { actionType: "rollback_build", humanInvolved: false, approvedBy: undefined });

    await drain(relayForTest());
    expect(mine("rollback")).toHaveLength(1);
    // Not the raw key — condense() filters this row out of the customer feed,
    // so it has no SUMMARY_HE entry and needs its own ops label.
    expect(mine("rollback")[0]).not.toContain("rollback_build");
    expect(mine("rollback")[0]).toContain("rollback");
  });

  it("reports a failed action as a failure", async () => {
    const { campaignId } = await seed("failed");
    await addAction(campaignId, { result: "failed" });
    await drain(relayForTest());
    expect(mine("failed")).toHaveLength(1);
    expect(mine("failed")[0]).toContain("FAILED");
  });

  // The cutover guard. Without it, configuring the channel replays every row
  // ever written into it, and the channel is muted within the hour.
  it("claims but does not send anything older than the max age", async () => {
    const { campaignId } = await seed("old");
    await addAction(campaignId, { occurredAt: "2026-01-01T00:00:00Z" });

    const relay = buildNotificationRelay(pool, undefined, {
      maxAgeMs: 60 * 60 * 1000,
      includeTestCustomers: true,
    })!;
    await drain(relay);
    expect(mine("old")).toHaveLength(0);

    // ...and it is still marked, so it can never come back later.
    const { rows } = await pool.query(
      `SELECT notified_at FROM action_history WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(rows[0].notified_at).not.toBeNull();
    sent = [];
    await drain(relay);
    expect(mine("old")).toHaveLength(0);
  });

  it("relays ops-queue items with their severity", async () => {
    const { campaignId, customerId } = await seed("ops");
    await pool.query(
      `INSERT INTO ops_queue_items (customer_id, campaign_id, type, severity, detail)
       VALUES ($1,$2,'campaign_not_delivering','high','no ad set is delivering')`,
      [customerId, campaignId],
    );
    await drain(relayForTest());
    expect(mine("ops")).toHaveLength(1);
    expect(mine("ops")[0]).toContain("Campaign not delivering");
    expect(mine("ops")[0]).toContain("high");
  });

  // The guard that made the tests above deterministic, and that stops a local
  // `vitest run` from posting fixture rows into the live ops channel — local
  // dev and production share one database.
  it("claims but never sends a test account's rows by default", async () => {
    const { campaignId } = await seed("istest");
    await addAction(campaignId);

    const defaultRelay = buildNotificationRelay(pool)!; // no includeTestCustomers
    await drain(defaultRelay);
    expect(mine("istest")).toHaveLength(0);

    // Claimed, not left to pile up — the partial index stays small and the row
    // can't resurface if the guard is ever relaxed.
    const { rows } = await pool.query(
      `SELECT notified_at FROM action_history WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(rows[0].notified_at).not.toBeNull();
  });

  // Building a relay that claims rows it cannot deliver would silently burn
  // every event between deploy and the moment the token is set.
  it("does not exist at all when Telegram is unconfigured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(buildNotificationRelay(pool)).toBeNull();
  });
});
