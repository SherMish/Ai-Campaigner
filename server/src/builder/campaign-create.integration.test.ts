// DB integration for the builder's idempotent create-writes (AIC-50). Requires
// DATABASE_URL; self-skips otherwise. No live Meta call — FakeBuilderWriter
// stands in; the real adapter shape is verified by the live dogfood test.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { FIXED_DESTINATION, WEBSITE_DESTINATION } from "@aic/shared";
import { startBuilderCampaign, buildCampaignOnMeta, type BuildCampaignInput } from "./campaign-create.js";
import { FakeBuilderWriter } from "./types.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function makeCustomer(tag: string): Promise<{ customerId: string; adAccountId: string }> {
  const cust = await pool.query<{ id: string }>(`INSERT INTO customers (business_name) VALUES ($1) RETURNING id`, [`__it_builder_${tag}`]);
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(`INSERT INTO meta_connections (customer_id) VALUES ($1) RETURNING id`, [customerId]);
  const acct = await pool.query<{ id: string }>(`INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`, [conn.rows[0].id, `act_bld_${conn.rows[0].id.slice(0, 8)}`]);
  return { customerId, adAccountId: acct.rows[0].id };
}

// AIC-106: a build now requires an agreed ceiling, because create fails closed
// without one. Provisioning is what sets it in production (step 4 of the
// onboarding wizard, "תקציב יומי שסוכם עם הלקוח"), so the build tests below
// have to model that rather than starting from a bare shell row. The default
// sits above baseInput's 4000 so it constrains nothing unless a test means it to.
async function startProvisioned(customerId: string, adAccountId: string, agreedAgorot = 10000) {
  const started = await startBuilderCampaign(pool, customerId, adAccountId);
  await pool.query(`UPDATE managed_campaigns SET agreed_budget_agorot = $2 WHERE id = $1`, [started.id, agreedAgorot]);
  return started;
}

function baseInput(localCampaignId: string, adAccountId: string): BuildCampaignInput {
  return {
    localCampaignId,
    adAccountId,
    pageId: "page_1",
    name: "__it_builder campaign",
    dailyBudgetAgorot: 4000,
    specialAdCategories: [],
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    destination: FIXED_DESTINATION,
    whatsappDestination: "972500000000",
    adSets: [
      {
        clientKey: "adset-1",
        name: "Adset 1",
        targeting: { ageMin: 18, ageMax: 45, genders: [], countries: ["IL"] },
        ads: [
          { clientKey: "adset-1-ad-1", name: "Ad 1", creativeId: "crea_1" },
          { clientKey: "adset-1-ad-2", name: "Ad 2", creativeId: "crea_2" },
        ],
      },
    ],
  };
}

