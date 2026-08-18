// DB integration for the onboarding wizard's state + provisioning (AIC-101,
// AIC-68). The page_id guard is the one that matters most: it stands in front
// of a bug that already reached production (AIC-69).
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { pool } from "../db/pool.js";
import {
  getOrCreateOnboarding,
  setStep,
  recordCheck,
  markComplete,
  provisionConnection,
  PageNotReadableError,
  IncompleteProvisioningError,
} from "./customer-onboarding.js";
import type { AccessVerdict } from "../meta/access-layers.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

const OK: AccessVerdict = { ok: true, layer: null, diagnosis: "ok" };
const NOT_SHARED: AccessVerdict = { ok: false, layer: 1, diagnosis: "not_shared" };
const NO_SCOPES: AccessVerdict = { ok: false, layer: 3, diagnosis: "token_missing_scopes" };

async function seedCustomer(tag: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test, onboarding_status)
     VALUES ($1, true, 'ready') RETURNING id`,
    [`__it_onb_${tag}`],
  );
  return r.rows[0].id;
}

d("customer onboarding (DB)", () => {
  beforeAll(() => { process.env.JWT_SECRET ||= "test-secret-onboarding"; });
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_onb_%'`);
    await pool.end();
  });

  describe("wizard state", () => {
    it("is created on first open and returns the same row on re-open (resumable)", async () => {
      const customerId = await seedCustomer("resume");
      const first = await getOrCreateOnboarding(pool, customerId);
      expect(first.currentStep).toBe(1);
      expect(first.checks).toEqual({});
      expect(first.completedAt).toBeNull();

      await setStep(pool, customerId, 3);
      // Simulates the operator closing the tab mid-call and coming back.
      const reopened = await getOrCreateOnboarding(pool, customerId);
      expect(reopened.currentStep).toBe(3);
      expect(reopened.startedAt).toBe(first.startedAt);
    });

    it("records each check's verdict AND when it was taken", async () => {
      const customerId = await seedCustomer("checks");
      await getOrCreateOnboarding(pool, customerId);

      const before = Date.now();
      const s = await recordCheck(pool, customerId, "ad_account", OK, null);

      expect(s.checks.ad_account?.ok).toBe(true);
      expect(s.checks.ad_account?.diagnosis).toBe("ok");
      // The timestamp is the point: a connection that breaks in three weeks
      // can be traced to what was genuinely verified at onboarding.
      const at = new Date(s.checks.ad_account!.at).getTime();
      expect(at).toBeGreaterThanOrEqual(before - 1000);
    });

    it("recording one check never clobbers another's earlier result", async () => {
      const customerId = await seedCustomer("merge");
      await getOrCreateOnboarding(pool, customerId);
      await recordCheck(pool, customerId, "ad_account", OK, null);
      const s = await recordCheck(pool, customerId, "page", NOT_SHARED, "client_pages empty");

      expect(s.checks.ad_account?.ok).toBe(true);
      expect(s.checks.page?.ok).toBe(false);
      expect(s.checks.page?.layer).toBe(1);
      expect(s.checks.page?.detail).toBe("client_pages empty");
    });

    it("a failed check keeps its layer + diagnosis, so the fix stays specific", async () => {
      const customerId = await seedCustomer("layer3");
      await getOrCreateOnboarding(pool, customerId);
      const s = await recordCheck(pool, customerId, "page", NO_SCOPES, null);
      expect(s.checks.page).toMatchObject({ ok: false, layer: 3, diagnosis: "token_missing_scopes" });
    });

    // AIC-105 follow-up, found live on a real customer (אבשלום אבורוס,
    // 2026-08-18): the stored check carried `ok: true` forever, but never
    // WHAT was checked — reopening the wizard showed a green "תקין" pill next
    // to an empty ad-account field. `detail` was `null` on a passing check,
    // so there was nowhere the id could have been recovered from.
    it("a passing check remembers WHAT was checked, not just that it passed", async () => {
      const customerId = await seedCustomer("assetid");
      await getOrCreateOnboarding(pool, customerId);
      const s = await recordCheck(pool, customerId, "ad_account", OK, null, "act_2181076988590009");
      expect(s.checks.ad_account?.assetId).toBe("act_2181076988590009");

      // Survives a reopen exactly like the verdict itself does.
      const reopened = await getOrCreateOnboarding(pool, customerId);
      expect(reopened.checks.ad_account?.assetId).toBe("act_2181076988590009");
    });

    it("a check with no single asset (token, connection) stores assetId as null, not a crash", async () => {
      const customerId = await seedCustomer("assetidnull");
      await getOrCreateOnboarding(pool, customerId);
      const s = await recordCheck(pool, customerId, "token", OK, null, null);
      expect(s.checks.token?.assetId).toBeNull();
    });

    it("completedAt is only set explicitly — never inferred", async () => {
      const customerId = await seedCustomer("complete");
      await getOrCreateOnboarding(pool, customerId);
      await recordCheck(pool, customerId, "ad_account", OK, null);
      expect((await getOrCreateOnboarding(pool, customerId)).completedAt).toBeNull();

      const done = await markComplete(pool, customerId);
      expect(done.completedAt).not.toBeNull();
    });
  });

  describe("provisioning (AIC-68) — replaces hand-written SQL", () => {
    // AIC-103: a complete WhatsApp shape by default — destinationType +
    // whatsappDestination are both now genuinely required by the provisioning-
    // time completeness guard, not just documented defaults.
    const base = (customerId: string) => ({
      customerId,
      systemUserId: "122103498795426897",
      metaAdAccountId: `act_it_${customerId.slice(0, 8)}`,
      metaCampaignId: `camp_${customerId.slice(0, 8)}`,
      campaignName: "IT Campaign",
      agreedBudgetAgorot: 2000,
      destinationType: "whatsapp" as const,
      whatsappDestination: "972500000000",
    });

    it("creates the connection + ad account + campaign trio in one go", async () => {
      const customerId = await seedCustomer("provision");
      const r = await provisionConnection(pool, base(customerId), null);

      expect(r.connectionId).toBeTruthy();
      expect(r.pageIdSaved).toBe(false);

      const conn = await pool.query(`SELECT access_health, page_id FROM meta_connections WHERE id = $1`, [r.connectionId]);
      expect(conn.rows[0]).toMatchObject({ access_health: "ok", page_id: null });

      const camp = await pool.query(`SELECT status, meta_campaign_id, agreed_budget_agorot FROM managed_campaigns WHERE id = $1`, [r.campaignId]);
      expect(camp.rows[0]).toMatchObject({ status: "active", agreed_budget_agorot: 2000 });
    });

    it("defaults lead_event_types to the WhatsApp pair when none is given", async () => {
      const customerId = await seedCustomer("leaddefault");
      const r = await provisionConnection(pool, base(customerId), null);
      const c = await pool.query<{ lead_event_types: string[] }>(
        `SELECT lead_event_types FROM managed_campaigns WHERE id = $1`, [r.campaignId]);
      expect(c.rows[0].lead_event_types).toContain("onsite_conversion.messaging_conversation_started");
    });

    it("carries a Pixel lead definition through when one is given (AIC-87)", async () => {
      const customerId = await seedCustomer("pixel");
      const r = await provisionConnection(pool, {
        ...base(customerId),
        destinationType: "website",
        leadEventTypes: ["offsite_conversion.fb_pixel_complete_registration"],
        trackingPixelId: "984664453249037",
        websiteUrl: "https://pisga.app/signup",
      }, null);
      const c = await pool.query<{ lead_event_types: string[]; tracking_pixel_id: string }>(
        `SELECT lead_event_types, tracking_pixel_id FROM managed_campaigns WHERE id = $1`, [r.campaignId]);
      // Connecting a Pixel campaign with the WhatsApp default would ingest 0
      // leads on real spend — the exact bug AIC-87 exists to prevent.
      expect(c.rows[0].lead_event_types).toEqual(["offsite_conversion.fb_pixel_complete_registration"]);
      expect(c.rows[0].tracking_pixel_id).toBe("984664453249037");
    });

    it("carries a website destination URL through when one is given (AIC-102)", async () => {
      const customerId = await seedCustomer("websiteurl");
      const r = await provisionConnection(pool, {
        ...base(customerId),
        destinationType: "website",
        leadEventTypes: ["offsite_conversion.fb_pixel_complete_registration"],
        trackingPixelId: "984664453249037",
        websiteUrl: "https://pisga.app/signup",
      }, null);
      const c = await pool.query<{ website_url: string | null }>(
        `SELECT website_url FROM managed_campaigns WHERE id = $1`, [r.campaignId]);
      expect(c.rows[0].website_url).toBe("https://pisga.app/signup");
    });

    it("leaves website_url null when none is given — a WhatsApp campaign needs no destination URL", async () => {
      const customerId = await seedCustomer("nourl");
      const r = await provisionConnection(pool, base(customerId), null);
      const c = await pool.query<{ website_url: string | null }>(
        `SELECT website_url FROM managed_campaigns WHERE id = $1`, [r.campaignId]);
      expect(c.rows[0].website_url).toBeNull();
    });

    // ── The completeness guard (AIC-103) ─────────────────────────────────
    it("REFUSES a website campaign missing website_url — same table resolveAdditionAvailability checks at read time", async () => {
      const customerId = await seedCustomer("incompletewebsite");
      await expect(
        provisionConnection(pool, {
          ...base(customerId),
          destinationType: "website",
          leadEventTypes: ["offsite_conversion.fb_pixel_complete_registration"],
          trackingPixelId: "984664453249037",
          websiteUrl: null,
        }, null),
      ).rejects.toBeInstanceOf(IncompleteProvisioningError);
    });

    it("REFUSES a whatsapp campaign missing whatsappDestination — this was NEVER a field before AIC-103, so every prior provision silently left it ''", async () => {
      const customerId = await seedCustomer("incompletewa");
      await expect(
        provisionConnection(pool, { ...base(customerId), whatsappDestination: null }, null),
      ).rejects.toBeInstanceOf(IncompleteProvisioningError);
    });

    it("the completeness refusal writes NOTHING — no half-provisioned connection left behind", async () => {
      const customerId = await seedCustomer("incompleteatomic");
      await expect(
        provisionConnection(pool, { ...base(customerId), whatsappDestination: "" }, null),
      ).rejects.toThrow();
      const conns = await pool.query(`SELECT id FROM meta_connections WHERE customer_id = $1`, [customerId]);
      expect(conns.rows).toHaveLength(0);
    });

    it("saves whatsapp_destination once it's actually provided — previously never written at all", async () => {
      const customerId = await seedCustomer("wadest");
      const r = await provisionConnection(pool, { ...base(customerId), whatsappDestination: "972501234567" }, null);
      const c = await pool.query<{ whatsapp_destination: string }>(
        `SELECT whatsapp_destination FROM managed_campaigns WHERE id = $1`, [r.campaignId]);
      expect(c.rows[0].whatsapp_destination).toBe("972501234567");
    });

    // ── The guard (AIC-69) ──────────────────────────────────────────────
    it("REFUSES to save a page_id the backend cannot read", async () => {
      const customerId = await seedCustomer("pagegate");
      await expect(
        provisionConnection(pool, { ...base(customerId), pageId: "999" }, NOT_SHARED),
      ).rejects.toBeInstanceOf(PageNotReadableError);
    });

    it("refuses an unverified page_id too — absence of proof is not proof", async () => {
      const customerId = await seedCustomer("pageunverified");
      await expect(
        provisionConnection(pool, { ...base(customerId), pageId: "999" }, null),
      ).rejects.toBeInstanceOf(PageNotReadableError);
    });

    it("the refusal writes NOTHING — no half-provisioned connection left behind", async () => {
      const customerId = await seedCustomer("pageatomic");
      await expect(
        provisionConnection(pool, { ...base(customerId), pageId: "999" }, NOT_SHARED),
      ).rejects.toThrow();

      // A partial write here would be worse than the original bug: a
      // connection with no campaign is invisible to every consumer.
      const conns = await pool.query(`SELECT id FROM meta_connections WHERE customer_id = $1`, [customerId]);
      expect(conns.rows).toHaveLength(0);
    });

    it("saves the page_id once the Page read genuinely passes", async () => {
      const customerId = await seedCustomer("pageok");
      const r = await provisionConnection(pool, { ...base(customerId), pageId: "1216278568228263" }, OK);
      expect(r.pageIdSaved).toBe(true);
      const conn = await pool.query<{ page_id: string }>(`SELECT page_id FROM meta_connections WHERE id = $1`, [r.connectionId]);
      expect(conn.rows[0].page_id).toBe("1216278568228263");
    });

    it("a connected campaign has no create_campaign history, so it reads as not-built-here", async () => {
      const customerId = await seedCustomer("origin");
      const r = await provisionConnection(pool, base(customerId), null);
      const h = await pool.query(
        `SELECT 1 FROM action_history WHERE campaign_id = $1 AND action_type = 'create_campaign'`,
        [r.campaignId],
      );
      // wasBuiltHere is derived from this row's absence — the customer gets
      // "we found your campaign on Meta", not a false "we built it".
      expect(h.rows).toHaveLength(0);
    });
  });
});
