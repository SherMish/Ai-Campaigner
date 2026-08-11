// The launch gate's write surface (AIC-53) — separate from BuilderWriter
// (AIC-50, always PAUSED) and from ExecWriter (recommendation approvals):
// this is the ONE place a Meta campaign can move PAUSED → ACTIVE, and it's
// deliberately a single-purpose method with no caller-supplied status, the
// same "hard rule enforced in the adapter" pattern createCampaign/createAdSet/
// createAd use for PAUSED. Implemented by GraphCampaignAdapter alongside its
// other roles.

export type MetaCampaignStatus = "ACTIVE" | "PAUSED" | "ARCHIVED" | "DELETED" | string;

export interface LaunchWriter {
  getCampaignStatus(metaCampaignId: string): Promise<MetaCampaignStatus>;
  // The only method that can set a campaign ACTIVE. No status parameter —
  // there is no other value this is allowed to write.
  activateCampaign(metaCampaignId: string): Promise<void>;
}

// Deterministic fake for tests: starts every campaign PAUSED, records
// activate() calls, can be told to fail the next call or to report a
// specific status.
export class FakeLaunchWriter implements LaunchWriter {
  public statuses = new Map<string, MetaCampaignStatus>();
  public activateCalls: string[] = [];
  public failNextActivate = 0;

  async getCampaignStatus(metaCampaignId: string): Promise<MetaCampaignStatus> {
    return this.statuses.get(metaCampaignId) ?? "PAUSED";
  }
  async activateCampaign(metaCampaignId: string): Promise<void> {
    if (this.failNextActivate > 0) {
      this.failNextActivate--;
      throw new Error("simulated Meta activate failure");
    }
    this.activateCalls.push(metaCampaignId);
    this.statuses.set(metaCampaignId, "ACTIVE");
  }
}
