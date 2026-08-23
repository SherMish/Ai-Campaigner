// DB integration for the builder's idempotent create-writes (AIC-50). Requires
// DATABASE_URL; self-skips otherwise. No live Meta call — FakeBuilderWriter
// stands in; the real adapter shape is verified by the live dogfood test.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { FIXED_DESTINATION, WEBSITE_DESTINATION } from "@aic/shared";
import { startBuilderCampaign, buildCampaignOnMeta, type BuildCampaignInput } from "./campaign-create.js";
import { FakeBuilderWriter } from "./types.js";
import { listEligibleForGeneration } from "../recommendations/generation.js";

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

  // AIC-116, the same AIC-106 leftover one field over. `launch_approved_at` was
  // caught; `status` was not. A built campaign stayed 'under_review' forever,
  // because the only thing that clears that status is an AIC-18 review — and an
  // AIC-18 review is for campaigns we did NOT build (is this imported structure
  // manageable at all?). Nobody reviews our own output, so nobody ever submits
  // one, so the status never moved.
  //
  // Asserting the eligibility rather than the string, because the string is not
  // the point: listEligibleForGeneration is the only writer of ad_meta and
  // ad_set_meta, so an ineligible campaign renders as a dashboard with no ads
  // and no audience breakdown while it spends real money. That is the failure
  // this test exists to prevent, so that is what it checks.
  it("leaves the built campaign visible to the recommendation engine", async () => {
    const { customerId, adAccountId } = await makeCustomer("eligible");
    const { id: localCampaignId } = await startProvisioned(customerId, adAccountId);
    const writer = new FakeBuilderWriter();

    await buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId));

    // The other three eligibility gates, stated explicitly rather than inherited
    // from the fixture: automation_enabled and meta_campaign_id the build itself
    // satisfies, but meta_connections.access_health defaults to
    // 'needs_reconnect' and only a real OAuth round-trip clears it. Setting it
    // here keeps the test pinned to the one gate it is about — status — instead
    // of failing for an unrelated reason if a default changes.
    await pool.query(
      `UPDATE meta_connections SET access_health = 'ok' WHERE customer_id = $1`,
      [customerId],
    );

    const eligible = await listEligibleForGeneration(pool);
    expect(eligible.map((c) => c.id)).toContain(localCampaignId);
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

  // Rollback (user decision, 2026-08-19): a build is ALL-OR-NOTHING on Meta.
  // Replaces AIC-50's resume-point design, whose reasoning rested entirely on
  // creates being PAUSED — AIC-106 made them ACTIVE the same day, so every
  // "resume point" became a live object sitting in a customer's ad account.
  // Found live: a refused ad-set create left an ACTIVE campaign with zero ad
  // sets stranded on a real customer's account.
  describe("rollback — a failed build leaves nothing behind", () => {
    it("deletes everything it created, newest first, when a later step fails", async () => {
      const { customerId, adAccountId } = await makeCustomer("rollback");
      const { id: localCampaignId } = await startProvisioned(customerId, adAccountId);
      const writer = new FakeBuilderWriter();
      writer.failNextCreateAd = 1; // campaign + ad set land, then the ad fails

      await expect(buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId))).rejects.toThrow();

      // Reverse order: children before parents. Meta cascades a campaign
      // delete, but relying on that would leave the ad set orphaned if the
      // campaign delete were the one that failed.
      expect(writer.deleted).toEqual(["meta_adset_2", "meta_camp_1"]);
    });

    it("purges the outbox rows too — otherwise the retry resumes onto deleted ids", async () => {
      const { customerId, adAccountId } = await makeCustomer("rollbackoutbox");
      const { id: localCampaignId } = await startProvisioned(customerId, adAccountId);
      const writer = new FakeBuilderWriter();
      writer.failNextCreateAd = 1;

      await expect(buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId))).rejects.toThrow();

      // THE half that is easy to miss. The outbox remembers each created
      // object's real Meta id; deleting on Meta while leaving these rows makes
      // the next attempt "resume" onto a campaign that no longer exists —
      // exactly the deadlock that had to be cleaned up by hand in production.
      const { rows } = await pool.query(
        `SELECT idempotency_key FROM meta_write_outbox WHERE idempotency_key LIKE $1`,
        [`${localCampaignId}%`],
      );
      expect(rows).toHaveLength(0);
    });

    it("leaves the local shell row unlinked and reusable, not deleted", async () => {
      const { customerId, adAccountId } = await makeCustomer("rollbackshell");
      const { id: localCampaignId } = await startProvisioned(customerId, adAccountId, 7000);
      const writer = new FakeBuilderWriter();
      writer.failNextCreateAd = 1;

      await expect(buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId))).rejects.toThrow();

      // The operator retries into the SAME shell row, ceiling intact — the
      // agreed budget was never the builder's to discard.
      const { rows } = await pool.query(
        `SELECT meta_campaign_id, agreed_budget_agorot FROM managed_campaigns WHERE id = $1`,
        [localCampaignId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].meta_campaign_id).toBeNull();
      expect(Number(rows[0].agreed_budget_agorot)).toBe(7000);
    });

    it("a cleanup failure never masks the ORIGINAL error", async () => {
      const { customerId, adAccountId } = await makeCustomer("rollbackcleanupfail");
      const { id: localCampaignId } = await startProvisioned(customerId, adAccountId);
      const writer = new FakeBuilderWriter();
      writer.failNextCreateAd = 1;
      writer.failDeletes = true; // every delete call throws

      // The operator must still see WHY the build failed, not a cleanup error.
      await expect(buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId)))
        .rejects.toThrow(/simulated Meta create-ad failure/);
    });

    it("a successful build deletes nothing", async () => {
      const { customerId, adAccountId } = await makeCustomer("rollbacknoop");
      const { id: localCampaignId } = await startProvisioned(customerId, adAccountId);
      const writer = new FakeBuilderWriter();

      await buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId));

      expect(writer.deleted).toEqual([]);
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

  it("creates every object ACTIVE, logs action_history for each, and links + activates the campaign on success", async () => {
    const { customerId, adAccountId } = await makeCustomer("happy");
    const { id: localCampaignId } = await startProvisioned(customerId, adAccountId);
    const writer = new FakeBuilderWriter();

    const result = await buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId));

    expect(result.metaCampaignId).toBeTruthy();
    expect(result.adSets).toHaveLength(1);
    expect(result.adSets[0].ads).toHaveLength(2);

    // (The created-ACTIVE invariant is enforced inside GraphCampaignAdapter,
    // where status=ACTIVE is hardcoded into every create call — see
    // campaign-adapter.test.ts. FakeBuilderWriter's params don't carry status
    // at all, since real customers/tests can't ever override it. This comment
    // said PAUSED until AIC-116: it was written when creation was followed by a
    // separate launch step, and AIC-106 removed that step without revisiting it.)
    expect(writer.adSetCalls).toHaveLength(1);
    expect(writer.adCalls).toHaveLength(2);

    const camp = await pool.query(`SELECT meta_campaign_id, status, name, agreed_budget_agorot FROM managed_campaigns WHERE id = $1`, [localCampaignId]);
    expect(camp.rows[0].meta_campaign_id).toBe(result.metaCampaignId);
    // AIC-116: this asserted 'under_review' with the comment "building never
    // activates" — true when written, because the build created every object
    // PAUSED and a separate launch step went live. AIC-106 made creation the
    // launch, so the campaign is live and spending the moment this UPDATE runs.
    // Leaving it 'under_review' hid it from listEligibleForGeneration
    // (generation.ts: WHERE mc.status = 'active'), which is the only writer of
    // ad_meta/ad_set_meta — so a real customer's dashboard showed no ads and no
    // audience breakdown for a campaign that was live. The status must describe
    // Meta reality, not a launch step that no longer exists.
    expect(camp.rows[0].status).toBe("active");
    // AIC-106: this line used to assert 4000 — i.e. that after a build the
    // agreed ceiling equals whatever the BUILDER proposed. That assertion was
    // codifying the bug, which is a large part of why it survived: the
    // ceiling-overwrite had a passing test defending it. The ceiling belongs
    // to provisioning, so it must still be the 10000 that was agreed.
    expect(Number(camp.rows[0].agreed_budget_agorot)).toBe(10000);

    const history = await pool.query(`SELECT action_type, target_meta_id FROM action_history WHERE campaign_id = $1 ORDER BY occurred_at`, [localCampaignId]);
    expect(history.rows.map((r) => r.action_type)).toEqual(["create_campaign", "create_ad_set", "create_ad", "create_ad"]);
  });

  // REWRITTEN 2026-08-19. This test used to assert AIC-50's resume design:
  // "resuming skips every already-created object and only retries the failed
  // step", checking that campaign/ad-set were NOT re-created on retry.
  //
  // That behaviour is deliberately gone. Its reasoning rested on creates being
  // PAUSED; AIC-106 made them ACTIVE, so every "already-created object" the
  // old test was protecting became a LIVE object stranded in a customer's ad
  // account — which is exactly what happened in production. Keeping the old
  // assertion would have been a passing test defending the thing we removed.
  //
  // The retry contract now: the first attempt rolls back to nothing, and the
  // second attempt rebuilds the whole campaign from scratch. More Meta calls
  // than resume needed — the accepted cost of never stranding a live object.
  it("after a failed build rolls back, a retry rebuilds everything cleanly", async () => {
    const { customerId, adAccountId } = await makeCustomer("resume");
    const { id: localCampaignId } = await startProvisioned(customerId, adAccountId);
    const writer = new FakeBuilderWriter();
    writer.failNextCreateAd = 1; // the FIRST ad's create fails on the first pass

    await expect(buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId))).rejects.toThrow("simulated Meta create-ad failure");

    // Attempt 1 created a campaign + ad set, then rolled both back.
    expect(writer.campaignCalls).toHaveLength(1);
    expect(writer.adSetCalls).toHaveLength(1);
    expect(writer.deleted).toEqual(["meta_adset_2", "meta_camp_1"]);

    const result = await buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId));
    expect(result.adSets[0].ads).toHaveLength(2);

    // Rebuilt from scratch — a SECOND campaign and ad set, because the first
    // pair no longer exists anywhere. This is the deliberate trade.
    expect(writer.campaignCalls).toHaveLength(2);
    expect(writer.adSetCalls).toHaveLength(2);
    expect(writer.adCalls).toHaveLength(2);

    // And nothing from attempt 1 was left behind to be deleted twice.
    expect(writer.deleted).toEqual(["meta_adset_2", "meta_camp_1"]);

    const camp = await pool.query(`SELECT meta_campaign_id FROM managed_campaigns WHERE id = $1`, [localCampaignId]);
    expect(camp.rows[0].meta_campaign_id).toBe(result.metaCampaignId);
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
