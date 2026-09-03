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
  CampaignAlreadyLinkedError,
  PageNotReadableError,
  IncompleteProvisioningError,
  InstagramNotReadableError,
} from "./customer-onboarding.js";
import { startBuilderCampaign } from "../builder/campaign-create.js";
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
  beforeAll(() => { process.env.JWT_SECRET ||= "test-secret-onboarding-padding-to-32-chars-minimum"; });
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

    // AIC-162, found live on a real customer. managed_campaigns is
    // UNIQUE (customer_id). The connect-only branch writes a SHELL row (budget
    // only, meta_campaign_id NULL) and hands off to the builder; an operator
    // who then changed their mind and adopted an existing campaign hit the
    // constraint, and that customer became permanently un-provisionable
    // through the wizard. The failure surfaced as a raw Postgres string, in
    // the page header, a screen above the button they pressed.
    it("adopts INTO an existing unlinked shell instead of failing on the unique constraint", async () => {
      const customerId = await seedCustomer("adoptshell");
      // Exactly what "צור קמפיין חדש" leaves behind.
      await provisionConnection(pool, {
        customerId,
        systemUserId: "122103498795426897",
        metaAdAccountId: `act_it_${customerId.slice(0, 8)}`,
        agreedBudgetAgorot: 1500,
      }, null);
      const shell = await pool.query<{ id: string; meta_campaign_id: string | null }>(
        `SELECT id, meta_campaign_id FROM managed_campaigns WHERE customer_id = $1`, [customerId]);
      expect(shell.rows).toHaveLength(1);
      expect(shell.rows[0].meta_campaign_id).toBeNull();

      const r = await provisionConnection(pool, base(customerId), null);

      // The SAME row, now linked — not a second one, and not a failure.
      expect(r.campaignId).toBe(shell.rows[0].id);
      const after = await pool.query(
        `SELECT meta_campaign_id, name, status, agreed_budget_agorot FROM managed_campaigns WHERE customer_id = $1`,
        [customerId]);
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]).toMatchObject({
        meta_campaign_id: `camp_${customerId.slice(0, 8)}`,
        name: "IT Campaign",
        status: "active",
        agreed_budget_agorot: 2000,
      });
    });

    // AIC-186 changed what "already linked" means. Adopting a DIFFERENT Meta
    // campaign beside an existing one used to be refused by the UNIQUE
    // constraint; that refusal was the constraint speaking, not a decision,
    // and it is exactly what stopped a customer connecting their engagement
    // campaign. Adopting the SAME one twice is still refused.
    it("adds a SECOND campaign rather than refusing, and never repoints the first", async () => {
      const customerId = await seedCustomer("adoptsecond");
      const first = await provisionConnection(pool, base(customerId), null);

      const second = await provisionConnection(
        pool, { ...base(customerId), metaCampaignId: "camp_engagement", destinationType: "engagement", leadEventTypes: ["post_engagement"] }, null,
      );
      expect(second.campaignId).not.toBe(first.campaignId);

      const rows = await pool.query<{ meta_campaign_id: string; destination: string }>(
        `SELECT meta_campaign_id, destination FROM managed_campaigns WHERE customer_id = $1 ORDER BY created_at`,
        [customerId],
      );
      expect(rows.rows).toHaveLength(2);
      // THE SAFETY PROPERTY, unchanged: the first campaign still points where
      // it did. Repointing a live campaign at a different Meta id changes
      // whose numbers we report, with nobody deciding to, and is invisible
      // until the figures move.
      expect(rows.rows[0].meta_campaign_id).toBe(`camp_${customerId.slice(0, 8)}`);
      expect(rows.rows[1].meta_campaign_id).toBe("camp_engagement");
      expect(rows.rows[1].destination).toBe("engagement");
    });

    it("REFUSES to link the SAME Meta campaign twice", async () => {
      // Two rows for one Meta object is how a dashboard starts double-counting
      // spend.
      const customerId = await seedCustomer("adoptdup");
      await provisionConnection(pool, base(customerId), null);
      await expect(
        provisionConnection(pool, base(customerId), null),
      ).rejects.toBeInstanceOf(CampaignAlreadyLinkedError);

      const rows = await pool.query(`SELECT 1 FROM managed_campaigns WHERE customer_id = $1`, [customerId]);
      expect(rows.rows).toHaveLength(1);
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

    // ── AIC-108: instagram_id carries the SAME engine-stopping risk as
    // page_id (ConnectionService.verify folds both into worst-health-wins,
    // and classifyGraphError maps a bad id to `revoked`) but had no gate.
    // Confirmed live 2026-08-19: typo'd id → Graph code 100, not-ours id →
    // code 10, both in PERMISSION_CODES.
    describe("instagram gate (AIC-108)", () => {
      it("blank Instagram saves normally — no check, no risk", async () => {
        const customerId = await seedCustomer("iblank");
        const r = await provisionConnection(pool, base(customerId), null);
        const conn = await pool.query<{ instagram_id: string | null }>(
          `SELECT instagram_id FROM meta_connections WHERE id = $1`, [r.connectionId]);
        expect(conn.rows[0].instagram_id).toBeNull();
      });

      it("REFUSES an Instagram id the backend cannot read", async () => {
        const customerId = await seedCustomer("ibad");
        await expect(
          provisionConnection(pool, { ...base(customerId), instagramId: "17841400000000000" }, null, NOT_SHARED),
        ).rejects.toBeInstanceOf(InstagramNotReadableError);
      });

      it("refuses an UNVERIFIED Instagram id too — absence of proof is not proof", async () => {
        const customerId = await seedCustomer("iunver");
        await expect(
          provisionConnection(pool, { ...base(customerId), instagramId: "17841400000000000" }, null, null),
        ).rejects.toBeInstanceOf(InstagramNotReadableError);
      });

      it("the refusal writes NOTHING — no half-provisioned connection left behind", async () => {
        const customerId = await seedCustomer("iatomic");
        await expect(
          provisionConnection(pool, { ...base(customerId), instagramId: "999" }, null, NOT_SHARED),
        ).rejects.toThrow();
        const conns = await pool.query(`SELECT id FROM meta_connections WHERE customer_id = $1`, [customerId]);
        expect(conns.rows).toHaveLength(0);
      });

      it("saves the instagram_id once the read genuinely passes", async () => {
        const customerId = await seedCustomer("iok");
        const r = await provisionConnection(pool, { ...base(customerId), instagramId: "17841405309211844" }, null, OK);
        const conn = await pool.query<{ instagram_id: string }>(
          `SELECT instagram_id FROM meta_connections WHERE id = $1`, [r.connectionId]);
        expect(conn.rows[0].instagram_id).toBe("17841405309211844");
      });

      it("a bad Instagram id blocks the save even when the Page is perfectly fine", async () => {
        const customerId = await seedCustomer("ipageok");
        await expect(
          provisionConnection(
            pool,
            { ...base(customerId), pageId: "1216278568228263", instagramId: "999" },
            OK,   // Page verified
            NOT_SHARED, // Instagram not
          ),
        ).rejects.toBeInstanceOf(InstagramNotReadableError);
      });
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

    // AIC-105 Branch A, found live on a real onboarding call: "צור קמפיין
    // חדש" provisions the connection alone (no campaign fields), then sends
    // the operator into the builder — which can end with them back on this
    // exact screen (e.g. clicking "back" before finishing). Clicking the
    // button again re-runs the SAME connect-only provision for a customer
    // who now already has a meta_connections row, which — before this fix —
    // hit `meta_connections`'s raw UNIQUE(customer_id) constraint as an
    // unhandled 500, not a designed outcome.
    describe("Branch A — connecting an account with no campaign is idempotent", () => {
      const connectOnly = (customerId: string, overrides: Record<string, unknown> = {}) => ({
        customerId,
        systemUserId: "122103498795426897",
        metaAdAccountId: `act_it_${customerId.slice(0, 8)}`,
        ...overrides,
      });

      // AIC-106 gap, found live on a real onboarding call: the budget
      // ceiling refuses a build with no agreed ceiling, but "צור קמפיין
      // חדש" (Branch A's connect-only provision) never asked for one, and
      // nothing else in the wizard did either — the operator filled the
      // ENTIRE builder wizard (goal, destination, budget, audience,
      // placements, 3 ads) and only discovered the missing ceiling on the
      // final click. That budget is the PROPOSED spend, not the AGREED
      // ceiling — the two must never be conflated (that conflation was
      // half of the original AIC-106 bug).
      it("connect-only provisioning with an agreed budget pre-creates the builder's shell row, ceiling included", async () => {
        const customerId = await seedCustomer("branchabudget");
        const r = await provisionConnection(pool, connectOnly(customerId, { agreedBudgetAgorot: 2000 }), null);
        expect(r.campaignId).toBeNull(); // still no CAMPAIGN — only the shell row exists

        const { id: shellId } = await startBuilderCampaign(pool, customerId, r.adAccountRowId);
        const { rows } = await pool.query(
          `SELECT meta_campaign_id, agreed_budget_agorot FROM managed_campaigns WHERE id = $1`,
          [shellId],
        );
        // startBuilderCampaign must find the PRE-EXISTING row (idempotent
        // reuse), not create a fresh one that silently drops the budget.
        expect(rows[0].meta_campaign_id).toBeNull();
        expect(Number(rows[0].agreed_budget_agorot)).toBe(2000);
      });

      it("connect-only provisioning with NO budget behaves exactly as before — no shell row, no crash", async () => {
        const customerId = await seedCustomer("branchanobudget");
        const r = await provisionConnection(pool, connectOnly(customerId), null);
        expect(r.campaignId).toBeNull();
        const { rows } = await pool.query(`SELECT id FROM managed_campaigns WHERE customer_id = $1`, [customerId]);
        expect(rows).toHaveLength(0);
      });

      it("re-provisioning connect-only with a budget updates the shell row's ceiling rather than erroring", async () => {
        const customerId = await seedCustomer("branchabudgetretry");
        await provisionConnection(pool, connectOnly(customerId, { agreedBudgetAgorot: 1500 }), null);
        const second = await provisionConnection(pool, connectOnly(customerId, { agreedBudgetAgorot: 3000 }), null);
        expect(second.campaignId).toBeNull();
        const { rows } = await pool.query(
          `SELECT agreed_budget_agorot FROM managed_campaigns WHERE customer_id = $1`,
          [customerId],
        );
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].agreed_budget_agorot)).toBe(3000);
      });

      it("a second connect-only call for the same customer + ad account reuses the same rows, not a crash", async () => {
        const customerId = await seedCustomer("branchaidempotent");
        const first = await provisionConnection(pool, connectOnly(customerId), null);
        expect(first.campaignId).toBeNull();

        const second = await provisionConnection(pool, connectOnly(customerId), null);
        expect(second.connectionId).toBe(first.connectionId);
        expect(second.adAccountRowId).toBe(first.adAccountRowId);

        const conns = await pool.query(`SELECT id FROM meta_connections WHERE customer_id = $1`, [customerId]);
        expect(conns.rows).toHaveLength(1);
      });

      it("connecting a SECOND, different ad account for an already-connected customer adds a row under the same connection", async () => {
        const customerId = await seedCustomer("branchasecondacct");
        const first = await provisionConnection(pool, connectOnly(customerId), null);
        const second = await provisionConnection(
          pool, connectOnly(customerId, { metaAdAccountId: `act_it_other_${customerId.slice(0, 8)}` }), null,
        );

        expect(second.connectionId).toBe(first.connectionId);
        expect(second.adAccountRowId).not.toBe(first.adAccountRowId);
        const accts = await pool.query(`SELECT id FROM ad_accounts WHERE connection_id = $1`, [first.connectionId]);
        expect(accts.rows).toHaveLength(2);
      });

      it("a verified page id fills in on the existing connection if it didn't have one yet", async () => {
        const customerId = await seedCustomer("branchapagefillin");
        const first = await provisionConnection(pool, connectOnly(customerId), null);
        expect(first.pageIdSaved).toBe(false);

        const second = await provisionConnection(
          pool, connectOnly(customerId, { pageId: "1216278568228263" }), OK,
        );
        expect(second.pageIdSaved).toBe(true);
        const conn = await pool.query<{ page_id: string }>(`SELECT page_id FROM meta_connections WHERE id = $1`, [first.connectionId]);
        expect(conn.rows[0].page_id).toBe("1216278568228263");
      });
    });
  });
});
