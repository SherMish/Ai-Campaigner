import type pg from "pg";
import type { CampaignStatus } from "@aic/shared";

export interface ControlFlags {
  automationEnabled: boolean;
  executionFrozen: boolean;
  status: CampaignStatus;
}

export class ControlHaltedError extends Error {
  constructor(public readonly campaignId: string, public readonly why: string) {
    super(`execution halted for ${campaignId}: ${why}`);
    this.name = "ControlHaltedError";
  }
}

export interface ControlStore {
  getFlags(campaignId: string): Promise<ControlFlags | null>;
  setAutomation(campaignId: string, enabled: boolean): Promise<void>;
  setExecutionFrozen(campaignId: string, frozen: boolean): Promise<void>;
  setStatus(campaignId: string, status: CampaignStatus): Promise<void>;
}

// Per-account emergency controls (PRD §23). All effective immediately (DB flags),
// no deploy. `assertExecutable` is the control gate the SafeExecutor calls before
// any Meta write — so flipping any switch halts execution on the next attempt.
export class ControlService {
  constructor(private readonly store: ControlStore) {}

  async assertExecutable(campaignId: string): Promise<void> {
    const f = await this.store.getFlags(campaignId);
    if (!f) throw new ControlHaltedError(campaignId, "campaign not found");
    if (f.status === "unmanaged") throw new ControlHaltedError(campaignId, "account is unmanaged");
    if (!f.automationEnabled) throw new ControlHaltedError(campaignId, "automation disabled");
    if (f.executionFrozen) throw new ControlHaltedError(campaignId, "execution frozen");
  }

  // Whether rule generation / acting should run at all (monitoring continues
  // regardless). Execution-frozen still allows generation but blocks execution.
  async isAutomated(campaignId: string): Promise<boolean> {
    const f = await this.store.getFlags(campaignId);
    return !!f && f.automationEnabled && f.status !== "unmanaged";
  }

  disableAutomation(campaignId: string) { return this.store.setAutomation(campaignId, false); }
  enableAutomation(campaignId: string) { return this.store.setAutomation(campaignId, true); }
  freezeExecution(campaignId: string) { return this.store.setExecutionFrozen(campaignId, true); }
  unfreezeExecution(campaignId: string) { return this.store.setExecutionFrozen(campaignId, false); }
  markUnmanaged(campaignId: string) { return this.store.setStatus(campaignId, "unmanaged"); }

  // Pause management: stop both generation and execution, keep monitoring.
  async pauseManagement(campaignId: string): Promise<void> {
    await this.store.setAutomation(campaignId, false);
    await this.store.setExecutionFrozen(campaignId, true);
  }
}

export class PgControlStore implements ControlStore {
  constructor(private readonly pool: pg.Pool) {}
  async getFlags(campaignId: string): Promise<ControlFlags | null> {
    const { rows } = await this.pool.query<{ automation_enabled: boolean; execution_frozen: boolean; status: CampaignStatus }>(
      `SELECT automation_enabled, execution_frozen, status FROM managed_campaigns WHERE id = $1`,
      [campaignId],
    );
    const r = rows[0];
    return r ? { automationEnabled: r.automation_enabled, executionFrozen: r.execution_frozen, status: r.status } : null;
  }
  async setAutomation(campaignId: string, enabled: boolean): Promise<void> {
    await this.pool.query(`UPDATE managed_campaigns SET automation_enabled = $2 WHERE id = $1`, [campaignId, enabled]);
  }
  async setExecutionFrozen(campaignId: string, frozen: boolean): Promise<void> {
    await this.pool.query(`UPDATE managed_campaigns SET execution_frozen = $2 WHERE id = $1`, [campaignId, frozen]);
  }
  async setStatus(campaignId: string, status: CampaignStatus): Promise<void> {
    await this.pool.query(`UPDATE managed_campaigns SET status = $2 WHERE id = $1`, [campaignId, status]);
  }
}

export class InMemoryControlStore implements ControlStore {
  constructor(private flags = new Map<string, ControlFlags>()) {}
  seed(campaignId: string, f: ControlFlags) { this.flags.set(campaignId, f); }
  async getFlags(campaignId: string) { return this.flags.get(campaignId) ?? null; }
  async setAutomation(campaignId: string, enabled: boolean) { const f = this.flags.get(campaignId); if (f) f.automationEnabled = enabled; }
  async setExecutionFrozen(campaignId: string, frozen: boolean) { const f = this.flags.get(campaignId); if (f) f.executionFrozen = frozen; }
  async setStatus(campaignId: string, status: CampaignStatus) { const f = this.flags.get(campaignId); if (f) f.status = status; }
}
