// Every request goes through the /api prefix. In dev the Vite proxy forwards it
// to the API server; in single-origin prod the Express server owns both the
// static SPA and /api on one origin, so the prefix lines up end-to-end.
//
// Admin routes (/admin/*) require a bearer token (server requireAdmin). The ops
// console stores it in localStorage via the AdminGate; we attach it here.
const ADMIN_TOKEN_KEY = "aic_admin_token";
const AUTH_TOKEN_KEY = "aic_auth_token";

function ls(key: string): string {
  try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
}
function setLs(key: string, v: string): void {
  try { localStorage.setItem(key, v); } catch { /* ignore */ }
}
function delLs(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export const getAdminToken = () => ls(ADMIN_TOKEN_KEY);
export const setAdminToken = (t: string) => setLs(ADMIN_TOKEN_KEY, t);
export const clearAdminToken = () => delLs(ADMIN_TOKEN_KEY);

// Customer session (AIC-21). The JWT from /auth/login|signup.
export const getAuthToken = () => ls(AUTH_TOKEN_KEY);
export const setAuthToken = (t: string) => setLs(AUTH_TOKEN_KEY, t);
export const clearAuthToken = () => delLs(AUTH_TOKEN_KEY);

// Thrown so callers can show the server's message (e.g. "email already registered").
// `body` carries the full parsed JSON error body when there is one, so a
// caller that needs more than the message (e.g. a `reason` discriminant) can
// read it without a second round trip.
export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

// ── Customer overview (AIC-22/24) ─────────────────────────────────────────
// Mirrors server/src/services/customer-overview.ts. Money is integer agorot.
export type AccessHealth = "ok" | "revoked" | "invalid" | "needs_reconnect";
export type HomeState = "ok" | "collecting" | "paused" | "attention" | "no_campaign" | "ready_to_launch" | "stopped";
// AIC-98: which cause put the campaign in `attention`. Named (was inline on
// CustomerOverview) so the copy map can be `Record<AttentionKind, …>` and a
// fourth cause can't ship without its own message — the three existing ones
// all wear the same "צריך טיפול" badge and would otherwise silently collapse
// into one another.
export type AttentionKind = "connection" | "delivery" | "tracking" | "cta"; // AIC-128
// AIC-98: mirrors server/src/recommendations/rules.ts. Was `string | null` on
// CustomerOverview, which defeated exhaustiveness at the boundary — a new
// engine reason type-checked fine and rendered the generic fallback.
export type NoActionReason =
  | "stable"
  | "collecting"
  | "budget_below_threshold"
  | "delivery_blocked"
  | "tracking_broken"
  | "cta_broken" // AIC-128
  | "account_cannot_spend" // AIC-72
  | "lead_event_stopped" // AIC-91
  | "no_comparable_audiences"
  | "cooling_down"
  | "below_object_evidence_floor"
  | "no_comparable_creatives";
export type CampaignStatus =
  | "under_review" | "active" | "paused" | "needs_attention"
  | "connection_problem" | "unmanaged";

export interface PeriodAgg {
  spendAgorot: number;
  leads: number;
  cplAgorot: number | null;
}
export const RANGE_KEYS = ["day", "week", "month", "allTime"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];
export interface DailyPoint {
  date: string;
  spendAgorot: number;
  leads: number;
}
// AIC-67: the incremental delta-review watermark.
export interface LeadQualityStatus {
  reviewedSoFar: number;
  relevantSoFar: number;
  pending: number;
  leadsThisWeek: number;
  relevantThisWeek: number;
}
export interface CustomerOverview {
  account: { name: string; email: string };
  customer: {
    id: string; businessName: string; onboardingStatus: string;
    contactName: string; contactEmail: string;
  } | null;
  connection: {
    accessHealth: AccessHealth;
    adAccount: { metaAdAccountId: string; name: string; currency: string } | null;
    pageId: string | null;
    instagramId: string | null;
  } | null;
  campaign: {
    id: string; name: string; status: CampaignStatus; objective: string;
    agreedBudgetAgorot: number; budgetPeriod: "daily" | "monthly";
    automationEnabled: boolean; deliveryOk: boolean; readyToLaunch: boolean;
    // Bug fix, 2026-08-14: whether a real create_campaign action_history row
    // exists for this campaign — distinguishes a builder-built campaign from
    // one connected from outside the app, so the ready_to_launch hero can
    // stop claiming "we built it, it passed review" for the latter.
    wasBuiltHere: boolean;
    noRecReason: NoActionReason | null; noRecDetail: Record<string, unknown> | null;
    liveBudgetAgorot: number | null;
    delivering: boolean; deliveringAdCount: number | null;
  } | null;
  subscription: {
    plan: string; status: string; setupPaid: boolean;
    monthlyAmountAgorot: number; nextChargeDate: string | null;
  } | null;
  readout: {
    current: PeriodAgg; previous: PeriodAgg;
    // Today so far — provisional, never folded into `current` (which stops at
    // yesterday, matching the engine's complete-days evaluation window).
    today: PeriodAgg;
    // The day/week/month/all-time switcher's data. Bounded ranges are summed
    // from disjoint per-day rows; allTime is the cached lifetime read.
    ranges: Record<RangeKey, PeriodAgg>;
    daily: DailyPoint[];
    firstDataDate: string | null;
    delta: { spendPct: number | null; leadsPct: number | null; cplPct: number | null };
    perCreative: Array<{ metaObjectId: string; creativeName: string | null; deliveryStatus: string }>;
  } | null;
  leadQuality: LeadQualityStatus | null;
  recentActivity: Array<{
    when: string; summary: string; automated: boolean;
    // 2026-08-22: `automated` alone could not distinguish the customer's own
    // action from ours, so the feed credited us for everything they did.
    actor: "automated" | "customer" | "us";
    result: "success" | "failed";
  }>;
  pendingRecommendations: number;
  pendingRecommendationType: RecommendationType | null;
  attentionKind: AttentionKind | null;
  homeState: HomeState;
}

// ── Recommendations (AIC-23) ────────────────────────────────────────────────
export type RecommendationType =
  | "pause_creative" | "pause_adset" | "increase_budget" | "decrease_budget"
  | "replace_creative" | "no_action" | "add_creatives_for_comparison"; // AIC-86
export interface CustomerRec {
  id: string;
  type: RecommendationType;
  explanation: string;
  currentBudgetAgorot: number | null;
  proposedBudgetAgorot: number | null;
  maxSpendImpactAgorot: number | null;
  targetMetaId: string | null;
}
export interface CustomerRecList {
  campaignId: string | null;
  pending: CustomerRec[];
  history: Array<{ when: string; summary: string; automated: boolean; actor: "automated" | "customer" | "us"; result: "success" | "failed" }>;
  // 2026-08-22: when `pending` is empty this screen said only "no
  // recommendations yet" — strictly less than the dashboard the customer
  // clicked through from, which names the reason. A drill-down that answers
  // less than its own summary is backwards (AIC-98).
  noRecReason: NoActionReason | null;
  noRecDetail: Record<string, unknown> | null;
}
export interface ApproveOutcome {
  outcome: "executed" | "aborted" | "failed";
  customerMessage: string | null;
}

export const listRecommendations = () => api<CustomerRecList>("/app/recommendations");
export const getRecommendation = (id: string) => api<CustomerRec>(`/app/recommendations/${id}`);
export const approveRecommendation = (id: string) =>
  api<ApproveOutcome>(`/app/recommendations/${id}/approve`, { method: "POST" });
export const dismissRecommendation = (id: string) =>
  api<{ ok: true }>(`/app/recommendations/${id}/dismiss`, { method: "POST" });

// ── Connection + budget + password actions (AIC-21 / AIC-24) ────────────────
export const recheckConnection = () =>
  api<{ accessHealth: AccessHealth }>("/app/connection/recheck", { method: "POST" });
export const requestBudgetChange = (requestedAgorot?: number) =>
  api<{ ok: true }>("/app/budget-request", {
    method: "POST",
    body: JSON.stringify(requestedAgorot != null ? { requestedAgorot } : {}),
  });
// ── Opt-in audience details (AIC-37) ────────────────────────────────────────
// Mirrors server/src/services/campaign-audiences.ts.
export type AdState =
  | "active" | "in_review" | "rejected" | "paused"
  | "blocked_by_parent" | "gone" | "unknown";

export interface AudienceCreativeRow {
  metaObjectId: string;
  creativeName: string | null;
  spendAgorot: number;
  leads: number;
  cplAgorot: number | null;
  deliveryStatus: string;
  // 2026-08-22: an ad can now appear here with NO measured data — one Meta is
  // still reviewing, or one it rejected (which will never gain data). Before
  // this, such an ad was simply absent, so a customer who had just added one
  // saw a success message and then a list without it.
  adState: AdState;
  // false = "no results yet", which is NOT the same claim as ₪0 / 0 leads.
  hasData: boolean;
}
export interface AudienceRow {
  adSetId: string;
  label: string;
  spendAgorot: number;
  leads: number;
  cplAgorot: number | null;
  creatives: AudienceCreativeRow[];
  // AIC-95 followup: creatives with real historical data outside the selected
  // window (DB-only fact, never a liveness claim) — see campaign-audiences.ts.
  moreCreativesCount: number;
}
// AIC-95: why the panel has nothing for the selected window — never a bare
// empty array. See campaign-audiences.ts for what each reason means.
export type AudienceEmptyReason = "started_today" | "no_data_in_range" | "no_data_yet";
export interface CampaignAudiences {
  campaignId: string;
  range: RangeKey;
  audiences: AudienceRow[];
  empty?: { reason: AudienceEmptyReason; mostRecentDataDate: string | null };
}
export const getCampaignAudiences = (range: RangeKey) =>
  api<CampaignAudiences>(`/app/audiences?range=${range}`);

// ── Admin: customer CRUD (AIC-44) ───────────────────────────────────────────
export interface CustomerWriteFields {
  businessName?: string;
  category?: string;
  mainService?: string;
  geoArea?: string;
  primaryCustomer?: string;
  offer?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  isTest?: boolean;
  onboardingStatus?: string;
  agreedBudgetAgorot?: number;
  // Per-account rule-threshold overrides (AIC-77a), sparse — only the keys
  // being overridden. Mirrors server/src/recommendations/rules.ts's
  // RULE_THRESHOLDS keys; the server validates and rejects unknown ones.
  thresholdOverrides?: Record<string, number>;
  // AIC-103's fix-it surface — see CustomerDetail's twin read-side fields.
  websiteUrl?: string;
  trackingPixelId?: string;
  whatsappDestination?: string;
  leadEventTypes?: string[];
}
export interface AuditEntry {
  id: string;
  createdAt: string;
  actorLabel: string;
  action: string;
  entityLabel: string;
  detail: string;
}
export const createCustomer = (fields: CustomerWriteFields & { businessName: string }) =>
  api<{ id: string }>("/admin/customers", { method: "POST", body: JSON.stringify(fields) });
export const updateCustomer = (id: string, fields: CustomerWriteFields) =>
  api<{ ok: true }>(`/admin/customers/${id}`, { method: "PATCH", body: JSON.stringify(fields) });
export const deactivateCustomer = (id: string) =>
  api<{ ok: true }>(`/admin/customers/${id}/deactivate`, { method: "POST", body: "{}" });
export const reactivateCustomer = (id: string) =>
  api<{ ok: true }>(`/admin/customers/${id}/reactivate`, { method: "POST", body: "{}" });
export const deleteCustomer = (id: string, confirmText: string) =>
  api<{ ok: true }>(`/admin/customers/${id}`, { method: "DELETE", body: JSON.stringify({ confirmText }) });
export const getCustomerAudit = (id: string) =>
  api<{ entries: AuditEntry[] }>(`/admin/customers/${id}/audit`);

// AIC-127: reset/delete a signup from the Users view. `mode: "business"` keeps
// the login (customer_id goes NULL, so the onboarding wizard can be walked
// again); `"all"` removes the signup too. Neither touches Meta.
export type DeleteUserMode = "business" | "all";
export const deleteUserRecords = (id: string, mode: DeleteUserMode, confirmText: string) =>
  api<{ ok: true; deleted: { customer: boolean; user: boolean } }>(`/admin/users/${id}`, {
    method: "DELETE",
    body: JSON.stringify({ mode, confirmText }),
  });

// ── Admin: full Meta data explorer (AIC-45) ─────────────────────────────────
export interface ExplorerMetrics {
  spendAgorot: number;
  impressions: number;
  reach: number | null;
  frequency: number | null;
  cpmAgorot: number | null;
  ctrPct: number | null;
  cpcAgorot: number | null;
  leads: number;
  cplAgorot: number | null;
  qualityRanking: string | null;
  engagementRateRanking: string | null;
  conversionRateRanking: string | null;
}
export interface ExplorerCreative {
  id: string | null;
  name: string | null;
  title: string | null;
  body: string | null;
  callToActionType: string | null;
  imageUrl: string | null;
  videoId: string | null;
  pageId: string | null;
  isFlexible: boolean;
  flexibleAssetCounts: { images: number; videos: number; bodies: number; titles: number } | null;
}
export interface ExplorerAd {
  id: string;
  name: string | null;
  effectiveStatus: string | null;
  issues: string[];
  creative: ExplorerCreative | null;
  metrics: ExplorerMetrics;
}
export interface ExplorerAdSet {
  id: string;
  name: string | null;
  effectiveStatus: string | null;
  issues: string[];
  dailyBudgetAgorot: number | null;
  lifetimeBudgetAgorot: number | null;
  bidStrategy: string | null;
  targeting: { ageMin: number | null; ageMax: number | null; genders: string[]; geoCountries: string[]; interests: string[] };
  metrics: ExplorerMetrics;
  ads: ExplorerAd[];
  pageId: string | null;
  isManaged: boolean;
}
export interface ExplorerCampaign {
  id: string;
  name: string | null;
  effectiveStatus: string | null;
  dailyBudgetAgorot: number | null;
  lifetimeBudgetAgorot: number | null;
  bidStrategy: string | null;
  metrics: ExplorerMetrics;
  adSets: ExplorerAdSet[];
  period: { start: string; end: string };
  fetchedAt: string;
}
export interface ExplorerResult {
  campaignId: string;
  name: string;
  metaCampaignId: string | null;
  tree: ExplorerCampaign | null;
  unavailableReason: "no_meta_campaign" | "no_token" | "meta_error" | null;
  errorDetail?: string;
}
export const getCampaignExplorer = (campaignId: string) =>
  api<ExplorerResult>(`/admin/campaigns/${campaignId}/explorer`);

// ── Manual object controls (AIC-66) ─────────────────────────────────────────
export type ControlKind = "ad" | "ad_set";
export type ControlOutcome = "changed" | "already" | "not_found" | "failed";

/** Customer-side: live ACTIVE/PAUSED per object, fetched only when the details
 *  panel is opened (the readout itself stays DB-only). */
export interface ControlState {
  adStatuses: Record<string, "active" | "paused">;
  adSetStatuses: Record<string, "active" | "paused">;
  // AIC-100: the campaign's own intent — an ad and its ad set can both read
  // "active" while the campaign itself is paused, so resolving an ad's real
  // delivery needs all three. See app/delivery-status.ts.
  campaignStatus: "active" | "paused";
}
export const getControlState = () => api<ControlState>("/app/controls/state");

/** Creative thumbnails per ad (AIC-73) — same live-on-open rule as the control
 *  state. `assetCount` is what Meta actually reports, never inferred from the
 *  ad's name. */
export interface AdMedia {
  adId: string;
  name: string | null;
  thumbnails: string[];
  assetCount: number;
}
export const getAdMedia = () => api<{ ads: AdMedia[] }>("/app/controls/media");

export const setObjectPaused = (kind: ControlKind, metaObjectId: string, paused: boolean) =>
  api<{ outcome: ControlOutcome; status: string }>(`/app/controls/${paused ? "pause" : "resume"}`, {
    method: "POST",
    body: JSON.stringify({ kind, metaObjectId }),
  });

/** Operator-side. `confirm` must equal the object id for archive/delete —
 *  enforced server-side too, so a bypassed client changes nothing. */
export const adminObjectControl = (
  campaignId: string,
  action: "pause" | "resume" | "archive" | "delete",
  kind: ControlKind,
  metaObjectId: string,
  confirm?: string,
) =>
  api<{ outcome: ControlOutcome; status: string }>(`/admin/campaigns/${campaignId}/objects/${action}`, {
    method: "POST",
    body: JSON.stringify({ kind, metaObjectId, confirm }),
  });

// ── Admin: recommendations oversight (AIC-46) ───────────────────────────────

// AIC-76: did the recommendation actually help? Null until measured (the
// after-window hasn't closed yet, or the type never writes to Meta).
export type OutcomeVerdict = "improved" | "degraded" | "neutral" | "confounded" | "insufficient_data" | "not_measurable";
export interface OutcomeFeatures { spendAgorot: number; leads: number; cplAgorot: number | null; daysActive: number }
export interface OutcomeDelta { cplPct: number | null; leadsPct: number | null; spendPct: number | null }
export interface AdminRecOutcome {
  verdict: OutcomeVerdict;
  measuredAt: string;
  beforeStart: string; // YYYY-MM-DD
  beforeEnd: string;
  afterStart: string;
  afterEnd: string;
  beforeFeatures: OutcomeFeatures;
  afterFeatures: OutcomeFeatures;
  delta: OutcomeDelta;
  confoundDetail: { otherActions?: Array<{ actionType: string; occurredAt: string; humanInvolved: boolean }>; zeroSpendDays?: string[] } | null;
}

export interface AdminRecRow {
  id: string;
  customerId: string;
  businessName: string;
  campaignId: string;
  campaignName: string;
  type: string;
  state: string;
  evidence: Record<string, unknown>;
  currentBudgetAgorot: number | null;
  proposedBudgetAgorot: number | null;
  maxSpendImpactAgorot: number | null;
  rationale: string;
  createdAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  executedAt: string | null;
  flaggedForReview: boolean;
  flagNote: string | null;
  flaggedAt: string | null;
  actionHistoryId: string | null;
  executionResult: "success" | "failed" | null;
  outcome: AdminRecOutcome | null;
}
export const getAdminRecommendations = (filter: { state?: string; type?: string; customerId?: string } = {}) => {
  const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
  return api<{ recommendations: AdminRecRow[] }>(`/admin/recommendations${q ? `?${q}` : ""}`);
};
export const flagRecommendation = (id: string, note: string) =>
  api<{ ok: true }>(`/admin/recommendations/${id}/flag`, { method: "POST", body: JSON.stringify({ note }) });
export const unflagRecommendation = (id: string) =>
  api<{ ok: true }>(`/admin/recommendations/${id}/unflag`, { method: "POST", body: "{}" });

// AIC-76: fleet-wide "did the engine's changes actually help?" — its own
// query on the server, not a client-side rollup over the capped list.
export interface OutcomeAggregateRow { type: string; executed: number; byVerdict: Partial<Record<OutcomeVerdict, number>> }
export const getOutcomeSummary = () => api<{ byType: OutcomeAggregateRow[] }>("/admin/recommendations/outcomes-summary");

export const changePassword = (currentPassword: string, newPassword: string) =>
  api<{ ok: true }>("/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });

export const getMe = () =>
  api<{ user: { name: string; email: string; isAdmin: boolean; adminRole: "full_admin" | "operator" } }>("/auth/me").then((r) => r.user);

// ── Admin: operator accounts + full audit log (AIC-47) ──────────────────────
export interface OperatorRow {
  id: string;
  email: string;
  name: string;
  adminRole: "full_admin" | "operator";
  createdAt: string;
}
export const getOperators = () => api<{ operators: OperatorRow[] }>("/admin/operators");
export const addOperator = (email: string, role: "full_admin" | "operator") =>
  api<{ ok: true }>("/admin/operators", { method: "POST", body: JSON.stringify({ email, role }) });
export const setOperatorRole = (id: string, role: "full_admin" | "operator") =>
  api<{ ok: true }>(`/admin/operators/${id}/role`, { method: "POST", body: JSON.stringify({ role }) });
export const removeOperator = (id: string) =>
  api<{ ok: true }>(`/admin/operators/${id}`, { method: "DELETE", body: "{}" });

export interface FullAuditEntry {
  id: string;
  createdAt: string;
  actorUserId: string | null;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string;
  detail: string;
}
export const getAuditLog = (filter: { actorUserId?: string; entityType?: string; entityId?: string } = {}) => {
  const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
  return api<{ entries: FullAuditEntry[] }>(`/admin/audit${q ? `?${q}` : ""}`);
};
// ── Guided campaign builder (AIC-52) ────────────────────────────────────────
// AIC-105 Branch A: every function below takes an optional customerId — when
// present, it's an operator building a customer's FIRST campaign on their
// behalf (an admin-mounted route, admin-token-gated) instead of the
// customer's own self-serve session. Same shapes, same UI (Builder.tsx and
// BuilderCreatives.tsx just thread this through) — only WHICH backend route
// answers changes. `api()` already picks the admin token for any /admin/*
// path, so nothing else about auth needs to change here.
function builderBasePath(customerId?: string): string {
  return customerId ? `/admin/customers/${customerId}/builder` : "/app/builder";
}

export const getBuilderContext = (customerId?: string) =>
  // AIC-106 — businessName names the customer in the creation confirmation.
  api<{ category: string; businessName: string; agreedBudgetAgorot: number | null }>(`${builderBasePath(customerId)}/context`);
export const startBuilder = (customerId?: string) =>
  api<{ localCampaignId: string }>(`${builderBasePath(customerId)}/start`, { method: "POST" });

export interface PromotablePost { id: string; message: string | null; pictureUrl: string | null; createdAt: string; }
export const getPromotablePosts = (customerId?: string) => api<{ posts: PromotablePost[] }>(`${builderBasePath(customerId)}/posts`);

export type UploadedMedia =
  | { kind: "image"; imageHash: string }
  | { kind: "video"; videoId: string; thumbnailUrl: string };

// Bypasses the generic api() helper: it always sets Content-Type: application/json,
// which would break the multipart boundary a FormData upload needs.
export async function uploadCreativeFile(file: File, customerId?: string): Promise<UploadedMedia> {
  const form = new FormData();
  form.append("file", file);
  const token = customerId ? (getAdminToken() || getAuthToken()) : getAuthToken();
  const res = await fetch(`/api${builderBasePath(customerId)}/upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  if (!res.ok) {
    let msg = `upload failed: ${res.status}`;
    try { const b = (await res.json()) as { error?: string }; if (b?.error) msg = b.error; } catch { /* non-JSON */ }
    throw new ApiError(res.status, msg);
  }
  return ((await res.json()) as { media: UploadedMedia }).media;
}

export type CreativeErrorCode = "missing_media" | "missing_headline" | "headline_too_long" | "missing_primary_text" | "primary_text_too_long";
// Thrown on a 400 from /builder/creative — carries the error CODES (see
// shared/creative-handling.ts) so the caller can map them to display text.
export class CreativeValidationError extends Error {
  constructor(public readonly errors: CreativeErrorCode[]) {
    super("creative validation failed");
    this.name = "CreativeValidationError";
  }
}
export type CreateCreativeBody =
  | {
      localCampaignId: string; clientKey: string; name: string; headline: string; primaryText: string;
      whatsappNumber?: string;
      // AIC-89 — only meaningful for the builder's own /creative endpoint,
      // which has no existing campaign to infer a destination from yet
      // (unlike additions/creative, which derives it server-side).
      destination?: string;
      destinationUrl?: string;
      media: UploadedMedia;
    }
  | { localCampaignId: string; clientKey: string; name: string; postId: string };

// Bypasses api() too: a 400 here carries {errors: code[]}, not {error: string} —
// needs its own parsing so CreativeValidationError keeps the codes, not a flattened message.
export async function createCreative(body: CreateCreativeBody, customerId?: string): Promise<{ creativeId: string }> {
  const token = customerId ? (getAdminToken() || getAuthToken()) : getAuthToken();
  const res = await fetch(`/api${builderBasePath(customerId)}/creative`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (res.status === 400) {
    const b = (await res.json().catch(() => ({}))) as { errors?: CreativeErrorCode[] };
    throw new CreativeValidationError(b.errors ?? []);
  }
  if (!res.ok) throw new ApiError(res.status, `create creative failed: ${res.status}`);
  return res.json() as Promise<{ creativeId: string }>;
}

export interface BuildCampaignBody {
  localCampaignId: string;
  name: string;
  dailyBudgetAgorot: number;
  specialAdCategories: string[];
  destination?: string; // AIC-89 — defaults server-side to WhatsApp when omitted
  whatsappDestination: string;
  destinationUrl?: string;
  pixelId?: string;
  conversionEvent?: string;
  targeting: { ageMin: number; ageMax: number; genders: "all" | "male" | "female"; countries?: string[] };
  ads: Array<{ clientKey: string; name: string; creativeId: string }>;
}
export interface BuildCampaignResult {
  metaCampaignId: string;
  adSets: Array<{ clientKey: string; metaAdSetId: string; ads: Array<{ clientKey: string; metaAdId: string }> }>;
}
export const buildCampaign = (body: BuildCampaignBody, customerId?: string) =>
  api<BuildCampaignResult>(`${builderBasePath(customerId)}/build`, { method: "POST", body: JSON.stringify(body) });

// AIC-89 — the website-destination step's Pixel picker + recency guard.
export interface PixelOption { id: string; name: string; }
export const getBuilderPixels = (customerId?: string) => api<{ pixels: PixelOption[] }>(`${builderBasePath(customerId)}/pixels`);
export const checkBuilderPixel = (pixelId: string, conversionEvent: string, customerId?: string) =>
  api<{ hasRecentEvents: boolean | null }>(`${builderBasePath(customerId)}/pixel-check`, {
    method: "POST",
    body: JSON.stringify({ pixelId, conversionEvent }),
  });

// ── Launch gate (AIC-53) ────────────────────────────────────────────────────
// Where leads actually arrive. Three-valued: `unknown` blocks launch rather
// than rendering a blank value beside a confident label (the bug this fixed).
export type LaunchDestination =
  | { kind: "whatsapp"; whatsappNumber: string }
  | { kind: "website"; eventKey: string; domain: string | null }
  | { kind: "unknown" };

export type LaunchBlocker = "no_ads" | "unknown_destination" | "verification_unavailable";

export interface LaunchSummary {
  campaignId: string;
  name: string;
  dailyBudgetAgorot: number;
  budgetPeriod: "daily" | "monthly";
  destination: LaunchDestination;
  adCount: number | null; // null = Meta unreachable, NOT zero
  blockers: LaunchBlocker[];
}
export const getPendingLaunch = () => api<{ launch: LaunchSummary | null }>("/app/launch");
export type LaunchApproveOutcome = "activated" | "already_launched" | "not_approved" | "not_linked" | "failed";
export const approveLaunch = () =>
  api<{ outcome: LaunchApproveOutcome; reason?: string }>("/app/launch/approve", { method: "POST" });

// ── Add content to an existing campaign (AIC-63) ────────────────────────────
// Everyday management: add an ad to an existing ad set, or a new ad set +
// ads, to a campaign we already manage. Opposite precondition from the
// builder (requires an EXISTING linked campaign) — separate routes, same
// underlying create/creative/activate machinery.
export interface AdditionContext {
  campaignName: string;
  category: string;
  whatsappDestination: string;
  // AIC-103: which per-campaign-type required fields (shared's
  // CampaignRequiredField) are missing — [] when the campaign is fully
  // configured. Present even on a 200 (this never 409s the screen — an
  // existing-post creative needs none of these fields, so blocking the
  // whole screen on it would regress AIC-102). AddContent.tsx shows this as
  // an upfront banner so the customer learns before typing into a form that
  // will refuse at submit for the upload path specifically.
  missingConfigFields: string[];
}
// Mirrors server/src/additions/session.ts's AdditionUnavailableReason — why
// GET /context 409'd, read off ApiError.body. See campaign-audiences.ts's
// AudienceEmptyReason for the same pattern (a reason, not a bare failure).
export type AdditionUnavailableReason = "no_campaign" | "not_launched" | "missing_page" | "connection_issue";
export const getAdditionContext = () => api<AdditionContext>("/app/additions/context");

export interface ExistingAdSet {
  id: string;
  name: string;
  status: "active" | "paused";
}
export const getExistingAdSets = () => api<{ adSets: ExistingAdSet[] }>("/app/additions/ad-sets");

// Bypasses api() for the same reason as uploadCreativeFile — multipart body.
export async function uploadAdditionFile(file: File): Promise<UploadedMedia> {
  const form = new FormData();
  form.append("file", file);
  const token = getAuthToken();
  const res = await fetch("/api/app/additions/upload", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  if (!res.ok) {
    let msg = `upload failed: ${res.status}`;
    try { const b = (await res.json()) as { error?: string }; if (b?.error) msg = b.error; } catch { /* non-JSON */ }
    throw new ApiError(res.status, msg);
  }
  return ((await res.json()) as { media: UploadedMedia }).media;
}

export const getAdditionPosts = () => api<{ posts: PromotablePost[] }>("/app/additions/posts");

// whatsappNumber is vestigial here — the additions server (AIC-102) derives
// the destination from the campaign's own stored configuration, never from
// the client. Kept optional rather than removed to avoid touching every
// AddContent.tsx call site for a field the server already ignores.
export type AddContentCreativeBody =
  | { clientKey: string; name: string; headline: string; primaryText: string; whatsappNumber?: string; media: UploadedMedia }
  | { clientKey: string; name: string; postId: string };

// Bypasses api() too — a 400 here carries {errors: code[]}, matching createCreative.
export async function createAdditionCreative(body: AddContentCreativeBody): Promise<{ creativeId: string }> {
  const token = getAuthToken();
  const res = await fetch("/api/app/additions/creative", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (res.status === 400) {
    const b = (await res.json().catch(() => ({}))) as { errors?: CreativeErrorCode[] };
    throw new CreativeValidationError(b.errors ?? []);
  }
  if (!res.ok) throw new ApiError(res.status, `create creative failed: ${res.status}`);
  return res.json() as Promise<{ creativeId: string }>;
}

export interface AddAdBody {
  metaAdSetId: string;
  name: string;
  creativeId: string;
  additionKey: string;
}
export interface AddResult {
  additionId: string;
  metaAdSetId: string;
  metaAdIds: string[];
  // AIC-106: creating content activates it immediately — this is the
  // outcome of THAT activation, not a signal that anything is still
  // waiting. "approved"/"already_approved" = live now. Anything else means
  // it exists on Meta but is still paused — surfaced honestly rather than
  // treated the same as success.
  activation: { outcome: "approved" | "already_approved" | "not_found" | "failed"; reason?: string };
}
export const addAd = (body: AddAdBody) => api<AddResult>("/app/additions/ad", { method: "POST", body: JSON.stringify(body) });

export interface AddAdSetBody {
  name: string;
  targeting: { ageMin: number; ageMax: number; genders: "all" | "male" | "female"; countries?: string[] };
  ads: Array<{ clientKey: string; name: string; creativeId: string }>;
  additionKey: string;
}
export const addAdSet = (body: AddAdSetBody) => api<AddResult>("/app/additions/ad-set", { method: "POST", body: JSON.stringify(body) });

export interface PendingAddition {
  id: string;
  kind: "ad" | "ad_set";
  name: string;
  createdAt: string;
}
export const getPendingAdditions = () => api<{ pending: PendingAddition[] }>("/app/additions/pending");

export type ApproveAdditionOutcome = "approved" | "already_approved" | "failed";
export const approveAddition = (id: string) =>
  api<{ outcome: ApproveAdditionOutcome; reason?: string }>(`/app/additions/${id}/approve`, { method: "POST" });

// AIC-101/AIC-99: our Business Portfolio ID, read from server config —
// unauthenticated (it's a public identifier we already print in front of
// customers, not a secret) and never a literal baked into this bundle. See
// server/src/config/meta-identity.ts for why: a customer adds us as a
// partner BY ID, and that ID has to survive the "Ads Agent" rename unchanged.
export const getConfig = () => api<{ businessPortfolioId: string }>("/config");

export const getOverview = () => api<CustomerOverview>("/app/overview");
// AIC-67: `relevant` answers about the PENDING delta only — the server reads
// how many leads are pending from the caller's own watermark, never a
// client-supplied total, so this can never re-rate already-reviewed leads.
export const postLeadQuality = (relevant: number) =>
  api<{ ok: true; leadQuality: LeadQualityStatus | null }>("/app/lead-quality", {
    method: "POST",
    body: JSON.stringify({ relevant }),
  });

// Integer agorot → "₪NN" (drops the decimals when whole, one place otherwise).
export function shekels(agorot: number): string {
  const v = agorot / 100;
  return `₪${Number.isInteger(v) ? v : v.toFixed(1)}`;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  // Admin is a per-user role: /admin/* uses the signed-in user's JWT (an
  // optional break-glass admin token still wins if one was set). Everything
  // else uses the customer JWT.
  const token = path.startsWith("/admin") ? (getAdminToken() || getAuthToken()) : getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, { ...init, headers });
  if (!res.ok) {
    let msg = `API ${path} failed: ${res.status}`;
    let body: unknown;
    try {
      body = (await res.json()) as { error?: string };
      if ((body as { error?: string })?.error) msg = (body as { error: string }).error;
    } catch { /* non-JSON */ }
    throw new ApiError(res.status, msg, body);
  }
  return res.json() as Promise<T>;
}

// The ad account's display label. `name` is NOT NULL with a '' default, and the
// admin wizard never sends one (customer-onboarding accepts `adAccountName`, but
// no caller in web/ passes it), so for every wizard-provisioned customer the
// name is the empty string. Rendering `name || "—"` then showed a dash in the
// connection panel while the technical line directly beneath it printed the very
// id we were pretending not to have. Fall back to the id: it is what identifies
// the account to a customer on the phone with Meta support anyway.
export function adAccountLabel(
  a: { metaAdAccountId: string; name: string } | null | undefined,
): string {
  if (!a) return "";
  return a.name.trim() || a.metaAdAccountId;
}
