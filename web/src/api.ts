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
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

// ── Customer overview (AIC-22/24) ─────────────────────────────────────────
// Mirrors server/src/services/customer-overview.ts. Money is integer agorot.
export type AccessHealth = "ok" | "revoked" | "invalid" | "needs_reconnect";
export type HomeState = "ok" | "collecting" | "paused" | "attention" | "no_campaign";
export type CampaignStatus =
  | "under_review" | "active" | "paused" | "needs_attention"
  | "connection_problem" | "unmanaged";

export interface PeriodAgg {
  spendAgorot: number;
  leads: number;
  cplAgorot: number | null;
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
    automationEnabled: boolean; deliveryOk: boolean;
  } | null;
  subscription: {
    plan: string; status: string; setupPaid: boolean;
    monthlyAmountAgorot: number; nextChargeDate: string | null;
  } | null;
  readout: {
    current: PeriodAgg; previous: PeriodAgg;
    delta: { spendPct: number | null; leadsPct: number | null; cplPct: number | null };
    perCreative: Array<{ metaObjectId: string; creativeName: string | null; deliveryStatus: string }>;
  } | null;
  recentActivity: Array<{
    when: string; summary: string; automated: boolean; result: "success" | "failed";
  }>;
  pendingRecommendations: number;
  attentionKind: "connection" | "delivery" | null;
  homeState: HomeState;
}

// ── Recommendations (AIC-23) ────────────────────────────────────────────────
export type RecommendationType =
  | "pause_creative" | "pause_adset" | "increase_budget" | "decrease_budget"
  | "replace_creative" | "no_action";
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
  history: Array<{ when: string; summary: string; automated: boolean; result: "success" | "failed" }>;
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
export interface AudienceCreativeRow {
  metaObjectId: string;
  creativeName: string | null;
  spendAgorot: number;
  leads: number;
  cplAgorot: number | null;
  deliveryStatus: string;
}
export interface AudienceRow {
  adSetId: string;
  label: string;
  spendAgorot: number;
  leads: number;
  cplAgorot: number | null;
  creatives: AudienceCreativeRow[];
}
export interface CampaignAudiences {
  campaignId: string;
  audiences: AudienceRow[];
}
export const getCampaignAudiences = () => api<CampaignAudiences>("/app/audiences");

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

// ── Admin: recommendations oversight (AIC-46) ───────────────────────────────
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
}
export const getAdminRecommendations = (filter: { state?: string; type?: string; customerId?: string } = {}) => {
  const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
  return api<{ recommendations: AdminRecRow[] }>(`/admin/recommendations${q ? `?${q}` : ""}`);
};
export const flagRecommendation = (id: string, note: string) =>
  api<{ ok: true }>(`/admin/recommendations/${id}/flag`, { method: "POST", body: JSON.stringify({ note }) });
export const unflagRecommendation = (id: string) =>
  api<{ ok: true }>(`/admin/recommendations/${id}/unflag`, { method: "POST", body: "{}" });

export const changePassword = (currentPassword: string, newPassword: string) =>
  api<{ ok: true }>("/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });

export const getMe = () =>
  api<{ user: { name: string; email: string; isAdmin: boolean } }>("/auth/me").then((r) => r.user);
export const getOverview = () => api<CustomerOverview>("/app/overview");
export const postLeadQuality = (leadsReported: number, relevantCount: number) =>
  api<{ ok: true }>("/app/lead-quality", {
    method: "POST",
    body: JSON.stringify({ leadsReported, relevantCount }),
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
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch { /* non-JSON */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}
