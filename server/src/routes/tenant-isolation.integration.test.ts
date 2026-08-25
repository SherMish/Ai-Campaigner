// security audit 2026-08-25: the security guarantee, stated as a test.
//
// "User A can NEVER, by purpose or by API bug, touch user B's ads, and their
// budget cannot be changed by others."
//
// Every case below is a REAL authenticated request from customer A carrying
// customer B's identifiers — the exact shape an attacker (or a client bug)
// would send. None of these is testing that the UI hides a button; the UI is
// irrelevant here. They test that the server refuses.
//
// Requires DATABASE_URL; self-skips otherwise.
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { signAuthToken } from "../auth/tokens.js";
import { __resetRateLimits } from "../middleware/security.js";
import { ownsLocalCampaign } from "../builder/session.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;
const app = createApp();

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

// Meta, modelled HONESTLY: each campaign owns its own objects, and every write
// succeeds. That combination is what makes these tests meaningful.
//
// The first version of this mock returned the victim's ad for EVERY campaign
// id, on the theory that a maximally permissive Meta proves our checks do the
// work. It proves the opposite: `assertOwnedByCampaign` asks Meta "is this ad
// under the caller's campaign?", and a mock that answers yes has genuinely made
// it the caller's ad. Five tests "failed" as 200s that were the ownership check
// working correctly on a fixture that lied to it.
//
// So objects are keyed to their campaign, and every WRITE returns success —
// meaning nothing except our own refusal can stop a cross-tenant write.
function metaFor(tenants: Array<{ metaCampaignId: string; adId: string; adSetId: string }>) {
  const byCampaign = new Map(tenants.map((t) => [t.metaCampaignId, t]));
  const ownerOf = (u: string) => [...byCampaign.values()].find((t) => u.includes(t.metaCampaignId));
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if ((init?.method ?? "GET") === "GET") {
      if (u.includes("me/accounts")) return jsonRes({ data: [{ id: "page_1", access_token: "PT" }] });
      const t = ownerOf(u);
      if (u.includes("/adsets?")) {
        return jsonRes({ data: t ? [{ id: t.adSetId, status: "ACTIVE", effective_status: "ACTIVE", targeting: {}, ads: { data: [{ id: t.adId }] }, destination_type: "WHATSAPP" }] : [] });
      }
      if (u.includes("/ads?")) {
        return jsonRes({ data: t ? [{ id: t.adId, adset_id: t.adSetId, status: "ACTIVE", effective_status: "ACTIVE" }] : [] });
      }
      return jsonRes({ id: "x", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "3000" });
    }
    // Every write succeeds. If a cross-tenant request reaches Meta at all, the
    // test must fail — that is the whole point.
    return jsonRes({ success: true, id: "written" });
  });
}

async function seedTenant(tag: string) {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test, onboarding_status) VALUES ($1, true, 'ready') RETURNING id`,
    [`__it_iso_${tag}`],
  );
  const customerId = cust.rows[0].id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO app_users (email, password_hash, name, customer_id) VALUES ($1,'x','Owner',$2) RETURNING id`,
    [`__it_iso_${tag}@example.com`, customerId],
  );
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, access_health, page_id) VALUES ($1,'ok','page_1') RETURNING id`,
    [customerId],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_iso_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, status, meta_campaign_id, name, agreed_budget_agorot)
     VALUES ($1,$2,'active',$3,'IT Campaign',5000) RETURNING id`,
    [customerId, acct.rows[0].id, `meta_camp_iso_${tag}`],
  );
  // whatsapp_destination makes the additions context READY — without it the
  // routes answer 409 "not ready" for their own reasons and would mask whether
  // the ownership check ran at all.
  await pool.query(
    `UPDATE managed_campaigns SET whatsapp_destination = '+972500000000' WHERE id = $1`,
    [camp.rows[0].id],
  );
  return {
    customerId,
    campaignId: camp.rows[0].id,
    metaCampaignId: `meta_camp_iso_${tag}`,
    userId: user.rows[0].id,
    token: signAuthToken(user.rows[0].id),
    adId: `ad_${tag}`,
    adSetId: `as_${tag}`,
  };
}

