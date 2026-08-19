import { classifyAccess, hasRequiredScopes, type AccessObservations, type AccessVerdict, type CheckedAsset } from "./access-layers.js";

// AIC-101 — the live half of the three-layer check: the actual Graph calls the
// onboarding wizard makes, one per layer, so a failing step can name WHICH
// layer is at fault instead of "connection failed".
//
// These are the exact calls `docs/META_SETUP.md`'s copy-paste verification
// block runs by hand. Moving them into the product is the whole point of the
// ticket: a wizard that only renders the instructions would reproduce the bug
// it exists to prevent (a Business Settings UI that looks correct over a
// backend with zero access).
//
// Read-only, all of them. Nothing here writes to Meta or to our DB — the
// wizard persists results separately, so a probe can be re-run freely on a
// live call without side effects.

const BASE = "https://graph.facebook.com";

export interface AccessProbeDeps {
  token: string;
  businessPortfolioId: string;
  // AIC-105 follow-up — needed to check the ad-account layer-2 signal (see
  // adAccountAssignedUserIds below): we're looking FOR this specific id
  // inside an account's own assigned_users list.
  systemUserId: string;
  ver?: string;
  // Injectable purely so tests can drive every failure mode without a network.
  fetchImpl?: typeof fetch;
}

export interface AssetProbeResult {
  asset: CheckedAsset;
  id: string;
  verdict: AccessVerdict;
  observations: AccessObservations;
  // Raw detail for the operator's "technical details" disclosure — never the
  // primary message, but a real Graph error beats a shrug when something
  // lands outside the three layers.
  detail: string | null;
}

export class AccessProbe {
  private readonly ver: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly deps: AccessProbeDeps) {
    this.ver = deps.ver || process.env.META_GRAPH_VERSION || "v21.0";
    this.doFetch = deps.fetchImpl ?? fetch;
  }

  private async get(pathAndQuery: string): Promise<{ ok: boolean; body: Record<string, unknown> }> {
    try {
      const r = await this.doFetch(`${BASE}/${this.ver}/${pathAndQuery}`, {
        headers: { Authorization: `Bearer ${this.deps.token}` },
      });
      const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: r.ok, body };
    } catch (e) {
      // A network failure is NOT an access failure. Returning ok:false with an
      // empty body would look identical to "Meta says no" — the caller keeps
      // the observation `null` (unknown) in that case rather than reporting a
      // confident denial.
      return { ok: false, body: { __transport: (e as Error).message } };
    }
  }

  // Layer 3 — what scopes does this token actually carry? Frozen at mint time;
  // this is the one failure that asset assignment can never fix.
  async tokenScopes(): Promise<string[] | null> {
    const { ok, body } = await this.get(
      `debug_token?input_token=${encodeURIComponent(this.deps.token)}`,
    );
    if (!ok) return null;
    const data = body.data as { scopes?: string[] } | undefined;
    return Array.isArray(data?.scopes) ? data!.scopes! : null;
  }

  // Layer 1 — did the customer's share actually land in OUR portfolio?
  private async sharedIds(asset: CheckedAsset): Promise<string[] | null> {
    // AIC-108: an IG Business account is shared THROUGH its connected Page,
    // not as a portfolio asset of its own — there is no
    // `client_instagram_accounts` edge to ask. null = unknown, which
    // classifyAccess already handles; inventing `false` here would tell the
    // operator the customer never shared it, which we do not know.
    if (asset === "instagram") return null;
    const edge = asset === "page" ? "client_pages" : "client_ad_accounts";
    const { ok, body } = await this.get(
      `${this.deps.businessPortfolioId}/${edge}?fields=id,name&limit=200`,
    );
    if (!ok) return null;
    const data = body.data as Array<{ id?: string }> | undefined;
    return Array.isArray(data) ? data.map((d) => String(d.id ?? "")) : null;
  }

  // Layer 2 (Page) — can the System User actually see it? `/me/accounts`
  // lists every Page the calling identity is associated with.
  private async systemUserPageIds(): Promise<string[] | null> {
    const { ok, body } = await this.get(`me/accounts?fields=id,name,tasks&limit=200`);
    if (!ok) return null;
    const data = body.data as Array<{ id?: string }> | undefined;
    return Array.isArray(data) ? data.map((d) => String(d.id ?? "")) : null;
  }

  // Layer 2 (ad account) — AIC-105 follow-up. Meta has no self-scoped
  // "which ad accounts am I assigned to" edge the way Pages have
  // `/me/accounts`, so this checks the same fact from the other direction:
  // does THIS SPECIFIC account's own (business-scoped) assigned_users list
  // include our System User? Live-verified against the real
  // act_2181076988590009 account (2026-08-18) — returns our System User id
  // with its granted tasks (DRAFT/ANALYZE/ADVERTISE/MANAGE).
  //
  // A failed call (missing permission, transient error) returns null —
  // unknown, same discipline as every other layer here — never a confident
  // "not assigned" from an ambiguous read.
  private async adAccountAssignedUserIds(id: string): Promise<string[] | null> {
    const { ok, body } = await this.get(
      `${id}/assigned_users?fields=id&business=${this.deps.businessPortfolioId}`,
    );
    if (!ok) return null;
    const data = body.data as Array<{ id?: string }> | undefined;
    return Array.isArray(data) ? data.map((d) => String(d.id ?? "")) : null;
  }

  // The call that actually matters, and the same one the connection health
  // check makes. A pass here is what makes it safe to persist the id (AIC-69).
  private async directRead(asset: CheckedAsset, id: string): Promise<{ ok: boolean; detail: string | null }> {
    const path = asset === "page"
      ? `${id}?fields=id,name`
      : asset === "instagram"
        // Mirrors verifyPath("instagram") in client.ts — the read whose
        // failure is what would flip the connection to `revoked`. Asking for
        // `username` too makes the operator-facing detail recognisable.
        ? `${id}?fields=id,username`
        : `${id}?fields=name,account_status,business`;
    const { ok, body } = await this.get(path);
    if (ok) return { ok: true, detail: null };
    const err = body.error as { message?: string } | undefined;
    return { ok: false, detail: err?.message ?? JSON.stringify(body).slice(0, 300) };
  }

  // One asset, all three layers + the ground-truth read, folded into a verdict.
  async probeAsset(asset: CheckedAsset, id: string): Promise<AssetProbeResult> {
    const [scopes, shared, suPages, suAdAccountUsers, read] = await Promise.all([
      this.tokenScopes(),
      this.sharedIds(asset),
      asset === "page" ? this.systemUserPageIds() : Promise.resolve(null),
      asset === "ad_account" ? this.adAccountAssignedUserIds(id) : Promise.resolve(null),
      this.directRead(asset, id),
    ]);

    // Normalize the id both ways: Meta returns ad accounts as `act_123` on
    // some edges and bare `123` on others, and a false "not shared" here
    // would send the customer to redo a grant they already did correctly.
    const bare = id.replace(/^act_/, "");
    const matches = (list: string[] | null) =>
      list === null ? null : list.some((x) => x === id || x.replace(/^act_/, "") === bare);

    const observations: AccessObservations = {
      sharedToPortfolio: matches(shared),
      assignedToSystemUser: asset === "page"
        ? matches(suPages)
        : (suAdAccountUsers === null ? null : suAdAccountUsers.includes(this.deps.systemUserId)),
      tokenHasScopes: scopes === null ? null : hasRequiredScopes(asset, scopes),
      directReadOk: read.ok,
    };

    return { asset, id, verdict: classifyAccess(observations), observations, detail: read.detail };
  }
}
