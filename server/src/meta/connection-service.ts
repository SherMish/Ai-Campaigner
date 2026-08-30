import type { AccessHealth } from "@aic/shared";
import type { MetaClient, AssetAccessResult } from "./types.js";
import type { ConnectionStore } from "./connection-store.js";

// Thrown by assertExecutable when access is not healthy. The execute pipeline
// (P0.3) catches this to halt any spend/delivery change while access is lost.
export class AccessHaltedError extends Error {
  constructor(
    public readonly connectionId: string,
    public readonly health: AccessHealth,
  ) {
    super(`execution halted: connection ${connectionId} is '${health}', not 'ok'`);
    this.name = "AccessHaltedError";
  }
}

// Priority for combining per-asset results into one connection health. Anything
// worse than ok wins; the most specific reason (invalid > revoked) is preferred
// so the ops-queue detail is actionable.
const HEALTH_PRIORITY: Record<AccessHealth, number> = {
  ok: 0,
  needs_reconnect: 1,
  revoked: 2,
  invalid: 3,
};

export function worstHealth(list: AccessHealth[]): AccessHealth {
  return list.reduce<AccessHealth>(
    (worst, h) => (HEALTH_PRIORITY[h] > HEALTH_PRIORITY[worst] ? h : worst),
    "ok",
  );
}

export class ConnectionService {
  constructor(
    private readonly store: ConnectionStore,
    private readonly client: MetaClient,
    private readonly now: () => Date = () => new Date(),
    // Injected rather than imported so this class stays pure for its unit
    // tests, which already run without any analytics side effect.
    private readonly onHealthChange?: (change: {
      customerId: string;
      from: AccessHealth;
      to: AccessHealth;
    }) => void,
  ) {}

  // Check every granted asset, fold into one health, persist, and on any loss
  // move the connection to the (non-ok) health, raise an ops item, and record
  // it. Returns the resulting health. Idempotent: re-running with unchanged
  // access only refreshes last_verified_at and raises no duplicate ops item.
  async verify(connectionId: string): Promise<AccessHealth> {
    const conn = await this.store.getConnection(connectionId);
    if (!conn) throw new Error(`connection ${connectionId} not found`);

    const checks: AssetAccessResult[] = [];
    if (conn.adAccountMetaId) {
      checks.push(
        await this.client.verifyAssetAccess("ad_account", conn.adAccountMetaId),
      );
    }
    if (conn.pageId) {
      checks.push(await this.client.verifyAssetAccess("page", conn.pageId));
    }
    if (conn.instagramId) {
      checks.push(
        await this.client.verifyAssetAccess("instagram", conn.instagramId),
      );
    }

    // AIC-150. Fold only the checks that actually ANSWERED. An `unknown` is
    // the absence of a verdict, and it must not become one in either
    // direction:
    //
    //   * as a loss — one `fetch failed` used to flip a live customer to
    //     `needs_reconnect`, putting "איבדנו גישה לחשבון Meta" and a reconnect
    //     button on their dashboard and halting execution;
    //   * as an all-clear — folding it into `worstHealth` as a non-value made
    //     it score below `ok`, so an unreachable ad account would have quietly
    //     cleared a REAL prior revocation. The compiler caught this one when
    //     `unknown` entered the type; nothing else would have.
    //
    // A definite non-ok still wins immediately: knowing the page grant is gone
    // is knowledge, whatever happened to the other call.
    const definite = checks.filter(
      (c): c is AssetAccessResult & { health: AccessHealth } => c.health !== "unknown",
    );
    const unreachable = checks.filter((c) => c.health === "unknown");
    const definiteWorst = worstHealth(definite.map((c) => c.health));

    if (unreachable.length > 0 && definiteWorst === "ok") {
      // Nothing is written — not the health, not last_verified_at, which would
      // claim a verification that never happened. The previous answer stands
      // until we can actually ask again.
      console.warn(
        `[connection] ${connectionId}: could not verify ${unreachable
          .map((c) => `${c.kind}${c.detail ? ` (${c.detail})` : ""}`)
          .join("; ")} — leaving access_health '${conn.accessHealth}' unchanged`,
      );
      return conn.accessHealth;
    }

    const health = definiteWorst;
    const at = this.now();
    const previous = conn.accessHealth;

    if (health === previous) {
      await this.store.touchVerified(connectionId, at);
      return health;
    }

    await this.store.updateHealth(connectionId, health, at);

    // AIC-28: a real transition, either direction, recorded where the column
    // changes. `unknown` never reaches here (see the fold above), so a network
    // blip can never look like a customer losing their connection.
    this.onHealthChange?.({ customerId: conn.customerId, from: previous, to: health });

    if (health !== "ok") {
      const reasons = checks
        .filter((c) => c.health !== "ok")
        .map((c) => `${c.kind}:${c.health}${c.detail ? ` (${c.detail})` : ""}`)
        .join("; ");
      await this.store.raiseOpsItem({
        customerId: conn.customerId,
        type: "meta_connection_failure",
        severity: "high",
        detail: `access '${previous}' → '${health}': ${reasons}`,
      });
    }

    return health;
  }

  // Safety guard for the execute pipeline (P0.3): throws unless access is ok.
  // Reads current persisted health (not a live call) so it's cheap to call
  // before every write.
  async assertExecutable(connectionId: string): Promise<void> {
    const conn = await this.store.getConnection(connectionId);
    if (!conn) throw new Error(`connection ${connectionId} not found`);
    if (conn.accessHealth !== "ok") {
      throw new AccessHaltedError(connectionId, conn.accessHealth);
    }
  }
}
