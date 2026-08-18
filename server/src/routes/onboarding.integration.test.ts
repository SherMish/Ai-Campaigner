// DB + HTTP integration for the onboarding wizard's admin routes (AIC-101).
//
// The point of every case here: a failing step must name WHICH of the three
// layers is at fault. A wizard that reported "connection failed" would be the
// markdown runbook with nicer formatting — and would reproduce the exact
// production bug it exists to prevent.
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;
const ADMIN = "Bearer test-admin";
const app = createApp();

const PAGE = "1216278568228263";
const ACCT = "act_2181076988590009";
const ALL_SCOPES = ["ads_read", "ads_management", "pages_show_list", "pages_read_engagement"];
const ADS_ONLY = ["ads_read", "ads_management"];

const json = (body: unknown, ok = true) =>
  ({ ok, status: ok ? 200 : 400, json: async () => body }) as unknown as Response;

// Same fake Graph as the probe's own unit tests, so a routing change can't
// quietly diverge from the behaviour those lock in.
function fakeGraph(opts: {
  scopes?: string[];
  clientPages?: string[];
  clientAdAccounts?: string[];
  mePages?: string[];
  readOk?: boolean;
}) {
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("debug_token")) return json({ data: { scopes: opts.scopes ?? ALL_SCOPES } });
    if (u.includes("client_pages")) return json({ data: (opts.clientPages ?? [PAGE]).map((id) => ({ id })) });
    if (u.includes("client_ad_accounts")) return json({ data: (opts.clientAdAccounts ?? [ACCT]).map((id) => ({ id })) });
    if (u.includes("me/accounts")) return json({ data: (opts.mePages ?? [PAGE]).map((id) => ({ id })) });
    return opts.readOk === false
      ? json({ error: { message: "(#100) Requires pages_read_engagement" } }, false)
      : json({ id: PAGE, name: "פסגה" });
  }) as unknown as typeof fetch;
}

