import type pg from "pg";
import type { AccessVerdict, CheckedAsset } from "../meta/access-layers.js";
import type { AssetProbeResult } from "../meta/access-probe.js";
import { FIXED_DESTINATION, WEBSITE_DESTINATION, missingRequiredFields, type CampaignRequiredField } from "@aic/shared";

// AIC-101 + AIC-68 — the onboarding wizard's state and its provisioning step.
//
// This replaces two things that were never really tooling:
//   * an operator reading docs/META_SETUP.md aloud off a second screen, and
//   * hand-written SQL against production to create the connection rows.
//
// Both produced real bugs. The SQL produced a blank `page_id` that shipped
// unnoticed; the read-aloud runbook described a partner-grant flow Meta
// doesn't have, because nothing ever verified that following it worked.

// The checks the wizard runs, in the order the operator performs them. Keyed
// strings rather than positional indexes so re-ordering the script later
// doesn't silently re-map stored results to different checks.
export type OnboardingCheckKey = "ad_account" | "page" | "instagram" | "token" | "connection";

export interface StoredCheck {
  ok: boolean;
  layer: number | null;
  diagnosis: string;
  detail: string | null;
  at: string; // ISO
  // AIC-105 follow-up: what was actually checked (the "act_…"/Page id typed
  // into the field). Found live — a passing check persisted `ok: true`
  // forever, but never the id it was true OF, so reopening the wizard showed
  // a green "תקין" pill next to an empty input. null for checks with no
  // single asset id (token, connection).
  assetId: string | null;
}

// What recordCheck accepts. Deliberately structural rather than the full
// `AccessVerdict` union: the three-layer checks produce `AccessDiagnosis`
// values, but the final connection check reports ConnectionService health
// (`health_revoked` etc.), which is a genuinely different vocabulary for a
// genuinely different question. Widening the stored type is honest; forcing
// the connection health into an access-layer diagnosis would not be.
export interface RecordableVerdict {
  ok: boolean;
  layer: number | null;
  diagnosis: string;
}

