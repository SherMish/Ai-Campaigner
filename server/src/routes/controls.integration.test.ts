// DB + HTTP integration for manual object controls (AIC-66), both surfaces:
// the customer's self-authorized pause/resume and the operator's console
// controls incl. the destructive, confirm-to-type archive/delete.
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { signAuthToken } from "../auth/tokens.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;
const ADMIN = "Bearer test-admin";
const app = createApp();

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

// Models the campaign's live tree + per-object status reads/writes.
function mockMeta(ads: string[], adSets: string[]) {
  const statuses = new Map<string, string>([...ads, ...adSets].map((id) => [id, "ACTIVE"]));
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if ((init?.method ?? "GET") === "GET") {
      // getCampaignState — campaign + its ad sets + its ads
      if (u.includes("/adsets?")) {
        // AIC-70: getCampaignState reads `status` (intent), not the lagging
        // `effective_status` — both included here since real Meta returns both.
        return jsonRes({ data: adSets.map((id) => ({ id, status: statuses.get(id), effective_status: statuses.get(id) })) });
      }
      if (u.includes("/ads?")) {
        // adset_id defaults to the (single) seeded ad set — every test in
        // this file uses exactly one, matching the real campaign shape.
        return jsonRes({ data: ads.map((id) => ({ id, adset_id: adSets[0], status: statuses.get(id), effective_status: statuses.get(id) })) });
      }
      if (u.includes("fields=status")) {
        const id = u.split("/").pop()!.split("?")[0];
        const st = statuses.get(id) ?? "ACTIVE";
        return jsonRes({ status: st, effective_status: st });
      }
      // the campaign object itself (budget probe)
      return jsonRes({ id: "meta_camp_ctl", daily_budget: "3000", effective_status: "ACTIVE" });
    }
    // POST = a status write to an object id
    const id = u.split("/").pop()!;
    const body = String(init?.body ?? "");
    const m = /status=([A-Z]+)/.exec(body);
    if (m) statuses.set(id, m[1]);
    return jsonRes({ success: true });
  });
  return { fetchMock, statuses };
}

async function seed(tag: string) {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test, onboarding_status) VALUES ($1, true, 'ready') RETURNING id`,
    [`__it_ctlr_${tag}`],
  );
  const customerId = cust.rows[0].id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO app_users (email, password_hash, name, customer_id) VALUES ($1,'x','Owner',$2) RETURNING id`,
    [`__it_ctlr_${tag}@example.com`, customerId],
  );
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, access_health, page_id) VALUES ($1,'ok','page_1') RETURNING id`,
    [customerId],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_ctlr_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, status, meta_campaign_id, name)
     VALUES ($1,$2,'active','meta_camp_ctl','IT Campaign') RETURNING id`,
    [customerId, acct.rows[0].id],
  );
  return { customerId, campaignId: camp.rows[0].id, token: signAuthToken(user.rows[0].id) };
}

async function historyTypes(campaignId: string): Promise<string[]> {
  const { rows } = await pool.query<{ action_type: string }>(
    `SELECT action_type FROM action_history WHERE campaign_id = $1 ORDER BY occurred_at ASC`,
    [campaignId],
  );
  return rows.map((r) => r.action_type);
}

// entity_id is our campaign UUID (the column is UUID-typed); the Meta object id
// rides in entity_label — so audit lookups are by campaign + object id.
async function auditFor(campaignId: string, metaObjectId: string) {
  const { rows } = await pool.query(
    `SELECT action, entity_type, entity_label, actor_label FROM admin_audit_log
     WHERE entity_id = $1 AND entity_label LIKE '%' || $2`,
    [campaignId, metaObjectId],
  );
  return rows;
}