d("campaign builder create-writes (DB)", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_builder_%'`);
    await pool.end();
  });

  // AIC-106 half 1 — the budget ceiling on CREATE.
  //
  // Today `assertWithinBudget` has exactly one caller (safe-executor.ts:142,
  // the recommendation-execution path). The create path never consults it,
  // and worse: campaign-create.ts's final UPDATE WRITES
  // `agreed_budget_agorot = input.dailyBudgetAgorot`, so the builder both
  // proposes the budget AND rewrites the ceiling to match it. The ceiling is
  // self-certifying — a mistyped number becomes its own authorisation.
  //
  // That is survivable only while the launch gate exists, because a human
  // approves before anything spends. AIC-106 removes that gate, so this has
  // to be a real ceiling first. These three cases are the contract.
  // AIC-106 — creation IS the launch now, so the row must say so. Otherwise
  // customer-overview.ts (which gates its "approve launch" state on
  // launch_approved_at IS NULL) would keep prompting a customer to approve a
  // campaign that is already live and spending — the dashboard contradicting
  // reality, which is the one thing the product cannot do.
  it("stamps launch_approved_at at build time — no lingering 'pending launch' for a live campaign", async () => {
    const { customerId, adAccountId } = await makeCustomer("launched");
    const { id: localCampaignId } = await startProvisioned(customerId, adAccountId);
    const writer = new FakeBuilderWriter();

    await buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId));

    const { rows } = await pool.query(`SELECT launch_approved_at FROM managed_campaigns WHERE id = $1`, [localCampaignId]);
    expect(rows[0].launch_approved_at).not.toBeNull();
  });

  // AIC-105 Branch A gap, found 2026-08-19. AIC-103 enforces the per-destination
  // required fields at PROVISIONING — but Branch A provisions the connection
  // with no campaign, and the builder creates the campaign afterwards. Nothing
  // re-ran the check, so the one path that produces NEW campaigns was the one
  // path whose end state was unverified.
  //
  // This is Pisga's own `website_url` failure reintroduced through the new
  // route, and AIC-106 made it worse: the campaign now goes LIVE immediately,
  // so it starts spending with a config that cannot attribute a single lead,
  // instead of sitting PAUSED where someone might notice.
  describe("per-destination required fields on create (AIC-103 x AIC-105)", () => {
    it("refuses a website build with no destination URL, before any Meta write", async () => {
      const { customerId, adAccountId } = await makeCustomer("nourl");
      const { id: localCampaignId } = await startProvisioned(customerId, adAccountId);
      const writer = new FakeBuilderWriter();
      const input: BuildCampaignInput = {
        ...baseInput(localCampaignId, adAccountId),
        destination: WEBSITE_DESTINATION,
        whatsappDestination: "",
        // destinationUrl deliberately omitted — exactly what shipped on
        // free_beta_signups_leads.
        pixelId: "984664453249037",
        conversionEvent: "COMPLETE_REGISTRATION",
      };

      await expect(buildCampaignOnMeta(pool, writer, input)).rejects.toThrow();

      const { rows } = await pool.query(`SELECT meta_campaign_id FROM managed_campaigns WHERE id = $1`, [localCampaignId]);
      expect(rows[0].meta_campaign_id).toBeNull();
    });

    it("still allows a complete website build", async () => {
      const { customerId, adAccountId } = await makeCustomer("withurl");
      const { id: localCampaignId } = await startProvisioned(customerId, adAccountId);
      const writer = new FakeBuilderWriter();
      const input: BuildCampaignInput = {
        ...baseInput(localCampaignId, adAccountId),
        destination: WEBSITE_DESTINATION,
        whatsappDestination: "",
        destinationUrl: "https://example.com/signup",
        pixelId: "984664453249037",
        conversionEvent: "COMPLETE_REGISTRATION",
      };

      const result = await buildCampaignOnMeta(pool, writer, input);
      expect(result.metaCampaignId).toBeTruthy();
    });

    it("refuses a WhatsApp build with no WhatsApp destination", async () => {
      const { customerId, adAccountId } = await makeCustomer("nowa");
      const { id: localCampaignId } = await startProvisioned(customerId, adAccountId);
      const writer = new FakeBuilderWriter();
      const input: BuildCampaignInput = { ...baseInput(localCampaignId, adAccountId), whatsappDestination: "" };

      await expect(buildCampaignOnMeta(pool, writer, input)).rejects.toThrow();
    });
  });

  describe("budget ceiling on create (AIC-106)", () => {
    // The ceiling is the figure the OPERATOR agreed with the customer at
    // provisioning, so the test sets it the way provisioning does and then
    // asks the builder for more.
    async function provisioned(tag: string, agreedAgorot: number) {
      const { customerId, adAccountId } = await makeCustomer(tag);
      const { id: localCampaignId } = await startProvisioned(customerId, adAccountId);
      await pool.query(`UPDATE managed_campaigns SET agreed_budget_agorot = $2 WHERE id = $1`, [localCampaignId, agreedAgorot]);
      return { customerId, adAccountId, localCampaignId };
    }

    it("refuses a build whose daily budget exceeds the agreed ceiling, before any Meta write", async () => {
      const { adAccountId, localCampaignId } = await provisioned("ceil-over", 2000);
      const writer = new FakeBuilderWriter();
      const input = { ...baseInput(localCampaignId, adAccountId), dailyBudgetAgorot: 9900 };

      await expect(buildCampaignOnMeta(pool, writer, input)).rejects.toThrow();

      // Refused BEFORE the first Meta call — an over-ceiling campaign must not
      // exist on Meta at all, not even PAUSED. Once the launch gate is gone
      // there is no later checkpoint that would catch it.
      const { rows } = await pool.query(`SELECT meta_campaign_id FROM managed_campaigns WHERE id = $1`, [localCampaignId]);
      expect(rows[0].meta_campaign_id).toBeNull();
    });

    it("does NOT overwrite the agreed ceiling with the builder's own number", async () => {
      const { adAccountId, localCampaignId } = await provisioned("ceil-keep", 5000);
      const writer = new FakeBuilderWriter();
      // Comfortably under the ceiling, so the build itself succeeds.
      const input = { ...baseInput(localCampaignId, adAccountId), dailyBudgetAgorot: 1500 };

      await buildCampaignOnMeta(pool, writer, input);

      // The ceiling is the operator's agreement with the customer. A build
      // spending less than agreed must not silently RATCHET IT DOWN either —
      // the agreed figure is not the builder's to edit in either direction.
      const { rows } = await pool.query(`SELECT agreed_budget_agorot FROM managed_campaigns WHERE id = $1`, [localCampaignId]);
      expect(Number(rows[0].agreed_budget_agorot)).toBe(5000);
    });

    // Measured 2026-08-19 against the shared DB: no campaign row has a NULL
    // ceiling, but 13 have `agreed = 0` — 12 `__it_*` leftovers and one real
    // customer whose connection is provisioned but whose campaign is not yet
    // built (exactly AIC-105 Branch A). So 0, not NULL, is the state that
    // actually occurs, and it must fail CLOSED: with the launch gate gone,
    // a campaign with no agreed ceiling has nothing bounding its spend.
    it("refuses to build when no ceiling was ever agreed (0), rather than treating it as unlimited", async () => {
      const { adAccountId, localCampaignId } = await provisioned("ceil-zero", 0);
      const writer = new FakeBuilderWriter();

      await expect(buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId))).rejects.toThrow();

      const { rows } = await pool.query(`SELECT meta_campaign_id FROM managed_campaigns WHERE id = $1`, [localCampaignId]);
      expect(rows[0].meta_campaign_id).toBeNull();
    });
  });

  it("startBuilderCampaign creates a shell row and is idempotent (resume finds the same row)", async () => {
    const { customerId, adAccountId } = await makeCustomer("start");
    const first = await startBuilderCampaign(pool, customerId, adAccountId);
    const second = await startBuilderCampaign(pool, customerId, adAccountId);
    expect(second.id).toBe(first.id);

    const { rows } = await pool.query(`SELECT status, meta_campaign_id FROM managed_campaigns WHERE id = $1`, [first.id]);
    expect(rows[0].status).toBe("under_review");
    expect(rows[0].meta_campaign_id).toBeNull();
  });

  it("creates every object PAUSED, logs action_history for each, and links the campaign on success", async () => {
    const { customerId, adAccountId } = await makeCustomer("happy");
    const { id: localCampaignId } = await startProvisioned(customerId, adAccountId);
    const writer = new FakeBuilderWriter();

    const result = await buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId));

    expect(result.metaCampaignId).toBeTruthy();
    expect(result.adSets).toHaveLength(1);
    expect(result.adSets[0].ads).toHaveLength(2);

    // (The created-PAUSED invariant is enforced inside GraphCampaignAdapter,
    // where status=PAUSED is hardcoded into every create call — see
    // campaign-adapter.test.ts. FakeBuilderWriter's params don't carry status
    // at all, since real customers/tests can't ever override it.)
    expect(writer.adSetCalls).toHaveLength(1);
    expect(writer.adCalls).toHaveLength(2);

    const camp = await pool.query(`SELECT meta_campaign_id, status, name, agreed_budget_agorot FROM managed_campaigns WHERE id = $1`, [localCampaignId]);
    expect(camp.rows[0].meta_campaign_id).toBe(result.metaCampaignId);
    expect(camp.rows[0].status).toBe("under_review"); // building never activates
    // AIC-106: this line used to assert 4000 — i.e. that after a build the
    // agreed ceiling equals whatever the BUILDER proposed. That assertion was
    // codifying the bug, which is a large part of why it survived: the
    // ceiling-overwrite had a passing test defending it. The ceiling belongs
    // to provisioning, so it must still be the 10000 that was agreed.
    expect(Number(camp.rows[0].agreed_budget_agorot)).toBe(10000);

    const history = await pool.query(`SELECT action_type, target_meta_id FROM action_history WHERE campaign_id = $1 ORDER BY occurred_at`, [localCampaignId]);
    expect(history.rows.map((r) => r.action_type)).toEqual(["create_campaign", "create_ad_set", "create_ad", "create_ad"]);
  });

  it("a mid-build failure is reconcilable: resuming skips every already-created object and only retries the failed step", async () => {
    const { customerId, adAccountId } = await makeCustomer("resume");
    const { id: localCampaignId } = await startProvisioned(customerId, adAccountId);
    const writer = new FakeBuilderWriter();
    writer.failNextCreateAd = 1; // the FIRST ad's create call fails first time through

    await expect(buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId))).rejects.toThrow("simulated Meta create-ad failure");

    // The campaign and the ad set already landed on Meta — confirm they're
    // NOT re-created on resume. Neither ad has succeeded yet (the first one
    // is what failed).
    expect(writer.campaignCalls).toHaveLength(1);
    expect(writer.adSetCalls).toHaveLength(1);
    expect(writer.adCalls).toHaveLength(0);

    const result = await buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId));
    expect(result.adSets[0].ads).toHaveLength(2);
    // Still only ONE call each for campaign/ad-set — resume never re-created them.
    expect(writer.campaignCalls).toHaveLength(1);
    expect(writer.adSetCalls).toHaveLength(1);
    expect(writer.adCalls).toHaveLength(2); // both ads now created, none duplicated

    const camp = await pool.query(`SELECT meta_campaign_id FROM managed_campaigns WHERE id = $1`, [localCampaignId]);
    expect(camp.rows[0].meta_campaign_id).toBeTruthy();
  });

  it("a full re-run after success makes no new Meta calls at all", async () => {
    const { customerId, adAccountId } = await makeCustomer("rerun");
    const { id: localCampaignId } = await startProvisioned(customerId, adAccountId);
    const writer = new FakeBuilderWriter();

    const first = await buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId));
    const second = await buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId));

    expect(second).toEqual(first);
    expect(writer.campaignCalls).toHaveLength(1);
    expect(writer.adSetCalls).toHaveLength(1);
    expect(writer.adCalls).toHaveLength(2);
  });

  // AIC-89: the builder can now create a WEBSITE-destination campaign, not
  // just WhatsApp — the create-path counterpart to AIC-102's additions fix.
  it("a website-destination build passes pixelId/conversionEvent to the ad set and persists website_url/lead_event_types/tracking_pixel_id", async () => {
    const { customerId, adAccountId } = await makeCustomer("website");
    const { id: localCampaignId } = await startProvisioned(customerId, adAccountId);
    const writer = new FakeBuilderWriter();

    const input: BuildCampaignInput = {
      ...baseInput(localCampaignId, adAccountId),
      destination: WEBSITE_DESTINATION,
      whatsappDestination: "",
      destinationUrl: "https://pisga.app/signup",
      pixelId: "984664453249037",
      conversionEvent: "COMPLETE_REGISTRATION",
    };
    const result = await buildCampaignOnMeta(pool, writer, input);

    expect(result.metaCampaignId).toBeTruthy();
    expect(writer.adSetCalls[0]).toMatchObject({
      destination: WEBSITE_DESTINATION,
      pixelId: "984664453249037",
      conversionEvent: "COMPLETE_REGISTRATION",
    });

    const camp = await pool.query<{ website_url: string; tracking_pixel_id: string; lead_event_types: string[]; whatsapp_destination: string }>(
      `SELECT website_url, tracking_pixel_id, lead_event_types, whatsapp_destination FROM managed_campaigns WHERE id = $1`,
      [localCampaignId],
    );
    expect(camp.rows[0].website_url).toBe("https://pisga.app/signup");
    expect(camp.rows[0].tracking_pixel_id).toBe("984664453249037");
    expect(camp.rows[0].lead_event_types).toEqual(["offsite_conversion.fb_pixel_complete_registration"]);
    expect(camp.rows[0].whatsapp_destination).toBe("");
  });

  it("REGRESSION: an unrecognized destination throws before any Meta call", async () => {
    const { customerId, adAccountId } = await makeCustomer("baddest");
    const { id: localCampaignId } = await startProvisioned(customerId, adAccountId);
    const writer = new FakeBuilderWriter();

    const input: BuildCampaignInput = { ...baseInput(localCampaignId, adAccountId), destination: "something_unrecognized" };
    await expect(buildCampaignOnMeta(pool, writer, input)).rejects.toThrow(/something_unrecognized/);
    expect(writer.campaignCalls).toHaveLength(0);
  });
});
