import type { AssetKind, AssetAccessResult, MetaClient } from "./types.js";
import { classifyGraphError, type GraphErrorBody } from "./errors.js";

const GRAPH_BASE = "https://graph.facebook.com";

// A cheap read per asset kind that fails iff we can't operate it.
function verifyPath(kind: AssetKind, id: string): string {
  switch (kind) {
    case "ad_account":
      // id is act_XXXX; account_status read requires ads_read on the account.
      return `${id}?fields=id,account_status`;
    case "page":
      return `${id}?fields=id`;
    case "instagram":
      return `${id}?fields=id`;
  }
}

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

// Real Graph API client. The System User token is sent as a Bearer header, never
// in the URL (query-string tokens leak into logs). The `fetch` impl is injected
// so tests can drive it without network.
export class GraphMetaClient implements MetaClient {
  constructor(
    private readonly token: string,
    private readonly graphVersion = process.env.META_GRAPH_VERSION || "v21.0",
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  async verifyAssetAccess(
    kind: AssetKind,
    id: string,
  ): Promise<AssetAccessResult> {
    const url = `${GRAPH_BASE}/${this.graphVersion}/${verifyPath(kind, id)}`;
    try {
      const res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (res.ok) {
        return { kind, id, health: "ok" };
      }
      const body = (await res.json().catch(() => undefined)) as
        | GraphErrorBody
        | undefined;
      const { health, detail } = classifyGraphError(res.status, body);
      return { kind, id, health, detail };
    } catch (err) {
      // Network/transport failure — unclassified; re-check next tick.
      return {
        kind,
        id,
        health: "needs_reconnect",
        detail: `network error verifying ${kind} ${id}: ${(err as Error).message}`,
      };
    }
  }
}

// Deterministic fake for tests: seed per-asset health, verify what was asked for.
export class FakeMetaClient implements MetaClient {
  public calls: Array<{ kind: AssetKind; id: string }> = [];
  constructor(
    private readonly byId: Record<string, AssetAccessResult["health"]> = {},
    private readonly fallback: AssetAccessResult["health"] = "ok",
  ) {}

  async verifyAssetAccess(
    kind: AssetKind,
    id: string,
  ): Promise<AssetAccessResult> {
    this.calls.push({ kind, id });
    const health = this.byId[id] ?? this.fallback;
    return {
      kind,
      id,
      health,
      detail: health === "ok" ? undefined : `fake:${health}`,
    };
  }
}