d("tenant isolation: customer A cannot reach customer B (security audit 2026-08-25)", () => {
  let A: Awaited<ReturnType<typeof seedTenant>>;
  let B: Awaited<ReturnType<typeof seedTenant>>;

  beforeAll(async () => {
    process.env.JWT_SECRET ||= "test-secret-isolation-must-be-at-least-32-chars-long";
    process.env.META_SYSTEM_USER_TOKEN ||= "test-meta-token";
    __resetRateLimits();
    A = await seedTenant("attacker");
    B = await seedTenant("victim");
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM app_users WHERE email LIKE '__it_iso_%'`);
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_iso_%'`);
    await pool.end();
  });

  describe("B's ads", () => {
    it("A cannot pause B's ad", async () => {
      vi.stubGlobal("fetch", metaFor([A, B]));
      const res = await request(app)
        .post("/api/app/controls/pause")
        .set("Authorization", `Bearer ${A.token}`)
        .send({ kind: "ad", metaObjectId: B.adId });
      expect(res.status).toBe(404);
    });

    it("A cannot resume B's ad", async () => {
      vi.stubGlobal("fetch", metaFor([A, B]));
      const res = await request(app)
        .post("/api/app/controls/resume")
        .set("Authorization", `Bearer ${A.token}`)
        .send({ kind: "ad", metaObjectId: B.adId });
      expect(res.status).toBe(404);
    });

    it("A cannot pause B's ad SET, which would stop every ad under it", async () => {
      vi.stubGlobal("fetch", metaFor([A, B]));
      const res = await request(app)
        .post("/api/app/controls/pause")
        .set("Authorization", `Bearer ${A.token}`)
        .send({ kind: "ad_set", metaObjectId: B.adSetId });
      expect(res.status).toBe(404);
    });

    it("A cannot remove B's ad from view", async () => {
      vi.stubGlobal("fetch", metaFor([A, B]));
      const res = await request(app)
        .post("/api/app/controls/hide")
        .set("Authorization", `Bearer ${A.token}`)
        .send({ metaObjectId: B.adId });
      expect(res.status).toBe(404);
      const { rows } = await pool.query(`SELECT 1 FROM hidden_ads WHERE meta_ad_id = $1`, [B.adId]);
      expect(rows).toHaveLength(0);
    });

    // AIC-139: the details modal reads an ad by id. Without the ownership
    // check this route would be a read oracle for any ad the system user can
    // reach — another business's copy, image and destination phone number.
    it("A cannot read the details of B's ad", async () => {
      vi.stubGlobal("fetch", metaFor([A, B]));
      const res = await request(app)
        .get(`/api/app/controls/ad/${B.adId}`)
        .set("Authorization", `Bearer ${A.token}`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("whatsapp");
    });

    it("A cannot add an ad into B's ad set", async () => {
      vi.stubGlobal("fetch", metaFor([A, B]));
      const res = await request(app)
        .post("/api/app/additions/ad")
        .set("Authorization", `Bearer ${A.token}`)
        .send({ metaAdSetId: B.adSetId, name: "X", creativeId: "cr_x", additionKey: "iso-1" });
      expect(res.status).toBe(404);
    });
  });

  describe("B's campaign and data", () => {
    // TWO independent gates refuse these, and the test asserts the property
    // rather than a status code. Readiness fires first — the builder exists to
    // create a customer's FIRST campaign, and A already has one, so A cannot
    // reach the builder at all (409). Ownership (`ownsLocalCampaign`) is the
    // second gate and is covered directly below, because a test that only ever
    // sees the first gate would keep passing if the second were deleted.
    it("A cannot build creatives into B's campaign", async () => {
      vi.stubGlobal("fetch", metaFor([A, B]));
      const res = await request(app)
        .post("/api/app/builder/creative")
        .set("Authorization", `Bearer ${A.token}`)
        .send({ localCampaignId: B.campaignId, clientKey: "k", name: "n", postId: "p" });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    it("A cannot run a build against B's campaign", async () => {
      vi.stubGlobal("fetch", metaFor([A, B]));
      const before = await pool.query(`SELECT meta_campaign_id FROM managed_campaigns WHERE id = $1`, [B.campaignId]);
      const res = await request(app)
        .post("/api/app/builder/build")
        .set("Authorization", `Bearer ${A.token}`)
        .send({ localCampaignId: B.campaignId, dailyBudgetAgorot: 10000 });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      const after = await pool.query(`SELECT meta_campaign_id FROM managed_campaigns WHERE id = $1`, [B.campaignId]);
      expect(after.rows[0]).toEqual(before.rows[0]);
    });

    it("ownsLocalCampaign refuses across tenants — the gate itself, not the route", async () => {
      expect(await ownsLocalCampaign(pool, A.customerId, B.campaignId)).toBe(false);
      expect(await ownsLocalCampaign(pool, B.customerId, A.campaignId)).toBe(false);
      // ...and still says yes to the real owner, so the check is not simply
      // returning false for everything.
      expect(await ownsLocalCampaign(pool, A.customerId, A.campaignId)).toBe(true);
      // An absent id is refused rather than treated as "no constraint".
      expect(await ownsLocalCampaign(pool, A.customerId, undefined)).toBe(false);
    });

    it("A cannot read or approve B's recommendation", async () => {
      const rec = await pool.query<{ id: string }>(
        `INSERT INTO recommendations (campaign_id, type, state, rationale, evidence)
         VALUES ($1,'increase_budget','proposed','r','{}'::jsonb) RETURNING id`,
        [B.campaignId],
      );
      const id = rec.rows[0].id;
      for (const path of [`/api/app/recommendations/${id}`]) {
        const res = await request(app).get(path).set("Authorization", `Bearer ${A.token}`);
        expect(res.status).toBe(404);
      }
      for (const path of [`/api/app/recommendations/${id}/approve`, `/api/app/recommendations/${id}/dismiss`]) {
        const res = await request(app).post(path).set("Authorization", `Bearer ${A.token}`).send({});
        expect(res.status).toBe(404);
      }
      // Still untouched: not approved, not dismissed, still awaiting ITS OWNER.
      const after = await pool.query<{ state: string }>(`SELECT state FROM recommendations WHERE id = $1`, [id]);
      expect(after.rows[0].state).toBe("proposed");
    });

    it("A's overview never contains B's campaign", async () => {
      const res = await request(app).get("/api/app/overview").set("Authorization", `Bearer ${A.token}`);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(B.campaignId);
      expect(JSON.stringify(res.body)).not.toContain("__it_iso_victim");
    });
  });

  describe("B's budget", () => {
    it("A cannot change B's budget, and cannot change their OWN either", async () => {
      // There is deliberately no customer-facing budget WRITE anywhere in the
      // product: /budget-request records a request for an operator to action.
      // So the strongest statement this test can make is that the only
      // customer-reachable budget endpoint leaves both budgets untouched.
      const res = await request(app)
        .post("/api/app/budget-request")
        .set("Authorization", `Bearer ${A.token}`)
        .send({ requestedAgorot: 999999 });
      expect(res.status).toBe(200);

      for (const t of [A, B]) {
        const { rows } = await pool.query<{ agreed_budget_agorot: number }>(
          `SELECT agreed_budget_agorot FROM managed_campaigns WHERE id = $1`,
          [t.campaignId],
        );
        expect(Number(rows[0].agreed_budget_agorot)).toBe(5000);
      }
    });
  });

  describe("the admin console is not reachable as a customer", () => {
    it("a plain customer token is refused everywhere under /admin", async () => {
      for (const path of ["/api/admin/customers", "/api/admin/campaigns", "/api/admin/overview", "/api/admin/users"]) {
        const res = await request(app).get(path).set("Authorization", `Bearer ${A.token}`);
        expect(res.status).toBe(403);
      }
    });

    it("A cannot archive or delete B's ad through the operator route", async () => {
      vi.stubGlobal("fetch", metaFor([A, B]));
      for (const action of ["archive", "delete"]) {
        const res = await request(app)
          .post(`/api/admin/campaigns/${B.campaignId}/objects/${action}`)
          .set("Authorization", `Bearer ${A.token}`)
          .send({ kind: "ad", metaObjectId: B.adId, confirm: B.adId });
        expect(res.status).toBe(403);
      }
    });

    it("no token at all is refused", async () => {
      const res = await request(app).get("/api/admin/customers");
      expect(res.status).toBe(401);
    });
  });
});