export interface OnboardingState {
  customerId: string;
  currentStep: number;
  checks: Partial<Record<OnboardingCheckKey, StoredCheck>>;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface Row {
  customer_id: string;
  current_step: number;
  checks: Partial<Record<OnboardingCheckKey, StoredCheck>>;
  started_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

const toState = (r: Row): OnboardingState => ({
  customerId: r.customer_id,
  currentStep: r.current_step,
  checks: r.checks ?? {},
  startedAt: r.started_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  completedAt: r.completed_at?.toISOString() ?? null,
});

// Idempotent: opening the wizard for a customer who has never been onboarded
// creates the row; re-opening returns exactly what was there. The operator can
// close the tab mid-call without losing their place.
export async function getOrCreateOnboarding(
  pool: pg.Pool,
  customerId: string,
): Promise<OnboardingState> {
  const { rows } = await pool.query<Row>(
    `INSERT INTO customer_onboarding (customer_id) VALUES ($1)
     ON CONFLICT (customer_id) DO UPDATE SET customer_id = EXCLUDED.customer_id
     RETURNING *`,
    [customerId],
  );
  return toState(rows[0]);
}

export async function setStep(
  pool: pg.Pool,
  customerId: string,
  step: number,
): Promise<OnboardingState> {
  const { rows } = await pool.query<Row>(
    `UPDATE customer_onboarding SET current_step = $2, updated_at = now()
     WHERE customer_id = $1 RETURNING *`,
    [customerId, step],
  );
  if (rows.length === 0) throw new Error(`no onboarding row for customer ${customerId}`);
  return toState(rows[0]);
}

// Records one check's verdict + when it was taken. Merges into the JSONB
// rather than replacing it, so running the Page check doesn't wipe the ad
// account's earlier pass.
export async function recordCheck(
  pool: pg.Pool,
  customerId: string,
  key: OnboardingCheckKey,
  verdict: RecordableVerdict,
  detail: string | null,
  assetId: string | null = null,
  at: Date = new Date(),
): Promise<OnboardingState> {
  const stored: StoredCheck = {
    ok: verdict.ok,
    layer: verdict.layer,
    diagnosis: verdict.diagnosis,
    detail,
    assetId,
    at: at.toISOString(),
  };
  const { rows } = await pool.query<Row>(
    `UPDATE customer_onboarding
        SET checks = checks || jsonb_build_object($2::text, $3::jsonb),
            updated_at = now()
      WHERE customer_id = $1
      RETURNING *`,
    [customerId, key, JSON.stringify(stored)],
  );
  if (rows.length === 0) throw new Error(`no onboarding row for customer ${customerId}`);
  return toState(rows[0]);
}

export async function markComplete(pool: pg.Pool, customerId: string): Promise<OnboardingState> {
  const { rows } = await pool.query<Row>(
    `UPDATE customer_onboarding SET completed_at = now(), updated_at = now()
     WHERE customer_id = $1 RETURNING *`,
    [customerId],
  );
  return toState(rows[0]);
}

// ── Provisioning (AIC-68) ───────────────────────────────────────────────────

export interface ProvisionInput {
  customerId: string;
  systemUserId: string;
  // The CUSTOMER's own Business Portfolio id (the partner granting us access)
  // — not ours. Recorded so a later access investigation can tell which
  // business actually shared the assets without going back to Meta's UI.
  businessPortfolioId?: string | null;
  metaAdAccountId: string;
  adAccountName?: string | null;
  currency?: string | null;
  // Optional on purpose — see the guard below. A campaign can be connected
  // before a Page is readable; a Page id that ISN'T readable must never be
  // written at all.
  pageId?: string | null;
  instagramId?: string | null;
  // AIC-105 Branch A: every field below is optional AS A UNIT, keyed off
  // metaCampaignId. Omitted entirely means "connect the account only — this
  // customer has no Meta campaign yet" (the wizard's picker returned zero
  // results). That's not a degraded case: it's the exact precondition
  // resolveBuilderContextForCustomer checks — a healthy connection with no
  // campaign row, ready for the operator to launch the builder and create the
  // customer's FIRST campaign, which writes managed_campaigns itself via
  // startBuilderCampaign/buildCampaignOnMeta. Provide metaCampaignId without
  // campaignName (or vice versa) and this throws — never half a campaign row.
  metaCampaignId?: string;
  campaignName?: string;
  objective?: string;
  agreedBudgetAgorot?: number;
  budgetPeriod?: "daily" | "monthly";
  leadEventTypes?: string[] | null;
  trackingPixelId?: string | null;
  // AIC-102: the website/Pixel lead type's landing-page URL — what
  // additions/session.ts's resolveCreativeDestination reads to build a
  // link-CTA creative. Unused (left null) for a messaging campaign.
  websiteUrl?: string | null;
  // AIC-103: which destination this campaign uses — the wizard asks this
  // explicitly ("where should someone land after clicking your ad?") rather
  // than inferring it, since nothing to infer FROM exists yet at provisioning
  // time. Drives which of the fields above are actually required (see the
  // shared CAMPAIGN_TYPE_REQUIRED_FIELDS table) and what lead_event_types
  // defaults to when left blank.
  destinationType?: "whatsapp" | "website";
  // AIC-103: found live — this was NEVER a field on the provisioning form at
  // all, so every WhatsApp campaign provisioned through this wizard got
  // whatsapp_destination = '' (the column's own NOT NULL DEFAULT) regardless
  // of what the operator entered elsewhere. Exactly GelNails' real shape
  // (additions/session.ts's whatsappWriteBlock comment) — connected outside
  // the builder, so the number was never captured.
  whatsappDestination?: string | null;
}

export class PageNotReadableError extends Error {
  constructor(public readonly pageId: string, public readonly diagnosis: string) {
    super(
      `refusing to save page_id ${pageId}: the backend cannot read it (${diagnosis}). ` +
        `Writing it would flip the connection to 'revoked' and silently stop the recommendation engine.`,
    );
    this.name = "PageNotReadableError";
  }
}

// AIC-108: the identical guard for instagram_id, because it carries the
// identical risk and had none. ConnectionService.verify() runs
// verifyAssetAccess("instagram", …) in the SAME worst-health-wins fold as the
// Page, and classifyGraphError maps both realistic failures to `revoked`
// (confirmed live 2026-08-19: a typo'd id → Graph code 100, an id not shared
// with us → code 10; both are in PERMISSION_CODES). So an unverified
// Instagram id written here silently stops the engine exactly like AIC-69's
// page_id did — with the field having no live consumer to justify the risk.
export class InstagramNotReadableError extends Error {
  constructor(public readonly instagramId: string, public readonly diagnosis: string) {
    super(
      `refusing to save instagram_id ${instagramId}: the backend cannot read it (${diagnosis}). ` +
        `Writing it would flip the connection to 'revoked' and silently stop the recommendation engine.`,
    );
    this.name = "InstagramNotReadableError";
  }
}

// AIC-103: the provisioning-time enforcement point of the one declared
// required-fields table (shared/recommended-defaults.ts) — mirrors
// PageNotReadableError's "refuse before the write, not after" shape. Not an
// optional text field an operator can tab past: this is what stops the next
// free_beta_signups_leads (provisioned complete-looking, actually missing
// website_url, discovered only via a customer's raw 409 months later).
export class IncompleteProvisioningError extends Error {
  constructor(public readonly destinationType: "whatsapp" | "website", public readonly missingFields: CampaignRequiredField[]) {
    super(`refusing to provision a ${destinationType} campaign missing required field(s): ${missingFields.join(", ")}`);
    this.name = "IncompleteProvisioningError";
  }
}

export interface ProvisionResult {
  connectionId: string;
  adAccountRowId: string;
  // AIC-105 Branch A: null exactly when the connection was provisioned
  // without a campaign — never a placeholder id, so a caller can't mistake
  // "no campaign yet" for "campaign zero".
  campaignId: string | null;
  pageIdSaved: boolean;
}

// Creates the meta_connections / ad_accounts / managed_campaigns trio the
// backend needs, in one transaction.
//
// THE HARD CONSTRAINT (AIC-69, learned in production): `page_id` is only
// written when a live Page read has just succeeded. A page_id the backend
// cannot read makes the connection health check fail, and because health is
// worst-wins that flips the WHOLE connection to `revoked` — which drops the
// campaign out of `listEligibleForGeneration` and silently stops the
// recommendation engine. That is strictly worse than the feature the page_id
// was needed for. The runbook documents this ordering; the point of doing it
// here is that the wizard cannot get it wrong, rather than relying on an
// operator remembering a warning in a markdown file at 6pm on a call.
export async function provisionConnection(
  pool: pg.Pool,
  input: ProvisionInput,
  // Verified immediately before the write by the caller, never trusted from
  // the client. `null` means no Page was offered at all, which is legal.
  pageVerdict: AccessVerdict | null,
  // AIC-108: same contract as pageVerdict — verified by the caller
  // immediately before the write, never trusted from the client. `null` means
  // no Instagram id was offered, which is legal and carries no risk (the
  // health check skips a null instagram_id entirely).
  instagramVerdict: AccessVerdict | null = null,
): Promise<ProvisionResult> {
  if (input.pageId) {
    if (!pageVerdict || !pageVerdict.ok) {
      throw new PageNotReadableError(input.pageId, pageVerdict?.diagnosis ?? "unverified");
    }
  }
  if (input.instagramId) {
    if (!instagramVerdict || !instagramVerdict.ok) {
      throw new InstagramNotReadableError(input.instagramId, instagramVerdict?.diagnosis ?? "unverified");
    }
  }

  // AIC-105 Branch A: metaCampaignId/campaignName travel together or not at
  // all. A caller with one and not the other is a bug in the route layer,
  // not a legal "half campaign" — fail loudly rather than writing a
  // managed_campaigns row with a null meta_campaign_id.
  const hasCampaign = !!input.metaCampaignId;
  if (hasCampaign !== !!input.campaignName) {
    throw new Error("metaCampaignId and campaignName must be provided together, or both omitted");
  }
  if (hasCampaign && !Number.isInteger(input.agreedBudgetAgorot)) {
    throw new Error("agreedBudgetAgorot must be a positive integer when metaCampaignId is provided");
  }

  // AIC-103: refuse an incomplete campaign BEFORE it's ever written, not
  // discover it later off a customer's raw 409. Same table, same check
  // resolveAdditionAvailability uses at read time — one definition. Only
  // applies when a campaign is actually being provisioned; connecting the
  // account alone (Branch A) has no destination to validate yet.
  if (hasCampaign) {
    const destinationType = input.destinationType ?? "whatsapp";
    const missing = missingRequiredFields(destinationType === "whatsapp" ? FIXED_DESTINATION : WEBSITE_DESTINATION, {
      whatsappDestination: input.whatsappDestination ?? null,
      websiteUrl: input.websiteUrl ?? null,
      trackingPixelId: input.trackingPixelId ?? null,
      leadEventTypes: input.leadEventTypes ?? null,
    });
    if (missing.length > 0) throw new IncompleteProvisioningError(destinationType, missing);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // AIC-105 Branch A, found live: `meta_connections` is UNIQUE(customer_id)
    // by design (P0 — one connection per customer), but a connect-only
    // provision (no campaign yet) is genuinely re-runnable — the operator
    // can leave the builder and come back to "צור קמפיין חדש" before ever
    // finishing it. A plain INSERT made a retry a raw constraint-violation
    // 500 instead of a no-op. ON CONFLICT DO UPDATE, not DO NOTHING: an
    // existing connection with no page_id yet (this exact path's own most
    // common shape) should still pick up a newly-verified one rather than
    // staying permanently null just because the row already existed.
    const conn = await client.query<{ id: string }>(
      `INSERT INTO meta_connections
         (customer_id, system_user_id, business_portfolio_id, page_id, instagram_id, access_health, last_verified_at)
       VALUES ($1,$2,COALESCE($3,''),$4,$5,'ok', now())
       ON CONFLICT (customer_id) DO UPDATE SET
         page_id = COALESCE(meta_connections.page_id, EXCLUDED.page_id),
         instagram_id = COALESCE(meta_connections.instagram_id, EXCLUDED.instagram_id)
       RETURNING id`,
      [
        input.customerId,
        input.systemUserId,
        input.businessPortfolioId ?? null,
        input.pageId ?? null,
        input.instagramId ?? null,
      ],
    );
    const connectionId = conn.rows[0].id;

    // Same idempotency for the ad account: connecting the SAME account twice
    // under an existing connection is a no-op, not a crash. Migration 037
    // already makes (connection_id, meta_ad_account_id) the unique pair —
    // this is the write side finally matching that.
    //
    // COALESCE, not a bare parameter: `name`/`currency` are NOT NULL with
    // column defaults, and passing an explicit NULL OVERRIDES a default
    // rather than falling back to it — so an optional field left unset would
    // violate the constraint instead of taking ''/'ILS'.
    const acct = await client.query<{ id: string }>(
      `INSERT INTO ad_accounts (connection_id, meta_ad_account_id, name, currency)
       VALUES ($1,$2,COALESCE($3,''),COALESCE($4,'ILS'))
       ON CONFLICT (connection_id, meta_ad_account_id) DO UPDATE SET
         name = ad_accounts.name
       RETURNING id`,
      [connectionId, input.metaAdAccountId, input.adAccountName ?? null, input.currency ?? null],
    );
    const adAccountRowId = acct.rows[0].id;

    // No `origin` column by design: "did we build this" is DERIVED from
    // whether a successful `create_campaign` action_history row exists
    // (customer-overview.ts's was_built_here), not stored as a flag that
    // could drift from what actually happened. A connected campaign has no
    // such row, so it correctly reports wasBuiltHere: false and gets the
    // honest "we found your campaign on Meta" hero rather than a claim that
    // we built and reviewed it.
    //
    // AIC-105 Branch A: skipped entirely when there's no campaign yet — the
    // builder wizard writes this row itself (startBuilderCampaign), once the
    // operator actually creates one on Meta.
    let campaignId: string | null = null;
    if (hasCampaign) {
      const camp = await client.query<{ id: string }>(
        `INSERT INTO managed_campaigns
           (customer_id, ad_account_id, meta_campaign_id, name, status, objective,
            agreed_budget_agorot, budget_period, lead_event_types, tracking_pixel_id, website_url, whatsapp_destination)
         VALUES ($1,$2,$3,$4,'active',$5,$6,$7,
                 COALESCE($8::text[], ARRAY['onsite_conversion.messaging_conversation_started_7d',
                                            'onsite_conversion.messaging_conversation_started']),
                 $9,$10,COALESCE($11,''))
         RETURNING id`,
        [
          input.customerId,
          adAccountRowId,
          input.metaCampaignId,
          input.campaignName,
          input.objective ?? "leads",
          input.agreedBudgetAgorot,
          input.budgetPeriod ?? "daily",
          input.leadEventTypes ?? null,
          input.trackingPixelId ?? null,
          input.websiteUrl ?? null,
          input.whatsappDestination ?? null,
        ],
      );
      campaignId = camp.rows[0].id;
    }

    await client.query("COMMIT");
    return {
      connectionId,
      adAccountRowId,
      campaignId,
      pageIdSaved: !!input.pageId,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Convenience for the route layer: turn a probe result into the stored shape.
export const checkFromProbe = (p: AssetProbeResult): { verdict: AccessVerdict; detail: string | null } => ({
  verdict: p.verdict,
  detail: p.detail,
});

export const CHECK_FOR_ASSET: Record<CheckedAsset, OnboardingCheckKey> = {
  ad_account: "ad_account",
  page: "page",
  instagram: "instagram",
};