d("manual controls routes (AIC-66)", () => {
  beforeAll(() => {
    process.env.JWT_SECRET ||= "test-secret-controls";
    process.env.ADMIN_TOKEN = "test-admin";
    process.env.META_SYSTEM_USER_TOKEN ||= "test-meta-token";
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM app_users WHERE email LIKE '__it_ctlr_%'`);
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_ctlr_%'`);
    await pool.end();
  });

  it("requires auth on every customer control route", async () => {
    expect((await request(app).get("/api/app/controls/state")).status).toBe(401);
    expect((await request(app).post("/api/app/controls/pause").send({ kind: "ad", metaObjectId: "x" })).status).toBe(401);
    expect((await request(app).post("/api/app/controls/resume").send({ kind: "ad", metaObjectId: "x" })).status).toBe(401);
  });

  it("customer pauses their own ad — self-authorized, no approval gate, logged", async () => {
    const { token, campaignId } = await seed("selfpause");
    const { fetchMock, statuses } = mockMeta(["ad_1"], ["as_1"]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(app).post("/api/app/controls/pause")
      .set("Authorization", `Bearer ${token}`)
      .send({ kind: "ad", metaObjectId: "ad_1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outcome: "changed", status: "PAUSED" });
    expect(statuses.get("ad_1")).toBe("PAUSED");
    expect(await historyTypes(campaignId)).toEqual(["pause_ad"]);
  });

  it("customer resumes their own ad set", async () => {
    const { token, campaignId } = await seed("selfresume");
    const { fetchMock, statuses } = mockMeta(["ad_1"], ["as_1"]);
    statuses.set("as_1", "PAUSED");
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(app).post("/api/app/controls/resume")
      .set("Authorization", `Bearer ${token}`)
      .send({ kind: "ad_set", metaObjectId: "as_1" });

    expect(res.status).toBe(200);
    expect(statuses.get("as_1")).toBe("ACTIVE");
    expect(await historyTypes(campaignId)).toEqual(["resume_ad_set"]);
  });

  // REGRESSION (live incident 2026-08-12, same day as AIC-71 shipped): a
  // customer paused their only ad set and Home still read "פעיל" — `delivering`
  // was only ever recomputed on the hourly engine tick, so a customer's own
  // manual pause left the headline stale for up to an hour. The pause/resume
  // routes must recompute+persist `delivering` synchronously, not wait for the
  // next tick.
  it("a customer's own pause updates managed_campaigns.delivering immediately, not on the next engine tick", async () => {
    const { token, campaignId } = await seed("livedeliv");
    const { fetchMock } = mockMeta(["ad_1"], ["as_1"]);
    vi.stubGlobal("fetch", fetchMock);

    const before = await pool.query(`SELECT delivering, delivering_ad_count FROM managed_campaigns WHERE id = $1`, [campaignId]);
    expect(before.rows[0]).toMatchObject({ delivering: true }); // migration default, pre-tick

    const res = await request(app).post("/api/app/controls/pause")
      .set("Authorization", `Bearer ${token}`)
      .send({ kind: "ad_set", metaObjectId: "as_1" });
    expect(res.status).toBe(200);

    const after = await pool.query(`SELECT delivering, delivering_ad_count FROM managed_campaigns WHERE id = $1`, [campaignId]);
    expect(after.rows[0]).toMatchObject({ delivering: false, delivering_ad_count: 0 });
  });

  it("a customer's own resume updates managed_campaigns.delivering immediately", async () => {
    const { token, campaignId } = await seed("livedeliv2");
    const { fetchMock, statuses } = mockMeta(["ad_1"], ["as_1"]);
    statuses.set("as_1", "PAUSED");
    vi.stubGlobal("fetch", fetchMock);
    await pool.query(`UPDATE managed_campaigns SET delivering = false, delivering_ad_count = 0 WHERE id = $1`, [campaignId]);

    const res = await request(app).post("/api/app/controls/resume")
      .set("Authorization", `Bearer ${token}`)
      .send({ kind: "ad_set", metaObjectId: "as_1" });
    expect(res.status).toBe(200);

    const after = await pool.query(`SELECT delivering, delivering_ad_count FROM managed_campaigns WHERE id = $1`, [campaignId]);
    expect(after.rows[0]).toMatchObject({ delivering: true, delivering_ad_count: 1 });
  });

  it("an operator's pause updates managed_campaigns.delivering immediately too", async () => {
    const { campaignId } = await seed("livedelivop");
    const { fetchMock } = mockMeta(["ad_1"], ["as_1"]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(app).post(`/api/admin/campaigns/${campaignId}/objects/pause`)
      .set("Authorization", ADMIN)
      .send({ kind: "ad_set", metaObjectId: "as_1" });
    expect(res.status).toBe(200);

    const after = await pool.query(`SELECT delivering, delivering_ad_count FROM managed_campaigns WHERE id = $1`, [campaignId]);
    expect(after.rows[0]).toMatchObject({ delivering: false, delivering_ad_count: 0 });
  });

  it("refuses an object that isn't under the caller's campaign", async () => {
    const { token, campaignId } = await seed("notmine");
    const { fetchMock } = mockMeta(["ad_mine"], ["as_mine"]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(app).post("/api/app/controls/pause")
      .set("Authorization", `Bearer ${token}`)
      .send({ kind: "ad", metaObjectId: "ad_someone_else" });

    expect(res.status).toBe(404);
    expect(await historyTypes(campaignId)).toEqual([]); // nothing written
  });

  it("validates kind", async () => {
    const { token } = await seed("badkind");
    const res = await request(app).post("/api/app/controls/pause")
      .set("Authorization", `Bearer ${token}`)
      .send({ kind: "campaign", metaObjectId: "x" });
    expect(res.status).toBe(400);
  });

  it("GET /state returns live per-object statuses for the picker", async () => {
    const { token } = await seed("state");
    const { fetchMock, statuses } = mockMeta(["ad_1"], ["as_1"]);
    statuses.set("ad_1", "PAUSED");
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(app).get("/api/app/controls/state").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.adStatuses).toMatchObject({ ad_1: "paused" });
    expect(res.body.adSetStatuses).toMatchObject({ as_1: "active" });
  });

  // AIC-73 round 2: thumbnails come from a live read on panel open, the same
  // explicit-user-action rule that justifies GET /state.
  it("GET /media returns per-ad creative thumbnails, scoped to the caller's campaign", async () => {
    const { token } = await seed("media");
    const fetchMock = vi.fn(async () =>
      jsonRes({ data: [{ id: "ad_1", name: "almond green, french", creative: { thumbnail_url: "https://cdn/t.jpg" } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(app).get("/api/app/controls/media").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    // assetCount is 1 despite the multi-part NAME — never inferred from it.
    expect(res.body.ads).toMatchObject([{ adId: "ad_1", thumbnails: ["https://cdn/t.jpg"], assetCount: 1 }]);
  });

  it("GET /media requires auth", async () => {
    expect((await request(app).get("/api/app/controls/media")).status).toBe(401);
  });

  it("there is NO customer-facing delete or archive route", async () => {
    const { token } = await seed("nodelete");
    for (const action of ["delete", "archive"]) {
      const res = await request(app).post(`/api/app/controls/${action}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ kind: "ad", metaObjectId: "ad_1" });
      expect(res.status).toBe(404); // route doesn't exist at all
    }
  });

  describe("operator (admin console)", () => {
    it("pauses an object and writes BOTH logs — campaign history + admin audit", async () => {
      const { campaignId } = await seed("oppause");
      const { fetchMock, statuses } = mockMeta(["ad_1"], ["as_1"]);
      vi.stubGlobal("fetch", fetchMock);

      const res = await request(app).post(`/api/admin/campaigns/${campaignId}/objects/pause`)
        .set("Authorization", ADMIN)
        .send({ kind: "ad", metaObjectId: "ad_1" });

      expect(res.status).toBe(200);
      expect(statuses.get("ad_1")).toBe("PAUSED");
      expect(await historyTypes(campaignId)).toEqual(["pause_ad"]);
      expect(await auditFor(campaignId, "ad_1")).toMatchObject([{ action: "ad.pause", entity_type: "ad" }]);
    });

    it("archives an ad set — destructive, so it needs confirm-to-type", async () => {
      const { campaignId } = await seed("oparchive");
      const { fetchMock, statuses } = mockMeta(["ad_1"], ["as_1"]);
      vi.stubGlobal("fetch", fetchMock);

      const missing = await request(app).post(`/api/admin/campaigns/${campaignId}/objects/archive`)
        .set("Authorization", ADMIN)
        .send({ kind: "ad_set", metaObjectId: "as_1" });
      expect(missing.status).toBe(400);
      expect(statuses.get("as_1")).toBe("ACTIVE"); // untouched

      const wrong = await request(app).post(`/api/admin/campaigns/${campaignId}/objects/archive`)
        .set("Authorization", ADMIN)
        .send({ kind: "ad_set", metaObjectId: "as_1", confirm: "not-the-id" });
      expect(wrong.status).toBe(400);
      expect(statuses.get("as_1")).toBe("ACTIVE");

      const ok = await request(app).post(`/api/admin/campaigns/${campaignId}/objects/archive`)
        .set("Authorization", ADMIN)
        .send({ kind: "ad_set", metaObjectId: "as_1", confirm: "as_1" });
      expect(ok.status).toBe(200);
      expect(statuses.get("as_1")).toBe("ARCHIVED");
      expect(await historyTypes(campaignId)).toEqual(["archive_ad_set"]);
      expect(await auditFor(campaignId, "as_1")).toMatchObject([{ action: "ad_set.archive" }]);
    });

    it("deletes an ad only with a matching confirmation", async () => {
      const { campaignId } = await seed("opdelete");
      const { fetchMock, statuses } = mockMeta(["ad_1"], ["as_1"]);
      vi.stubGlobal("fetch", fetchMock);

      const ok = await request(app).post(`/api/admin/campaigns/${campaignId}/objects/delete`)
        .set("Authorization", ADMIN)
        .send({ kind: "ad", metaObjectId: "ad_1", confirm: "ad_1" });
      expect(ok.status).toBe(200);
      expect(statuses.get("ad_1")).toBe("DELETED");
      expect(await historyTypes(campaignId)).toEqual(["delete_ad"]);
    });

    it("rejects an unknown action and an object outside the campaign", async () => {
      const { campaignId } = await seed("opreject");
      const { fetchMock } = mockMeta(["ad_1"], ["as_1"]);
      vi.stubGlobal("fetch", fetchMock);

      const bad = await request(app).post(`/api/admin/campaigns/${campaignId}/objects/frobnicate`)
        .set("Authorization", ADMIN).send({ kind: "ad", metaObjectId: "ad_1" });
      expect(bad.status).toBe(400);

      const notMine = await request(app).post(`/api/admin/campaigns/${campaignId}/objects/pause`)
        .set("Authorization", ADMIN).send({ kind: "ad", metaObjectId: "ad_elsewhere" });
      expect(notMine.status).toBe(404);
    });

    it("requires an admin credential", async () => {
      const { campaignId } = await seed("opauth");
      const res = await request(app).post(`/api/admin/campaigns/${campaignId}/objects/pause`)
        .send({ kind: "ad", metaObjectId: "ad_1" });
      expect(res.status).toBe(401);
    });
  });
});
