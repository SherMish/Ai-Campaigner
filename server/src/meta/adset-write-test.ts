import type { Logger } from "../services/logger.js";
import { GraphCampaignAdapter } from "./campaign-adapter.js";

// AIC-36 live proof for the pause_adset WRITE (the AIC-12/13 discipline: prove it
// on live Meta, don't ship it mock-only). Reversible round-trip on GelNails: read
// an ACTIVE ad set → pause it → verify paused → un-pause → verify active. Net zero
// change. Gated by META_ADSET_WRITE_TEST; targets META_TEST_CAMPAIGN_ID or the
// GelNails campaign by default. Remove the env var after reading the logs.
const GELNAILS = "120249004871310352";

export async function runAdsetWriteTest(log: Logger): Promise<void> {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  const ver = process.env.META_GRAPH_VERSION || "v21.0";
  const campaignId = process.env.META_TEST_CAMPAIGN_ID || GELNAILS;
  if (!token) {
    log.error("[adset-write-test] META_SYSTEM_USER_TOKEN not set");
    return;
  }
  log.info(`[adset-write-test] ── reversible pause_adset round-trip on ${campaignId} ──`);
  try {
    const adapter = new GraphCampaignAdapter(token, ver);
    const before = await adapter.getCampaignState(campaignId);
    const entries = Object.entries(before.adSetStatuses);
    log.info(`[adset-write-test] ad set statuses: ${JSON.stringify(before.adSetStatuses)}`);

    const active = entries.find(([, s]) => s === "active");
    if (!active) {
      log.error("[adset-write-test] no ACTIVE ad set to round-trip — skipping");
      return;
    }
    const adSetId = active[0];
    log.info(`[adset-write-test] target ad set ${adSetId} (currently active)`);

    // pause → verify
    await adapter.pauseAdSet(adSetId);
    const paused = (await adapter.getCampaignState(campaignId)).adSetStatuses[adSetId];
    log.info(`[adset-write-test] after pause: ${adSetId} = ${paused}`);

    // un-pause → verify (restore)
    await adapter.setAdSetStatus(adSetId, "ACTIVE");
    const restored = (await adapter.getCampaignState(campaignId)).adSetStatuses[adSetId];
    log.info(`[adset-write-test] after un-pause: ${adSetId} = ${restored}`);

    const pass = paused === "paused" && restored === "active";
    log.info(`[adset-write-test] RESULT=${pass ? "PASS ✅ — pause landed and was reversed, net zero change" : "FAIL"}`);
  } catch (e) {
    log.error(`[adset-write-test] error: ${(e as Error).message}`);
    log.info("[adset-write-test] RESULT=FAIL");
  }
}