async function seedCustomer(tag: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test, onboarding_status)
     VALUES ($1, true, 'ready') RETURNING id`,
    [`__it_wiz_${tag}`],
  );
  return r.rows[0].id;
}

d("onboarding wizard routes (AIC-101)", () => {
  beforeAll(() => {
    process.env.JWT_SECRET ||= "test-secret-wizard";
    process.env.ADMIN_TOKEN = "test-admin";
    process.env.META_SYSTEM_USER_TOKEN ||= "test-meta-token";
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_wiz_%'`);
    await pool.end();
  });

  it("is admin-only — the customer never sees this surface", async () => {
    const id = await seedCustomer("auth");
    expect((await request(app).get(`/api/admin/customers/${id}/onboarding`)).status).toBe(401);
    expect((await request(app).post(`/api/admin/customers/${id}/onboarding/check`).send({})).status).toBe(401);
    expect((await request(app).post(`/api/admin/customers/${id}/onboarding/provision`).send({})).status).toBe(401);
  });

  it("opening the wizard creates state and hands back OUR portfolio id from config", async () => {
    const id = await seedCustomer("open");
    const res = await request(app).get(`/api/admin/customers/${id}/onboarding`).set("Authorization", ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.state.currentStep).toBe(1);
    // Read from server config, never a hardcoded literal in the bundle —
    // the customer adds us as a partner BY ID, so this is the one value on
    // the whole screen that has to be right.
    expect(res.body.businessPortfolioId).toMatch(/^\d+$/);
  });

  it("progress survives a reload — calls get interrupted", async () => {
    const id = await seedCustomer("resume");
    await request(app).get(`/api/admin/customers/${id}/onboarding`).set("Authorization", ADMIN);
    await request(app).post(`/api/admin/customers/${id}/onboarding/step`).set("Authorization", ADMIN).send({ step: 3 });

    const again = await request(app).get(`/api/admin/customers/${id}/onboarding`).set("Authorization", ADMIN);
    expect(again.body.state.currentStep).toBe(3);
  });

  describe("live per-step verification names the failing layer", () => {
    it("all three layers pass → ok", async () => {
      const id = await seedCustomer("checkok");
      vi.stubGlobal("fetch", fakeGraph({}));
      const res = await request(app).post(`/api/admin/customers/${id}/onboarding/check`)
        .set("Authorization", ADMIN).send({ asset: "page", assetId: PAGE });

      expect(res.status).toBe(200);
      expect(res.body.result.verdict).toEqual({ ok: true, layer: null, diagnosis: "ok" });
      expect(res.body.state.checks.page.ok).toBe(true);
    });

    it("customer hasn't shared it → layer 1, and the result is persisted", async () => {
      const id = await seedCustomer("layer1");
      vi.stubGlobal("fetch", fakeGraph({ clientPages: [], mePages: [], readOk: false }));
      const res = await request(app).post(`/api/admin/customers/${id}/onboarding/check`)
        .set("Authorization", ADMIN).send({ asset: "page", assetId: PAGE });

      expect(res.body.result.verdict).toMatchObject({ ok: false, layer: 1, diagnosis: "not_shared" });
      // Persisted with a timestamp so a later failure traces to what actually
      // passed at onboarding.
      expect(res.body.state.checks.page).toMatchObject({ ok: false, layer: 1 });
      expect(res.body.state.checks.page.at).toBeTruthy();
    });

    it("shared but unassigned → layer 2", async () => {
      const id = await seedCustomer("layer2");
      vi.stubGlobal("fetch", fakeGraph({ mePages: [], readOk: false }));
      const res = await request(app).post(`/api/admin/customers/${id}/onboarding/check`)
        .set("Authorization", ADMIN).send({ asset: "page", assetId: PAGE });
      expect(res.body.result.verdict).toMatchObject({ layer: 2, diagnosis: "not_assigned" });
    });

    it("ads-only token → layer 3, the one assignment can never fix", async () => {
      const id = await seedCustomer("layer3");
      vi.stubGlobal("fetch", fakeGraph({ scopes: ADS_ONLY, readOk: false }));
      const res = await request(app).post(`/api/admin/customers/${id}/onboarding/check`)
        .set("Authorization", ADMIN).send({ asset: "page", assetId: PAGE });
      expect(res.body.result.verdict).toMatchObject({ layer: 3, diagnosis: "token_missing_scopes" });
    });

    it("rejects an unknown asset kind rather than guessing", async () => {
      const id = await seedCustomer("badasset");
      const res = await request(app).post(`/api/admin/customers/${id}/onboarding/check`)
        .set("Authorization", ADMIN).send({ asset: "pixel", assetId: "1" });
      expect(res.status).toBe(400);
    });
  });

  it("the token check reports exactly which scopes are missing", async () => {
    const id = await seedCustomer("token");
    vi.stubGlobal("fetch", fakeGraph({ scopes: ADS_ONLY }));
    const res = await request(app).post(`/api/admin/customers/${id}/onboarding/token-check`)
      .set("Authorization", ADMIN).send({});

    expect(res.body.ok).toBe(false);
    expect(res.body.missing).toContain("pages_show_list");
    expect(res.body.missing).toContain("pages_read_engagement");
  });

  describe("provisioning (AIC-68) — step 4, no SQL", () => {
    const body = (extra: Record<string, unknown> = {}) => ({
      metaAdAccountId: ACCT,
      metaCampaignId: `camp_${Math.random().toString(36).slice(2, 10)}`,
      campaignName: "IT Wizard Campaign",
      agreedBudgetAgorot: 2000,
      systemUserId: "122103498795426897",
      // AIC-103: a complete WhatsApp shape by default — destinationType is
      // now a real required field, not an implicit assumption.
      destinationType: "whatsapp",
      whatsappDestination: "972500000000",
      ...extra,
    });

    it("creates the records and returns their ids", async () => {
      const id = await seedCustomer("prov");
      vi.stubGlobal("fetch", fakeGraph({}));
      const res = await request(app).post(`/api/admin/customers/${id}/onboarding/provision`)
        .set("Authorization", ADMIN).send(body());

      expect(res.status).toBe(200);
      expect(res.body.result.connectionId).toBeTruthy();
      expect(res.body.result.campaignId).toBeTruthy();
    });

    it("REFUSES a page_id the backend can't read — 409, with the diagnosis", async () => {
      const id = await seedCustomer("provgate");
      // Layer 1 failure: the customer never shared the Page.
      vi.stubGlobal("fetch", fakeGraph({ clientPages: [], mePages: [], readOk: false }));

      const res = await request(app).post(`/api/admin/customers/${id}/onboarding/provision`)
        .set("Authorization", ADMIN).send(body({ pageId: PAGE }));

      // A refusal the operator can act on, not a 500.
      expect(res.status).toBe(409);
      expect(res.body.diagnosis).toBe("not_shared");
      // And nothing was written — a page_id the backend can't read would flip
      // the connection to revoked and silently stop the engine (AIC-69).
      const conns = await pool.query(`SELECT id FROM meta_connections WHERE customer_id = $1`, [id]);
      expect(conns.rows).toHaveLength(0);
    });

    it("re-verifies the Page at save time, never trusting an earlier pass", async () => {
      const id = await seedCustomer("provrecheck");
      // The Page check passes first...
      vi.stubGlobal("fetch", fakeGraph({}));
      const ok = await request(app).post(`/api/admin/customers/${id}/onboarding/check`)
        .set("Authorization", ADMIN).send({ asset: "page", assetId: PAGE });
      expect(ok.body.result.verdict.ok).toBe(true);

      // ...then access is lost before provisioning (the customer revokes, or
      // it never really worked). The stored pass must not authorize the write.
      vi.stubGlobal("fetch", fakeGraph({ clientPages: [], mePages: [], readOk: false }));
      const res = await request(app).post(`/api/admin/customers/${id}/onboarding/provision`)
        .set("Authorization", ADMIN).send(body({ pageId: PAGE }));

      expect(res.status).toBe(409);
    });

    it("validates the budget rather than writing a nonsense campaign", async () => {
      const id = await seedCustomer("provbudget");
      vi.stubGlobal("fetch", fakeGraph({}));
      const res = await request(app).post(`/api/admin/customers/${id}/onboarding/provision`)
        .set("Authorization", ADMIN).send(body({ agreedBudgetAgorot: 0 }));
      expect(res.status).toBe(400);
    });

    // ── AIC-103: destinationType + the completeness guard ──────────────
    it("400s when destinationType is missing entirely — not silently defaulted", async () => {
      const id = await seedCustomer("provnodest");
      vi.stubGlobal("fetch", fakeGraph({}));
      const res = await request(app).post(`/api/admin/customers/${id}/onboarding/provision`)
        .set("Authorization", ADMIN).send(body({ destinationType: undefined }));
      expect(res.status).toBe(400);
    });

    it("400s a whatsapp provision missing whatsappDestination, naming the field", async () => {
      const id = await seedCustomer("provnowanum");
      vi.stubGlobal("fetch", fakeGraph({}));
      const res = await request(app).post(`/api/admin/customers/${id}/onboarding/provision`)
        .set("Authorization", ADMIN).send(body({ whatsappDestination: null }));
      expect(res.status).toBe(400);
      expect(res.body.missingFields).toContain("whatsapp_destination");
    });

    it("400s a website provision missing website_url + tracking_pixel_id, naming both", async () => {
      const id = await seedCustomer("provnowebsite");
      vi.stubGlobal("fetch", fakeGraph({}));
      const res = await request(app).post(`/api/admin/customers/${id}/onboarding/provision`)
        .set("Authorization", ADMIN).send(body({
          destinationType: "website", whatsappDestination: null,
          leadEventTypes: ["offsite_conversion.fb_pixel_lead"],
        }));
      expect(res.status).toBe(400);
      expect(res.body.missingFields).toEqual(["website_url", "tracking_pixel_id"]);
    });

    it("creates a complete website campaign — whatsapp_destination stays '' (the column default), not required for this type", async () => {
      const id = await seedCustomer("provwebsiteok");
      vi.stubGlobal("fetch", fakeGraph({}));
      const res = await request(app).post(`/api/admin/customers/${id}/onboarding/provision`)
        .set("Authorization", ADMIN).send(body({
          destinationType: "website", whatsappDestination: null,
          leadEventTypes: ["offsite_conversion.fb_pixel_lead"],
          trackingPixelId: "984664453249037",
          websiteUrl: "https://pisga.app/signup?utm_source=meta&utm_medium=cpc&utm_campaign=test",
        }));
      expect(res.status).toBe(200);
      const camp = await pool.query<{ whatsapp_destination: string; website_url: string }>(
        `SELECT whatsapp_destination, website_url FROM managed_campaigns WHERE id = $1`, [res.body.result.campaignId]);
      expect(camp.rows[0].whatsapp_destination).toBe("");
      expect(camp.rows[0].website_url).toContain("utm_source=meta");
    });

    it("saves the page_id when the Page genuinely reads", async () => {
      const id = await seedCustomer("provpage");
      vi.stubGlobal("fetch", fakeGraph({}));
      const res = await request(app).post(`/api/admin/customers/${id}/onboarding/provision`)
        .set("Authorization", ADMIN).send(body({ pageId: PAGE }));

      expect(res.status).toBe(200);
      expect(res.body.result.pageIdSaved).toBe(true);
      const conn = await pool.query<{ page_id: string }>(
        `SELECT page_id FROM meta_connections WHERE id = $1`, [res.body.result.connectionId]);
      expect(conn.rows[0].page_id).toBe(PAGE);
    });

    // AIC-105 Branch A: a customer with zero campaigns on their ad account —
    // the step-4 picker's "no campaigns found" case. The operator connects
    // the account alone here; the builder wizard creates the actual campaign
    // (and its managed_campaigns row) afterward.
    it("AIC-105 Branch A: provisions the connection alone when no campaign is given yet", async () => {
      const id = await seedCustomer("provnocamp");
      vi.stubGlobal("fetch", fakeGraph({}));
      const res = await request(app).post(`/api/admin/customers/${id}/onboarding/provision`)
        .set("Authorization", ADMIN).send({ metaAdAccountId: ACCT, systemUserId: "122103498795426897" });

      expect(res.status).toBe(200);
      expect(res.body.result.connectionId).toBeTruthy();
      expect(res.body.result.campaignId).toBeNull();
      const camps = await pool.query(`SELECT id FROM managed_campaigns WHERE customer_id = $1`, [id]);
      expect(camps.rows).toHaveLength(0);
      const acct = await pool.query(`SELECT id FROM ad_accounts WHERE connection_id = $1`, [res.body.result.connectionId]);
      expect(acct.rows).toHaveLength(1);
    });

    it("400s a campaign missing campaignName, even with metaCampaignId present — never half a campaign row", async () => {
      const id = await seedCustomer("provhalfcamp");
      vi.stubGlobal("fetch", fakeGraph({}));
      const res = await request(app).post(`/api/admin/customers/${id}/onboarding/provision`)
        .set("Authorization", ADMIN).send(body({ campaignName: undefined }));
      expect(res.status).toBe(400);
    });
  });

  // AIC-105 Branch B — "pick, don't type": step 4's ad-account and campaign
  // pickers, backed by GraphCampaignAdapter.listAdAccounts/listCampaigns.
  describe("discovery (AIC-105) — ad-account and campaign pickers", () => {
    const WHATSAPP_CAMP = "camp_whatsapp_1";
    const PIXEL_CAMP = "camp_pixel_1";
    const TRAFFIC_CAMP = "camp_traffic_1";
    const EMPTY_CAMP = "camp_empty_1";

    // A dedicated fake, local to this block: the shared fakeGraph above has
    // no notion of ad-account/campaign/ad-set LISTING at all, and extending
    // it would risk perturbing every other test that already passes against
    // its exact behaviour. `listedAccountId` is per-call, NOT the shared
    // `ACCT` constant: `ad_accounts` rows persist for the rest of the file
    // (only `afterAll` cleans up), so every test that cares about
    // `usedByCustomer` needs an id nothing else in the file — including
    // earlier tests in THIS block — has ever written a row against.
    function fakeDiscoveryGraph(listedAccountId: string) {
      return vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("me/adaccounts")) {
          return json({ data: [{ id: listedAccountId, name: "GelNails", currency: "ILS", account_status: 1 }] });
        }
        if (u.includes(`${ACCT}/campaigns`)) {
          return json({
            data: [
              { id: WHATSAPP_CAMP, name: "WhatsApp campaign", status: "ACTIVE", effective_status: "ACTIVE", objective: "OUTCOME_LEADS", daily_budget: "2000" },
              { id: PIXEL_CAMP, name: "Website campaign", status: "ACTIVE", effective_status: "ACTIVE", objective: "OUTCOME_LEADS", daily_budget: "3000" },
              { id: TRAFFIC_CAMP, name: "Old traffic campaign", status: "PAUSED", effective_status: "PAUSED", objective: "OUTCOME_TRAFFIC", daily_budget: null },
              { id: EMPTY_CAMP, name: "Brand new, no ad sets yet", status: "ACTIVE", effective_status: "ACTIVE", objective: "OUTCOME_LEADS", daily_budget: null },
            ],
          });
        }
        if (u.includes(`${WHATSAPP_CAMP}/adsets`)) {
          return json({ data: [{ id: "as_wa", optimization_goal: "CONVERSATIONS", destination_type: "WHATSAPP" }] });
        }
        if (u.includes(`${PIXEL_CAMP}/adsets`)) {
          return json({ data: [{ id: "as_px", optimization_goal: "OFFSITE_CONVERSIONS", promoted_object: { pixel_id: "984664453249037", custom_event_type: "COMPLETE_REGISTRATION" } }] });
        }
        if (u.includes(`${TRAFFIC_CAMP}/adsets`)) {
          return json({ data: [{ id: "as_tr", optimization_goal: "LINK_CLICKS" }] });
        }
        if (u.includes(`${EMPTY_CAMP}/adsets`)) {
          return json({ data: [] });
        }
        return json({ error: { message: `unexpected discovery call: ${u}` } }, false);
      }) as unknown as typeof fetch;
    }

    it("lists ad accounts the System User can currently manage", async () => {
      const id = await seedCustomer("disc-accts");
      const acctId = "act_disc_list_only";
      vi.stubGlobal("fetch", fakeDiscoveryGraph(acctId));
      const res = await request(app).get(`/api/admin/customers/${id}/onboarding/ad-accounts`).set("Authorization", ADMIN);
      expect(res.status).toBe(200);
      expect(res.body.accounts).toEqual([
        { id: acctId, name: "GelNails", currency: "ILS", accountStatus: 1, usedByCustomer: null },
      ]);
    });

    it("flags an ad account already provisioned to a DIFFERENT customer — informational, not a block", async () => {
      const acctId = "act_disc_shared_other";
      const mine = await seedCustomer("disc-owner");
      const other = await seedCustomer("disc-other");
      const conn = await pool.query<{ id: string }>(`INSERT INTO meta_connections (customer_id) VALUES ($1) RETURNING id`, [other]);
      await pool.query(`INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1, $2)`, [conn.rows[0].id, acctId]);

      vi.stubGlobal("fetch", fakeDiscoveryGraph(acctId));
      const res = await request(app).get(`/api/admin/customers/${mine}/onboarding/ad-accounts`).set("Authorization", ADMIN);
      expect(res.status).toBe(200);
      expect(res.body.accounts[0].usedByCustomer).toMatchObject({ id: other, name: "__it_wiz_disc-other" });
    });

    it("does NOT flag an ad account for the SAME customer it already belongs to", async () => {
      const acctId = "act_disc_shared_self";
      const id = await seedCustomer("disc-self");
      const conn = await pool.query<{ id: string }>(`INSERT INTO meta_connections (customer_id) VALUES ($1) RETURNING id`, [id]);
      await pool.query(`INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1, $2)`, [conn.rows[0].id, acctId]);

      vi.stubGlobal("fetch", fakeDiscoveryGraph(acctId));
      const res = await request(app).get(`/api/admin/customers/${id}/onboarding/ad-accounts`).set("Authorization", ADMIN);
      expect(res.body.accounts[0].usedByCustomer).toBeNull();
    });

    it("503s honestly when no META_SYSTEM_USER_TOKEN is configured", async () => {
      const id = await seedCustomer("disc-notoken");
      const saved = process.env.META_SYSTEM_USER_TOKEN;
      delete process.env.META_SYSTEM_USER_TOKEN;
      try {
        const res = await request(app).get(`/api/admin/customers/${id}/onboarding/ad-accounts`).set("Authorization", ADMIN);
        expect(res.status).toBe(503);
      } finally {
        process.env.META_SYSTEM_USER_TOKEN = saved;
      }
    });

    it("lists campaigns with destination DETECTED, never asked", async () => {
      const id = await seedCustomer("disc-camps");
      vi.stubGlobal("fetch", fakeDiscoveryGraph(ACCT));
      const res = await request(app)
        .get(`/api/admin/customers/${id}/onboarding/campaigns`)
        .query({ metaAdAccountId: ACCT })
        .set("Authorization", ADMIN);

      expect(res.status).toBe(200);
      const campaigns = res.body.campaigns as Array<{ id: string; destination: unknown }>;
      expect(campaigns.find((c) => c.id === WHATSAPP_CAMP)?.destination).toEqual({ supported: true, destinationType: "whatsapp" });
      expect(campaigns.find((c) => c.id === PIXEL_CAMP)?.destination).toEqual({
        supported: true, destinationType: "website",
        trackingPixelId: "984664453249037", leadEventTypes: ["offsite_conversion.fb_pixel_complete_registration"],
      });
    });

    it("a Traffic-objective campaign is still LISTED, disabled with a reason — never hidden (AIC-98)", async () => {
      const id = await seedCustomer("disc-traffic");
      vi.stubGlobal("fetch", fakeDiscoveryGraph(ACCT));
      const res = await request(app)
        .get(`/api/admin/customers/${id}/onboarding/campaigns`)
        .query({ metaAdAccountId: ACCT })
        .set("Authorization", ADMIN);

      const traffic = res.body.campaigns.find((c: { id: string }) => c.id === TRAFFIC_CAMP);
      expect(traffic.destination).toEqual({ supported: false, reason: "unrecognized_objective" });
      const empty = res.body.campaigns.find((c: { id: string }) => c.id === EMPTY_CAMP);
      expect(empty.destination).toEqual({ supported: false, reason: "no_ad_sets" });
    });

    it("400s when metaAdAccountId is missing from the query", async () => {
      const id = await seedCustomer("disc-noacct");
      const res = await request(app).get(`/api/admin/customers/${id}/onboarding/campaigns`).set("Authorization", ADMIN);
      expect(res.status).toBe(400);
    });

    // The Page-side sibling: same "pick, don't type" move, but SCOPED to the
    // picked ad account via `{ad_account}/promote_pages` — Meta's own answer
    // to "which Pages can this account advertise for".
    const OTHER_ACCT = "act_1573023157816786";
    const OTHER_PAGE = "1214357698438710";
    const BIZ_A = "467328257419676";
    const BIZ_B = "1518507149596335";

    // Mirrors the real live shape (verified 2026-08-18). The important part
    // is OTHER_ACCT: it has never run an ad, so `promote_pages` is EMPTY for
    // it even though its Page is assigned to the System User — the exact
    // state a brand-new account is in when Branch A goes to build its first
    // campaign.
    function fakePagesGraph() {
      return vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes(`${ACCT}?fields=business`)) return json({ id: ACCT, business: { id: BIZ_A } });
        if (u.includes(`${OTHER_ACCT}?fields=business`)) return json({ id: OTHER_ACCT, business: { id: BIZ_B } });
        if (u.includes("me/accounts")) {
          return json({ data: [
            { id: PAGE, name: "פסגה", business: { id: BIZ_A } },
            { id: OTHER_PAGE, name: "Ads Agent", business: { id: BIZ_B } },
          ] });
        }
        if (u.includes(`${ACCT}/promote_pages`)) return json({ data: [{ id: PAGE, name: "פסגה" }] });
        if (u.includes(`${OTHER_ACCT}/promote_pages`)) return json({ data: [] });
        throw new Error(`unexpected fetch ${u}`);
      }) as unknown as typeof fetch;
    }

    it("lists only the Pages the PICKED ad account can promote", async () => {
      const id = await seedCustomer("disc-pages");
      vi.stubGlobal("fetch", fakePagesGraph());
      const res = await request(app)
        .get(`/api/admin/customers/${id}/onboarding/pages`)
        .query({ metaAdAccountId: ACCT })
        .set("Authorization", ADMIN);
      expect(res.status).toBe(200);
      expect(res.body.pages).toEqual([{ id: PAGE, name: "פסגה" }]);
    });

    // Both bugs this list has already had, locked in as one case:
    //  - it must NOT leak the other business's Page (the unscoped
    //    `me/accounts` bug), and
    //  - it MUST still find this account's own Page even though the account
    //    has never run an ad, so `promote_pages` is empty (the
    //    promote_pages-only bug, which broke exactly the create-first-campaign
    //    flow it was meant to serve).
    it("finds a brand-new account's own Page — never the other business's — even with promote_pages empty", async () => {
      const id = await seedCustomer("disc-pages-scoped");
      vi.stubGlobal("fetch", fakePagesGraph());
      const res = await request(app)
        .get(`/api/admin/customers/${id}/onboarding/pages`)
        .query({ metaAdAccountId: OTHER_ACCT })
        .set("Authorization", ADMIN);
      expect(res.status).toBe(200);
      expect(res.body.pages).toEqual([{ id: OTHER_PAGE, name: "Ads Agent" }]);
    });

    it("400s when metaAdAccountId is missing — a Page list is meaningless unscoped", async () => {
      const id = await seedCustomer("disc-pages-noacct");
      const res = await request(app).get(`/api/admin/customers/${id}/onboarding/pages`).set("Authorization", ADMIN);
      expect(res.status).toBe(400);
    });

    it("503s honestly for the Pages picker when no META_SYSTEM_USER_TOKEN is configured", async () => {
      const id = await seedCustomer("disc-pages-notoken");
      const saved = process.env.META_SYSTEM_USER_TOKEN;
      delete process.env.META_SYSTEM_USER_TOKEN;
      const res = await request(app)
        .get(`/api/admin/customers/${id}/onboarding/pages`)
        .query({ metaAdAccountId: ACCT })
        .set("Authorization", ADMIN);
      process.env.META_SYSTEM_USER_TOKEN = saved;
      expect(res.status).toBe(503);
    });
  });

  it("finalize refuses before anything is provisioned", async () => {
    const id = await seedCustomer("finalempty");
    const res = await request(app).post(`/api/admin/customers/${id}/onboarding/finalize`)
      .set("Authorization", ADMIN).send({});
    expect(res.status).toBe(409);
  });
});
