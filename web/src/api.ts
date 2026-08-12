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
export type HomeState = "ok" | "collecting" | "paused" | "attention" | "no_campaign" | "ready_to_launch";
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
    automationEnabled: boolean; deliveryOk: boolean; readyToLaunch: boolean;
    noRecReason: string | null; noRecDetail: Record<string, unknown> | null;
    liveBudgetAgorot: number | null;
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
export const getBuilderContext = () => api<{ category: string }>("/app/builder/context");
export const startBuilder = () => api<{ localCampaignId: string }>("/app/builder/start", { method: "POST" });

export interface PromotablePost { id: string; message: string | null; pictureUrl: string | null; createdAt: string; }
export const getPromotablePosts = () => api<{ posts: PromotablePost[] }>("/app/builder/posts");

export type UploadedMedia =
  | { kind: "image"; imageHash: string }
  | { kind: "video"; videoId: string; thumbnailUrl: string };

// Bypasses the generic api() helper: it always sets Content-Type: application/json,
// which would break the multipart boundary a FormData upload needs.
export async function uploadCreativeFile(file: File): Promise<UploadedMedia> {
  const form = new FormData();
  form.append("file", file);
  const token = getAuthToken();
  const res = await fetch("/api/app/builder/upload", {
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
  | { localCampaignId: string; clientKey: string; name: string; headline: string; primaryText: string; whatsappNumber: string; media: UploadedMedia }
  | { localCampaignId: string; clientKey: string; name: string; postId: string };

// Bypasses api() too: a 400 here carries {errors: code[]}, not {error: string} —
// needs its own parsing so CreativeValidationError keeps the codes, not a flattened message.
export async function createCreative(body: CreateCreativeBody): Promise<{ creativeId: string }> {
  const token = getAuthToken();
  const res = await fetch("/api/app/builder/creative", {
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
  whatsappDestination: string;
  targeting: { ageMin: number; ageMax: number; genders: "all" | "male" | "female"; countries?: string[] };
  ads: Array<{ clientKey: string; name: string; creativeId: string }>;
}
export interface BuildCampaignResult {
  metaCampaignId: string;
  adSets: Array<{ clientKey: string; metaAdSetId: string; ads: Array<{ clientKey: string; metaAdId: string }> }>;
}
export const buildCampaign = (body: BuildCampaignBody) =>
  api<BuildCampaignResult>("/app/builder/build", { method: "POST", body: JSON.stringify(body) });

// ── Launch gate (AIC-53) ────────────────────────────────────────────────────
export interface LaunchSummary {
  campaignId: string;
  name: string;
  dailyBudgetAgorot: number;
  budgetPeriod: "daily" | "monthly";
  whatsappDestination: string;
  adCount: number;
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
}
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

export type AddContentCreativeBody =
  | { clientKey: string; name: string; headline: string; primaryText: string; whatsappNumber: string; media: UploadedMedia }
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
