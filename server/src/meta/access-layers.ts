// AIC-101 — the three layers of Meta access, as a checkable model.
//
// The lesson `docs/META_SETUP.md` records, and the reason this module exists:
//
//   > the Business Settings UI can look completely correct while the backend
//   > still has zero access
//
// Meta access is THREE independent layers. Only the third is observable from
// our side without asking, and each fails in a way that looks identical from
// the operator's chair unless you check them separately:
//
//   1  asset shared to our Business Portfolio   — the CUSTOMER does this
//   2  asset assigned to our System User        — WE do this
//   3  token carries the right scopes           — WE do this, AT MINT TIME
//
// Layer 3 is the trap: a System User token's scopes are frozen when it is
// minted. Assigning a new asset TYPE later (e.g. adding Pages to a token
// minted for ads only) does NOT retroactively add scopes — the token keeps
// failing forever, no matter how correct layers 1 and 2 look. That is a token
// regeneration + secret rotation, and it is not inferable from the error
// message, so the diagnosis below has to say it outright.
//
// This module is PURE: it takes the four raw observations and returns a
// verdict. The Graph calls live in the adapter; the HTTP surface lives in the
// routes. That split is what makes every symptom in META_SETUP.md's
// troubleshooting table a directly-testable case rather than something only
// reachable by talking to Meta.

export type AccessLayer = 1 | 2 | 3;

// What the operator is checking, per asset kind. Ad accounts and Pages have
// different layer-1 endpoints (`client_ad_accounts` vs `client_pages`) and
// different scope requirements, so the diagnosis differs per kind.
export type CheckedAsset = "ad_account" | "page";

// The raw observations, all four independently gathered. `null` means "not
// checked / unknown", which is deliberately NOT the same as `false` — an
// unknown must never be reported as a confident pass or a confident failure
// (the AIC-98 house rule, applied to an operator-facing surface).
export interface AccessObservations {
  // Layer 1: does the asset appear under our portfolio's client_* edge?
  sharedToPortfolio: boolean | null;
  // Layer 2: does the System User actually see it (/me/accounts for Pages)?
  // Ad accounts have no /me/accounts equivalent, so this stays null for them
  // and the direct read below carries the whole weight.
  assignedToSystemUser: boolean | null;
  // Layer 3: does the token carry the scopes this asset kind needs?
  tokenHasScopes: boolean | null;
  // The call that actually matters: can we read the asset right now? This is
  // the same read the connection health check makes, so a pass here means
  // it is genuinely safe to persist the id (see AIC-69).
  directReadOk: boolean | null;
}

export type AccessVerdict =
  | { ok: true; layer: null; diagnosis: "ok" }
  | { ok: false; layer: AccessLayer | null; diagnosis: AccessDiagnosis };

// Every diagnosis maps 1:1 to a row of META_SETUP.md's troubleshooting table,
// so the operator sees the same fix the runbook would have told them — except
// on the call, at the moment it fails, instead of days later when ingestion
// comes back empty.
export type AccessDiagnosis =
  | "ok"
  // layer 1 — the customer hasn't (correctly) shared it
  | "not_shared"
  // layer 2 — shared, but not assigned to the System User on our side
  | "not_assigned"
  // layer 3 — the token predates this asset type; assignment will NEVER fix it
  | "token_missing_scopes"
  // shared + assigned + scoped, and it still won't read. Genuinely unexplained
  // by the three layers — never dressed up as one of the above.
  | "unreadable_unknown_cause"
  // not enough observations to say anything honest yet
  | "unknown";

// Order matters and is not arbitrary: it is cheapest-to-fix-last. A missing
// share (layer 1) is the customer's action and blocks everything downstream,
// so it is reported first even if the token is ALSO unscoped — telling an
// operator to regenerate a token while the customer hasn't shared the asset
// sends them to rotate a production secret for nothing.
export function classifyAccess(obs: AccessObservations): AccessVerdict {
  // The direct read is the ground truth. If it works, every layer beneath it
  // necessarily works, whatever the individual signals say — Meta's own edges
  // are occasionally inconsistent, and we trust the call we actually make.
  if (obs.directReadOk === true) return { ok: true, layer: null, diagnosis: "ok" };

  if (obs.sharedToPortfolio === false) {
    return { ok: false, layer: 1, diagnosis: "not_shared" };
  }
  if (obs.assignedToSystemUser === false) {
    return { ok: false, layer: 2, diagnosis: "not_assigned" };
  }
  if (obs.tokenHasScopes === false) {
    return { ok: false, layer: 3, diagnosis: "token_missing_scopes" };
  }

  // The read failed and none of the three layers explains why. Say exactly
  // that — an invented cause here sends the operator to "fix" something that
  // was never broken, on a live call.
  if (obs.directReadOk === false) {
    return { ok: false, layer: null, diagnosis: "unreadable_unknown_cause" };
  }

  return { ok: false, layer: null, diagnosis: "unknown" };
}

// The scopes each asset kind needs on the token. Ads-only tokens are the
// common historical case — every one of these Page scopes was missing from
// the token minted on 2026-08-12, which is what broke add-content.
export const REQUIRED_SCOPES: Record<CheckedAsset, readonly string[]> = {
  ad_account: ["ads_read", "ads_management"],
  page: ["pages_show_list", "pages_read_engagement"],
};

export function hasRequiredScopes(asset: CheckedAsset, granted: readonly string[]): boolean {
  const need = REQUIRED_SCOPES[asset];
  return need.every((s) => granted.includes(s));
}
