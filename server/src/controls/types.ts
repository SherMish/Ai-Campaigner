// Manual object controls (AIC-66): a human directly pausing / resuming /
// archiving / deleting their own ad or ad set. Distinct from every other write
// path in the codebase:
//   - the engine proposes → the customer approves → AIC-12's SafeExecutor runs it
//   - the builder creates → always PAUSED (AIC-50), activated via AIC-53/63
//   - here, the human IS the authorization: there is no recommendation to
//     approve, so `SafeExecutor` (recommendation-bound at every step) cannot be
//     reused without inventing a fake recommendation row. We follow the same
//     discipline it does — validate → write → read-back verify → log — via the
//     per-object shape AIC-63's `activateOne` established.

// The statuses a human may set. ACTIVE/PAUSED are reversible and available to
// everyone; ARCHIVED/DELETED are destructive and admin-only (enforced at the
// route layer, not here).
export type ManualObjectStatus = "ACTIVE" | "PAUSED" | "ARCHIVED" | "DELETED";

export type ControlObjectKind = "ad" | "ad_set";

// What a manual control needs from Meta. Deliberately read + parameterized-write
// only — no create, no budget. The parameterized write is the whole point (see
// campaign-adapter.ts's "caller-supplied status" comment).
export interface ControlWriter {
  getAdStatus(adId: string): Promise<string>;
  getAdSetStatus(adSetId: string): Promise<string>;
  setAdStatus(adId: string, status: ManualObjectStatus): Promise<void>;
  setAdSetStatus(adSetId: string, status: ManualObjectStatus): Promise<void>;
  // Used to prove the object belongs to the caller's own campaign before any
  // write — never trust a client-supplied Meta id.
  getCampaignState(metaCampaignId: string): Promise<{
    adStatuses: Record<string, "active" | "paused">;
    adSetStatuses: Record<string, "active" | "paused">;
  }>;
}

// Test double, kept next to the interface in the production file — same shape
// and rationale as FakeLaunchWriter (launch/types.ts) and FakeAdditionWriter
// (additions/types.ts).
export class FakeControlWriter implements ControlWriter {
  public statuses = new Map<string, string>();
  public setAdCalls: Array<{ id: string; status: ManualObjectStatus }> = [];
  public setAdSetCalls: Array<{ id: string; status: ManualObjectStatus }> = [];
  public failNextWrite = 0;
  // What getCampaignState reports as living under the campaign.
  public campaignAds: string[] = [];
  public campaignAdSets: string[] = [];
  // Simulate Meta accepting the write but not actually applying it, so the
  // read-back verify has something real to catch.
  public ignoreNextWrite = 0;

  async getAdStatus(adId: string): Promise<string> {
    return this.statuses.get(adId) ?? "ACTIVE";
  }
  async getAdSetStatus(adSetId: string): Promise<string> {
    return this.statuses.get(adSetId) ?? "ACTIVE";
  }
  async setAdStatus(adId: string, status: ManualObjectStatus): Promise<void> {
    this.setAdCalls.push({ id: adId, status });
    await this.applyWrite(adId, status);
  }
  async setAdSetStatus(adSetId: string, status: ManualObjectStatus): Promise<void> {
    this.setAdSetCalls.push({ id: adSetId, status });
    await this.applyWrite(adSetId, status);
  }
  private async applyWrite(id: string, status: ManualObjectStatus): Promise<void> {
    if (this.failNextWrite > 0) {
      this.failNextWrite--;
      throw new Error(`fake Meta write failure for ${id}`);
    }
    if (this.ignoreNextWrite > 0) {
      this.ignoreNextWrite--;
      return; // accepted but not applied — read-back should catch it
    }
    this.statuses.set(id, status);
  }
  async getCampaignState(_metaCampaignId: string) {
    const collapse = (ids: string[]) =>
      Object.fromEntries(
        ids.map((id) => [id, (this.statuses.get(id) ?? "ACTIVE") === "ACTIVE" ? "active" : "paused"]),
      ) as Record<string, "active" | "paused">;
    return { adStatuses: collapse(this.campaignAds), adSetStatuses: collapse(this.campaignAdSets) };
  }
}
