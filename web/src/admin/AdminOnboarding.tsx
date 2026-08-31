import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FIXED_DESTINATION, WEBSITE_DESTINATION, missingRequiredFields } from "@aic/shared";
import { api, ApiError, updateCustomer, type CustomerWriteFields } from "../api";
import { adAccountOptions, newCampaignBlocker, provisionBlocker, step4Branch } from "./onboarding-step4";
import { strings } from "../strings";
import { BusinessFields } from "./BusinessFields";
import { profileBadge, badgeLabel, fieldNames } from "./profile-badge";
import { StatusPill } from "../app/components";
import { diagnosisCopy, type AccessDiagnosis } from "./onboarding-copy";

const w = strings.he.onboardingWizard;
const cc = strings.he.customerCrud;
const c = strings.he.app.connect;

// AIC-101 — the guided, live-verified Meta connection call. Every check hits
// the real Graph API (server/src/meta/access-probe.ts), never just renders
// instructions — see the module doc there for why that distinction is the
// entire point of this feature. Internal only: this route is admin-gated,
// mounted where the customer never sees it (they're on the phone, looking at
// their OWN Meta settings, while the operator reads the script below).
//
// Deliberately not a strict one-screen-per-step wizard: this is used live, on
// a call, and an operator does not want to click "next" while talking. Every
// section renders at once; a small step indicator just tracks + persists
// where the call currently is, so closing the tab mid-call doesn't lose the
// operator's place (resumable, per the ticket's own requirement).

interface StoredCheck {
  ok: boolean;
  layer: number | null;
  diagnosis: string;
  detail: string | null;
  at: string;
  assetId: string | null;
}
interface OnboardingState {
  customerId: string;
  currentStep: number;
  checks: Partial<Record<"ad_account" | "page" | "instagram" | "token" | "connection", StoredCheck>>;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}
interface CustomerBasics {
  id: string;
  businessName: string;
  // AIC-138: the business profile. GET /admin/customers/:id has always
  // returned these (getCustomerDetail selects the full record) — the wizard
  // simply declared a narrower shape and threw them away.
  category?: string;
  mainService?: string;
  geoArea?: string;
  primaryCustomer?: string;
  offer?: string;
  differentiators?: string;
  objections?: string;
  priceRange?: string;
  copyConstraints?: string;
  leadFollowup?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  isTest?: boolean;
  // Both already returned by GET /admin/customers/:id and previously
  // discarded. Needed so step 4 can tell "no records yet" from "records
  // already exist" — see the alreadyProvisioned guard below.
  //
  // campaignId ALONE is not the signal: a builder shell row has one too, with
  // no Meta campaign behind it. `connectionReadiness === "not_launched"` is
  // exactly that shell-row state (classifyConnectionReadiness returns it when
  // meta_campaign_id is null), so it is what distinguishes them.
  campaignId: string | null;
  connectionReadiness: string | null;
}

// AIC-105 — mirrors server/src/meta/campaign-discovery.ts.
interface AdAccountOption {
  id: string;
  name: string;
  currency: string;
  accountStatus: number | null;
  usedByCustomer: { id: string; name: string } | null;
}
type DetectedDestination =
  | { supported: true; destinationType: "whatsapp" }
  | { supported: true; destinationType: "website"; trackingPixelId: string; leadEventTypes: [string] }
  | { supported: true; destinationType: "engagement"; leadEventTypes: [string] }
  | { supported: false; reason: "no_ad_sets" | "unrecognized_objective" | "mixed_ad_sets" };
type UnsupportedReason = Extract<DetectedDestination, { supported: false }>["reason"];
// `usedByCustomer` is the OTHER customer already connected to this asset, or
// null. Reusing a Page or an IG account across customers is legal — neither
// column is unique — so this never blocks the choice; it only makes a reuse
// impossible to make by accident.
interface InstagramOption {
  id: string;
  username: string;
  usedByCustomer: { id: string; name: string } | null;
}

interface PageOption {
  id: string;
  name: string;
  usedByCustomer: { id: string; name: string } | null;
}
interface DiscoveredCampaign {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string;
  objective: string | null;
  dailyBudgetAgorot: number | null;
  destination: DetectedDestination;
}

// A raw "act_…" id split into its fixed prefix + the digits the operator
// actually types — defensive against pasting the full id including the
// prefix (a very likely paste source: Meta's own URL bar).
const ACT_PREFIX = "act_";
function stripActPrefix(v: string): string {
  return v.trim().startsWith(ACT_PREFIX) ? v.trim().slice(ACT_PREFIX.length) : v.trim();
}

function fmtWhen(iso: string | undefined): string {
  if (!iso) return w.neverChecked;
  return `${w.lastChecked} ${new Date(iso).toLocaleString("he-IL")}`;
}

// One check's result, rendered the same way everywhere it appears — the
// AIC-98 discipline applied here: a diagnosis always gets its own title+body,
// never a bare "failed".
function CheckResult({ check }: { check: StoredCheck | undefined }) {
  if (!check) return <p className="muted" style={{ fontSize: "0.85rem" }}>{w.neverChecked}</p>;
  const copy = diagnosisCopy(check.diagnosis);
  return (
    <div style={{ marginTop: 8 }}>
      <span className={`pill ${check.ok ? "ok" : "warn"}`} style={{ padding: "3px 10px", fontSize: "0.78rem" }}>
        <span className="dot" />{copy.title}
      </span>
      <p className="muted" style={{ fontSize: "0.85rem", marginTop: 6 }}>{copy.body}</p>
      <p className="muted" style={{ fontSize: "0.72rem", marginTop: 4 }}>{fmtWhen(check.at)}</p>
      {check.detail && (
        <details style={{ marginTop: 4 }}>
          <summary className="muted" style={{ fontSize: "0.72rem", cursor: "pointer" }}>{w.technicalDetail}</summary>
          <p className="mono muted" style={{ fontSize: "0.7rem", marginTop: 4 }}>{check.detail}</p>
        </details>
      )}
    </div>
  );
}

export function AdminOnboarding() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [customer, setCustomer] = useState<CustomerBasics | null>(null);
  // AIC-138: the business profile, edited in place at the top of the wizard.
  // `null` until the customer loads, so the inputs are never briefly blank and
  // then repopulated — on a live call that reads as the wizard losing data.
  const [profile, setProfile] = useState<CustomerWriteFields | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileMsg, setProfileMsg] = useState<"saved" | "error" | null>(null);
  // A linked Meta campaign means provisioning already happened — whether via
  // this form or via the builder (AIC-105 Branch A). Either way there is
  // nothing left to create, and trying would violate UNIQUE(customer_id).
  const alreadyProvisioned = !!customer?.campaignId && customer.connectionReadiness !== "not_launched";
  const [state, setState] = useState<OnboardingState | null>(null);
  const [portfolioId, setPortfolioId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [acctId, setAcctId] = useState("");
  const [pageId, setPageId] = useState("");
  // Same role as pageId (step 1/2's check-button value), for Instagram. Kept
  // separate from form.instagramId (step 4's provisioning value) — same split
  // as pageId/pageIdForm, synced on a successful check in runCheck below.
  const [instagramId, setInstagramId] = useState("");
  const [checkingAsset, setCheckingAsset] = useState<"ad_account" | "page" | "instagram" | null>(null);
  const [checkingToken, setCheckingToken] = useState(false);
  const [tokenMissing, setTokenMissing] = useState<string[] | null>(null);

  const [form, setForm] = useState({
    metaAdAccountId: "", pageIdForm: "", instagramId: "",
    metaCampaignId: "", campaignName: "", budgetShekels: "",
    // AIC-103: destinationType drives which fields below are actually
    // required — asked explicitly (default "whatsapp", the P0 recommendation)
    // rather than inferred, since nothing exists yet to infer it from.
    destinationType: "whatsapp" as "whatsapp" | "website" | "engagement",
    whatsappDestination: "",
    leadEventTypes: "", trackingPixelId: "", websiteUrl: "",
  });
  // AIC-105 Branch B — step 4's ad-account/campaign pickers.
  const [adAccounts, setAdAccounts] = useState<AdAccountOption[] | null>(null);
  const [loadingAdAccounts, setLoadingAdAccounts] = useState(false);
  const [adAccountsError, setAdAccountsError] = useState<string | null>(null);
  const [campaigns, setCampaigns] = useState<DiscoveredCampaign[] | null>(null);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [campaignsError, setCampaignsError] = useState<string | null>(null);
  // The Page-side sibling of the ad-account picker (user request): pick from
  // what the System User can actually manage, instead of transcribing a raw
  // Page id out of Meta's own screen.
  // The operator wants to BUILD a campaign on an account that
  // already has some. Adopting stays the default; this is the escape hatch.
  const [forceNewCampaign, setForceNewCampaign] = useState(false);
  const [pages, setPages] = useState<PageOption[] | null>(null);
  // Who else already has the SELECTED page, per picker. Derived rather than
  // stored: the answer must follow the dropdown, and a second piece of state
  // would be one more thing to forget to update.
  const usedByOf = (id: string) => (pages ?? []).find((p) => p.id === id)?.usedByCustomer ?? null;
  const selectedPageUsedBy = usedByOf(pageId);
  const formPageUsedBy = usedByOf(form.pageIdForm);
  const [loadingPages, setLoadingPages] = useState(false);
  const [pagesError, setPagesError] = useState<string | null>(null);
  // Same move for Instagram. Worth a picker for a sharper reason than the
  // Page's: an IG id is 17 digits with no human-readable part, so a typo is
  // both easy to make and impossible to spot by eye — and AIC-108's gate
  // means a bad one flips the whole connection to `revoked`.
  const [igAccounts, setIgAccounts] = useState<InstagramOption[] | null>(null);
  const [loadingIg, setLoadingIg] = useState(false);
  const [igError, setIgError] = useState<string | null>(null);

  const [provisioning, setProvisioning] = useState(false);
  const [provisionResult, setProvisionResult] = useState<string | null>(null);
  // AIC-162: a FAILED provision needs to say so where the button is, exactly
  // as success already does. Separate from `error` (the page header), which is
  // the right home for page-level failures and the wrong one for the outcome
  // of a click.
  const [provisionFailure, setProvisionFailure] = useState<string | null>(null);
  const [provisionBlocked, setProvisionBlocked] = useState<AccessDiagnosis | null>(null);

  // AIC-105 Branch A — the ad account has zero campaigns. Connects the
  // account alone (no campaign fields), then hands off to the guided builder
  // to create the customer's first one.
  const [startingNewCampaign, setStartingNewCampaign] = useState(false);
  const [startNewCampaignError, setStartNewCampaignError] = useState<string | null>(null);
  // AIC-106 gap, found live: nothing asked for this before the operator
  // could reach the builder, so it was only discoverable on the wizard's
  // final click, after the whole thing was filled in. Distinct from the
  // wizard's own budget step (that one is the PROPOSED spend); this is the
  // AGREED ceiling, set once, here, before the builder ever opens.
  const [newCampaignBudgetShekels, setNewCampaignBudgetShekels] = useState("");

  const [finalizing, setFinalizing] = useState(false);
  const [finalizeHealth, setFinalizeHealth] = useState<string | null>(null);
  // AIC-158: health and completion are two facts, not one. AIC-159: loaded
  // with the wizard state, not only after a finalize click, so the header
  // stops claiming completion the moment the page opens.
  const [campaignLinked, setCampaignLinked] = useState(true);

  useEffect(() => {
    if (!id) return;
    api<CustomerBasics>(`/admin/customers/${id}`)
      .then((c) => {
        setCustomer(c);
        // Seeded from the server rather than left blank: this wizard is opened
        // for customers that already exist, so an empty form would invite an
        // operator to retype what we already know — and a blank field saved
        // over a real value is a silent data loss on a live call.
        setProfile({
          businessName: c.businessName ?? "", category: c.category ?? "",
          mainService: c.mainService ?? "", geoArea: c.geoArea ?? "",
          primaryCustomer: c.primaryCustomer ?? "", offer: c.offer ?? "",
          differentiators: c.differentiators ?? "", objections: c.objections ?? "",
          priceRange: c.priceRange ?? "", copyConstraints: c.copyConstraints ?? "",
          leadFollowup: c.leadFollowup ?? "",
          contactName: c.contactName ?? "", contactPhone: c.contactPhone ?? "",
          contactEmail: c.contactEmail ?? "", isTest: c.isTest ?? false,
        });
      })
      .catch(() => {});
    api<{ state: OnboardingState; campaignLinked: boolean; businessPortfolioId: string }>(`/admin/customers/${id}/onboarding`)
      .then((r) => { setState(r.state); setCampaignLinked(r.campaignLinked); setPortfolioId(r.businessPortfolioId); })
      .catch(() => setError(w.errorGeneric));
    loadAdAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // AIC-105 follow-up, found live on a real customer: a passing check
  // persisted `ok: true` forever but never WHAT was checked, so reopening the
  // wizard showed a green "תקין" pill next to an empty field. `recordCheck`
  // now stores the checked id too — prefill from it here, guarded on the
  // field still being empty so this never overwrites live typing.
  useEffect(() => {
    if (!state) return;
    const checkedAcct = state.checks.ad_account?.assetId;
    if (checkedAcct) setAcctId((v) => v || stripActPrefix(checkedAcct));
    const checkedPage = state.checks.page?.assetId;
    if (checkedPage) {
      setPageId((v) => v || checkedPage);
      setForm((f) => (f.pageIdForm ? f : { ...f, pageIdForm: checkedPage }));
    }
  }, [state]);

  // Minimize admin error (user request, 2026-08-18): once the picker's list
  // has loaded, pre-select the SAME ad account already verified in step 1 —
  // the operator should never have to re-pick from a list that can contain
  // another customer's account. Only pre-selects an id genuinely present in
  // the fetched list; an unverified id is never forced into the picker.
  useEffect(() => {
    if (form.metaAdAccountId || !adAccounts || !state) return;
    const checkedAcct = state.checks.ad_account?.assetId;
    if (checkedAcct && adAccounts.some((a) => a.id === checkedAcct)) {
      pickAdAccount(checkedAcct);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adAccounts, state]);

  // Which ad account the Page list is scoped to. Step 4's picked account
  // wins once set; before that, step 1's typed id is what the operator is
  // working against. Refetches whenever it changes, and drops a selected
  // Page that the new account can't promote — leaving a stale one selected
  // is precisely the cross-customer mix-up this scoping exists to stop.
  const pageScopeAccount = form.metaAdAccountId || (acctId.trim() ? `${ACT_PREFIX}${acctId.trim()}` : "");
  const pickedAdAccount = adAccounts?.find((a) => a.id === form.metaAdAccountId) ?? null;
  useEffect(() => {
    loadPages(pageScopeAccount);
    loadInstagram(pageScopeAccount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageScopeAccount]);
  // Drop a selected IG account the newly-picked ad account doesn't have, for
  // the same reason the Page effect below does: a stale selection is exactly
  // the cross-customer mix-up the scoping exists to prevent.
  useEffect(() => {
    if (!igAccounts) return;
    const ok = (v: string) => !v || igAccounts.some((a) => a.id === v);
    if (!ok(instagramId)) setInstagramId("");
    setForm((f) => (ok(f.instagramId) ? f : { ...f, instagramId: "" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [igAccounts]);
  useEffect(() => {
    if (!pages) return;
    const ok = (v: string) => !v || pages.some((p) => p.id === v);
    if (!ok(pageId)) setPageId("");
    setForm((f) => (ok(f.pageIdForm) ? f : { ...f, pageIdForm: "" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);

  // AIC-105 Branch B — step 4's pickers. Loaded eagerly (every wizard section
  // renders at once, per this component's own convention) rather than only
  // once the operator scrolls to step 4, so the list is already there by the
  // time they get there.
  function loadAdAccounts() {
    if (!id) return;
    setLoadingAdAccounts(true);
    setAdAccountsError(null);
    api<{ accounts: AdAccountOption[] }>(`/admin/customers/${id}/onboarding/ad-accounts`)
      .then((r) => setAdAccounts(r.accounts))
      .catch((e) => setAdAccountsError(e instanceof Error ? e.message : w.pickAdAccountError))
      .finally(() => setLoadingAdAccounts(false));
  }

  // Scoped to ONE ad account, deliberately: an unscoped list offered another
  // customer's Page while this customer's account was selected (found live).
  function loadPages(metaAdAccountId: string) {
    if (!id || !metaAdAccountId) { setPages(null); return; }
    setLoadingPages(true);
    setPagesError(null);
    api<{ pages: PageOption[] }>(
      `/admin/customers/${id}/onboarding/pages?metaAdAccountId=${encodeURIComponent(metaAdAccountId)}`,
    )
      .then((r) => setPages(r.pages))
      .catch((e) => setPagesError(e instanceof Error ? e.message : w.pickPageError))
      .finally(() => setLoadingPages(false));
  }

  // Scoped per ad account like the Pages loader, but this edge is scoped by
  // construction so it needs no union: verified live that the two real ad
  // accounts return different results on one token.
  function loadInstagram(metaAdAccountId: string) {
    if (!id || !metaAdAccountId) { setIgAccounts(null); return; }
    setLoadingIg(true);
    setIgError(null);
    api<{ instagramAccounts: InstagramOption[] }>(
      `/admin/customers/${id}/onboarding/instagram-accounts?metaAdAccountId=${encodeURIComponent(metaAdAccountId)}`,
    )
      .then((r) => setIgAccounts(r.instagramAccounts))
      .catch((e) => setIgError(e instanceof Error ? e.message : w.pickInstagramError))
      .finally(() => setLoadingIg(false));
  }

  function loadCampaigns(metaAdAccountId: string) {
    if (!id || !metaAdAccountId) return;
    setLoadingCampaigns(true);
    setCampaignsError(null);
    api<{ campaigns: DiscoveredCampaign[] }>(
      `/admin/customers/${id}/onboarding/campaigns?metaAdAccountId=${encodeURIComponent(metaAdAccountId)}`,
    )
      .then((r) => setCampaigns(r.campaigns))
      // AIC-160: a 429 is Meta throttling this ad account — temporary, and the
      // only correct instruction is "wait and retry". The generic branch would
      // surface Meta's raw English inside a Hebrew console and read like a
      // broken connection, sending the operator to check permissions that are
      // fine. The retry button beside this is already the right next action.
      .catch((e) => setCampaignsError(
        e instanceof ApiError && e.status === 429
          ? w.pickCampaignRateLimited
          : e instanceof Error ? e.message : w.pickCampaignError,
      ))
      .finally(() => setLoadingCampaigns(false));
  }

  function pickAdAccount(metaAdAccountId: string) {
    // Changing the ad account invalidates any campaign already picked under
    // the PREVIOUS one — clearing it rather than leaving a stale, mismatched
    // campaign id silently attached to a different account.
    // The override belongs to the account it was chosen for — carrying it to
    // the next account would silently offer to build on one the operator has
    // not looked at yet.
    setForceNewCampaign(false);
    // The override belongs to the account it was chosen for — carrying it to
    // another account would silently offer to build on one the operator has
    // not looked at yet.
    setForceNewCampaign(false);
    setForm((f) => ({ ...f, metaAdAccountId, metaCampaignId: "" }));
    setCampaigns(null);
    setCampaignsError(null);
    if (metaAdAccountId) loadCampaigns(metaAdAccountId);
  }

  function pickCampaign(metaCampaignId: string) {
    const camp = campaigns?.find((c) => c.id === metaCampaignId);
    setForm((f) => {
      const next = { ...f, metaCampaignId };
      if (!camp) return next;
      // Prefill from Meta's own values — never overwrite something the
      // operator already typed. Budget is deliberately NOT prefilled here:
      // camp.dailyBudgetAgorot is what Meta is CURRENTLY spending, shown
      // read-only below; budgetShekels is the AGREED ceiling
      // (agreed_budget_agorot) and must come from the operator, typed fresh
      // — auto-filling one from the other is exactly the circularity AIC-106
      // flagged (a "ceiling" defined by the number it's meant to constrain).
      if (!f.campaignName) next.campaignName = camp.name;
      if (camp.destination.supported) {
        next.destinationType = camp.destination.destinationType;
        if (camp.destination.destinationType === "website") {
          next.trackingPixelId = camp.destination.trackingPixelId;
          next.leadEventTypes = camp.destination.leadEventTypes.join(",");
        }
        // AIC-107: engagement carries its result definition too, but no
        // pixel/URL — detected, never asked, same rule as the other types.
        if (camp.destination.destinationType === "engagement") {
          next.leadEventTypes = camp.destination.leadEventTypes.join(",");
        }
      }
      return next;
    });
  }

  function campaignUnsupportedReason(reason: UnsupportedReason): string {
    if (reason === "no_ad_sets") return w.campaignUnsupportedNoAdSets;
    if (reason === "mixed_ad_sets") return w.campaignUnsupportedMixedAdSets;
    return w.campaignUnsupportedUnrecognizedObjective;
  }

  function runCheck(asset: "ad_account" | "page" | "instagram", assetId: string) {
    if (!id || !assetId.trim()) return;
    setCheckingAsset(asset);
    setError(null);
    api<{ result: { verdict: { ok: boolean } }; state: OnboardingState }>(
      `/admin/customers/${id}/onboarding/check`,
      { method: "POST", body: JSON.stringify({ asset, assetId: assetId.trim() }) },
    )
      .then((r) => {
        setState(r.state);
        // A page verified in step 1 never needs re-typing in step 4 — carry
        // it over once, without overwriting anything the operator already
        // put in the provisioning form themselves.
        if (asset === "page" && r.result.verdict.ok) {
          setForm((f) => (f.pageIdForm ? f : { ...f, pageIdForm: assetId.trim() }));
        }
        // Same carry-over for Instagram: verified once in step 1/2, never
        // re-typed in step 4.
        if (asset === "instagram" && r.result.verdict.ok) {
          setForm((f) => (f.instagramId ? f : { ...f, instagramId: assetId.trim() }));
        }
        // An ad account that just passed here may not be in the step-4
        // picker's list yet — that list was fetched once, at mount, and this
        // account might only just now be visible to the System User (e.g.
        // step 2 was completed after the page loaded). Re-fetch it so the
        // pre-select effect has a fresh list to match against, instead of
        // requiring the operator to reload the whole page to see it appear.
        if (asset === "ad_account" && r.result.verdict.ok) {
          loadAdAccounts();
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : w.errorGeneric))
      .finally(() => setCheckingAsset(null));
  }

  function runTokenCheck() {
    if (!id) return;
    setCheckingToken(true);
    setError(null);
    api<{ missing: string[] | null; state: OnboardingState }>(
      `/admin/customers/${id}/onboarding/token-check`, { method: "POST", body: "{}" },
    )
      .then((r) => { setState(r.state); setTokenMissing(r.missing); })
      .catch((e) => setError(e instanceof Error ? e.message : w.errorGeneric))
      .finally(() => setCheckingToken(false));
  }

  // AIC-69's rule, made load-bearing on the client too, not just documented
  // in the ⚠️ banner: a page_id the backend can't read flips the whole
  // connection to `revoked`, so a typed-but-unverified id must never even
  // reach the request. Checks the SAME id currently typed, not just "some
  // page check passed at some point" — the operator may have typed a
  // DIFFERENT id after the last passing check.
  function pageIdUnverified(): boolean {
    const typed = form.pageIdForm.trim();
    if (!typed) return false;
    const check = state?.checks.page;
    return !check || !check.ok || check.assetId !== typed;
  }

  // AIC-105 Branch A, found live: an empty page id is a legal (if unusual)
  // shape for CONNECTING an existing campaign — pageIdUnverified() above
  // deliberately doesn't block on empty. But a first campaign genuinely
  // cannot be built without a Page (every ad, WhatsApp or website, runs
  // through one), so "מזהה עמוד (לא חובה)" being labeled optional was
  // misleading for THIS button specifically: an operator who skipped it hit
  // a generic, unhelpful "not ready" screen only after already leaving this
  // page. Blocking here, before the request ever leaves the browser, names
  // the real reason at the one place the operator can still act on it.
  function newCampaignPageMissing(): boolean {
    return !form.pageIdForm.trim();
  }

  // AIC-108: the Instagram twin of pageIdUnverified. Same rule, same reason —
  // an unreadable instagram_id feeds the same worst-health-wins fold and
  // silently stops the engine. Blank is fine and carries no risk (the health
  // check skips a null id entirely); typed means it must have passed for
  // THIS exact id.
  function instagramIdUnverified(): boolean {
    const typed = form.instagramId.trim();
    if (!typed) return false;
    const check = state?.checks.instagram;
    return !check || !check.ok || check.assetId !== typed;
  }

  // AIC-161 — why "יצירת הרשומות" is not pressable yet, derived once from the
  // SAME ordered list its disabled state and its message read.
  //
  // This used to be four `setError` calls inside the click handler, which put
  // the reason ~570 lines up the page in the header — most of a screen above
  // the button. The operator clicked and saw nothing happen. And all four
  // field checks shared `errorGeneric`, which names none of them.
  function provisionBlockedBy(): ReturnType<typeof provisionBlocker> {
    return provisionBlocker({
      adAccountMissing: !form.metaAdAccountId,
      campaignMissing: !form.metaCampaignId,
      nameMissing: !form.campaignName.trim(),
      budgetMissing: !(Math.round(Number(form.budgetShekels) * 100) > 0),
      pageUnverified: pageIdUnverified(),
      instagramUnverified: instagramIdUnverified(),
      // AIC-103: the SAME table resolveAdditionAvailability checks at read
      // time — client-side so the operator sees it before submitting, not
      // after the server's own 400.
      missingConfigFields: missingRequiredFields(
        form.destinationType === "whatsapp" ? FIXED_DESTINATION : WEBSITE_DESTINATION,
        {
          whatsappDestination: form.whatsappDestination.trim() || null,
          websiteUrl: form.websiteUrl.trim() || null,
          trackingPixelId: form.trackingPixelId.trim() || null,
          leadEventTypes: form.leadEventTypes.trim() ? form.leadEventTypes.split(",").map((s) => s.trim()) : null,
        },
      ),
    });
  }

  function provisionBlockerText(b: NonNullable<ReturnType<typeof provisionBlocker>>): string {
    switch (b.reason) {
      case "ad_account_missing": return w.provisionNeedsAdAccount;
      case "campaign_missing": return w.provisionNeedsCampaign;
      case "name_missing": return w.provisionNeedsName;
      case "budget_missing": return w.provisionNeedsBudget;
      case "page_unverified": return w.errorPageNotVerified;
      case "instagram_unverified": return w.errorInstagramNotVerified;
      case "incomplete_config": return `${w.errorIncompleteConfig} (${b.fields.join(", ")})`;
    }
  }

  function submitProvision() {
    if (!id) return;
    const budgetAgorot = Math.round(Number(form.budgetShekels) * 100);
    // Unreachable while the button is disabled on the same condition — kept so
    // the guard cannot be defeated by a future change to the disabled state.
    if (provisionBlockedBy()) return;
    setProvisioning(true);
    setError(null);
    setProvisionBlocked(null);
    setProvisionFailure(null);
    api<{ result: { connectionId: string; campaignId: string; pageIdSaved: boolean } }>(
      `/admin/customers/${id}/onboarding/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          metaAdAccountId: form.metaAdAccountId.trim(),
          // The picker already knows both; not sending them is why every
          // wizard-provisioned ad account stored name='' and rendered as a dash
          // in the customer's connection panel. Null when the id was typed by
          // hand rather than picked — the server COALESCEs to the column
          // defaults, exactly as before.
          adAccountName: pickedAdAccount?.name ?? null,
          currency: pickedAdAccount?.currency ?? null,
          pageId: form.pageIdForm.trim() || null,
          instagramId: form.instagramId.trim() || null,
          metaCampaignId: form.metaCampaignId.trim(),
          campaignName: form.campaignName.trim(),
          agreedBudgetAgorot: budgetAgorot,
          destinationType: form.destinationType,
          whatsappDestination: form.whatsappDestination.trim() || null,
          leadEventTypes: form.leadEventTypes.trim() ? form.leadEventTypes.split(",").map((s) => s.trim()) : null,
          trackingPixelId: form.trackingPixelId.trim() || null,
          websiteUrl: form.websiteUrl.trim() || null,
        }),
      },
    )
      // `goToStep(5)` used to run here. Removed 2026-08-22 with the step
      // indicator: `current_step` is WRITE-ONLY — carried through the DTO but
      // never read to decide anything, since the indicator was its only
      // consumer. It was also actively misleading, because it is what made the
      // wizard announce "step 3 of 5" for a customer whose connection is
      // healthy and whose campaign has been live for a week. Write-only state
      // that nobody reads is exactly what decays into a lie.
      .then(() => { setProvisionResult(w.provisionSuccess); })
      .catch((e) => {
        // A 409 refusal (AIC-69's gate) carries the diagnosis on the body —
        // rendered as its own known reason, not a generic failure message.
        if (e instanceof ApiError && e.status === 409) {
          const body = e.body as { diagnosis?: string } | undefined;
          if (body?.diagnosis) { setProvisionBlocked(body.diagnosis as AccessDiagnosis); return; }
        }
        // The server's own AIC-103 refusal (belt-and-suspenders — the client
        // check above should already have caught this).
        if (e instanceof ApiError && e.status === 400) {
          const body = e.body as { missingFields?: string[] } | undefined;
          if (body?.missingFields?.length) { setError(`${w.errorIncompleteConfig} (${body.missingFields.join(", ")})`); return; }
        }
        // AIC-162 — a refusal the server named, beside the button. This used
        // to fall through to setError, which renders in the PAGE HEADER: the
        // operator saw the button grey for a second and then nothing at all,
        // while a raw Postgres "duplicate key value violates unique
        // constraint" sat a screen above them.
        if (e instanceof ApiError && (e.body as { code?: string } | undefined)?.code === "campaign_already_linked") {
          setProvisionFailure(w.errorCampaignAlreadyLinked);
          return;
        }
        // Anything else is genuinely unexpected. It still goes to the header
        // (where a page-level failure belongs), but a short line beside the
        // button says SOMETHING happened — the absence of that line is what
        // made a failed click read as a click that did nothing.
        setProvisionFailure(w.errorGeneric);
        setError(e instanceof Error ? e.message : w.errorGeneric);
      })
      .finally(() => setProvisioning(false));
  }

  // AIC-105 Branch A: the picked ad account has zero campaigns. Provisions
  // the connection + ad account alone (no campaign fields at all — the
  // extended provision endpoint treats that as "connect only"), then hands
  // off to the guided builder to create the customer's FIRST campaign, the
  // same wizard a self-serve customer would use.
  function newCampaignBudgetMissing(): boolean {
    const n = Number(newCampaignBudgetShekels);
    return !Number.isFinite(n) || n <= 0;
  }

  // Why the build button is dead, in the operator's own terms. Derived once
  // from the SAME ordered list the button's disabled state reads, because a
  // disabled control can never reach the guards inside startNewCampaign — the
  // screen is the only place left that can say why.
  function newCampaignBlockedBy(): ReturnType<typeof newCampaignBlocker> {
    return newCampaignBlocker({
      pageMissing: newCampaignPageMissing(),
      pageUnverified: pageIdUnverified(),
      instagramUnverified: instagramIdUnverified(),
      budgetMissing: newCampaignBudgetMissing(),
    });
  }

  const NEW_CAMPAIGN_BLOCKER_COPY = {
    page_missing: w.errorPageRequiredForNewCampaign,
    page_unverified: w.errorPageNotVerified,
    instagram_unverified: w.errorInstagramNotVerified,
    budget_missing: w.errorNewCampaignBudgetRequired,
  } as const;

  function startNewCampaign() {
    if (!id || !form.metaAdAccountId) return;
    const blocked = newCampaignBlockedBy();
    if (blocked) {
      setStartNewCampaignError(NEW_CAMPAIGN_BLOCKER_COPY[blocked]);
      return;
    }
    setStartingNewCampaign(true);
    setStartNewCampaignError(null);
    setProvisionBlocked(null);
    api<{ result: { connectionId: string } }>(
      `/admin/customers/${id}/onboarding/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          metaAdAccountId: form.metaAdAccountId.trim(),
          // The picker already knows both; not sending them is why every
          // wizard-provisioned ad account stored name='' and rendered as a dash
          // in the customer's connection panel. Null when the id was typed by
          // hand rather than picked — the server COALESCEs to the column
          // defaults, exactly as before.
          adAccountName: pickedAdAccount?.name ?? null,
          currency: pickedAdAccount?.currency ?? null,
          pageId: form.pageIdForm.trim() || null,
          instagramId: form.instagramId.trim() || null,
          agreedBudgetAgorot: Math.round(Number(newCampaignBudgetShekels) * 100),
        }),
      },
    )
      .then(() => nav(`/admin/onboarding/${id}/builder`))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 409) {
          const body = e.body as { diagnosis?: string } | undefined;
          if (body?.diagnosis) { setProvisionBlocked(body.diagnosis as AccessDiagnosis); return; }
        }
        setStartNewCampaignError(e instanceof Error ? e.message : w.errorGeneric);
      })
      .finally(() => setStartingNewCampaign(false));
  }

  function finalize() {
    if (!id) return;
    setFinalizing(true);
    setError(null);
    api<{ health: string; campaignLinked: boolean; state: OnboardingState }>(`/admin/customers/${id}/onboarding/finalize`, {
      method: "POST", body: "{}",
    })
      .then((r) => { setFinalizeHealth(r.health); setCampaignLinked(r.campaignLinked); setState(r.state); })
      .catch((e) => setError(e instanceof Error ? e.message : w.errorGeneric))
      .finally(() => setFinalizing(false));
  }

  if (!id) return null;

  // AIC-105 Branch A: a picked ad account with a confirmed-empty campaign
  // list — the precondition for "צור קמפיין חדש" instead of the picker.
  // AIC-119: which of step 4's two forms applies. Derived by a pure function so
  // it can be tested — see onboarding-step4.ts for why the old boolean was
  // wrong (its negation rendered the adopt-an-existing form by default, before
  // an ad account was even chosen).
  const branch = step4Branch({
    adAccountId: form.metaAdAccountId,
    loading: loadingCampaigns,
    error: campaignsError,
    campaigns: campaigns?.map((c) => ({ supported: c.destination.supported })) ?? null,
    forceNewCampaign,
  });
  // Step 4 offers only the ad account already verified for THIS
  // customer. It used to list every account the System User can reach —
  // another customer's included — guarded by nothing but a note.
  const adAccountChoices = adAccountOptions(adAccounts, state?.checks.ad_account?.assetId);
  // Kept as a name only for the build-a-new-campaign block below; every other
  // site now names its branch directly. The old NEGATION of this flag was the
  // bug — it rendered the adopt-existing form in the three states where we
  // simply don't know yet.
  const noCampaignsForSelectedAccount = branch === "new_campaign";

  return (
    // AIC-120: every other admin page (AdminCustomers, AdminOverview,
    // AdminUsers, AdminMeta, AdminRecommendations, AdminOperators) wraps its
    // root in "wrap page dash" — `.wrap` is what supplies horizontal padding
    // against `.ap-side` (`.ap-content` itself has none, by design, so every
    // routed page owns its own margins). This page used a bare `<div>` and
    // rendered flush against the sidebar. Found live from a screenshot: the
    // step-1 warning box touched the sidebar edge with no gap at all.
    <div className="wrap page dash">
      <Link className="link" to={`/admin/customers`}>{w.backToCustomer}</Link>
      <h1 style={{ margin: "12px 0 4px" }}>{w.title}</h1>
      <p className="muted">{customer?.businessName ?? id} — {w.subtitle}</p>
      {state && state.updatedAt !== state.startedAt && !state.completedAt && (
        <p className="muted" style={{ fontSize: "0.85rem" }}>{w.resumedNote}</p>
      )}
      {/* AIC-159: `completedAt` alone is not evidence. It was written on
          connection health alone until AIC-158, so every customer onboarded
          before that carries one — and this pill rendered it green, at the top
          of the page, above a step 5 that now says the opposite. Requiring
          BOTH self-corrects on load, without writing to anyone's row. */}
      {state?.completedAt && campaignLinked && (
        <div className="pill ok" style={{ marginTop: 10, padding: "4px 12px" }}><span className="dot" />{w.finalizeOk}</div>
      )}
      {state?.completedAt && !campaignLinked && (
        <div className="pill" style={{ marginTop: 10, padding: "4px 12px" }}><span className="dot" />{w.finalizeOkNoCampaign}</div>
      )}
      {error && <p style={{ color: "#c0362c", fontSize: "0.85rem", marginTop: 8 }}>{error}</p>}

      {/* AIC-138: the business profile, FIRST. Everything after it depends on
          it — the builder's recommended defaults key off the category
          (AIC-49) and the ad copy is written from the offer and the target
          audience — so collecting it at the end meant the operator either
          guessed during the call or left the wizard to go and fill in the
          customer card. Same component as the customer card renders, not a
          copy: a second list of these fields would drift, and the drifting
          half would be the one filled in live. */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="row between" style={{ gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
          <b>{w.profileTitle}</b>
          {/* AIC-132: live as the operator types, not after a save — the whole
              value is being able to ask the next question while the customer
              is still on the phone. Names the missing fields rather than
              scoring the profile: "70% complete" tells nobody what to ask. */}
          {profile && (() => {
            const b = profileBadge(profile);
            return (
              <div style={{ textAlign: "start" }}>
                <StatusPill variant={b.state === "ok" ? "ok" : b.state === "thin" ? "neutral" : "warn"}>
                  {badgeLabel(b.state)}
                </StatusPill>
                {b.missing.length > 0 && (
                  <p className="muted" style={{ fontSize: "0.78rem", margin: "6px 0 0" }}>
                    {w.profileMissingPrefix} {fieldNames(b.missing)}
                  </p>
                )}
                {b.vague.length > 0 && (
                  <p className="muted" style={{ fontSize: "0.78rem", margin: "2px 0 0" }}>
                    {w.profileVaguePrefix} {fieldNames(b.vague)}
                  </p>
                )}
              </div>
            );
          })()}
        </div>
        <p className="muted" style={{ fontSize: "0.85rem" }}>{w.profileSub}</p>
        {profile && (
          <form
            style={{ marginTop: 12 }}
            onSubmit={async (e) => {
              e.preventDefault();
              if (!id) return;
              setProfileBusy(true);
              setProfileMsg(null);
              try {
                await updateCustomer(id, profile);
                // Keep the header in step with the form — the page title reads
                // from `customer`, so a renamed business would otherwise still
                // show the old name until a reload.
                setCustomer((c) => (c ? { ...c, businessName: profile.businessName ?? c.businessName } : c));
                setProfileMsg("saved");
              } catch {
                setProfileMsg("error");
              } finally {
                setProfileBusy(false);
              }
            }}
          >
            <BusinessFields form={profile} onChange={setProfile} />
            <div className="row gap12" style={{ marginTop: 12, alignItems: "center" }}>
              <button type="submit" className="btn btn-primary btn-sm" disabled={profileBusy}>
                {profileBusy ? cc.saving : w.profileSave}
              </button>
              {profileMsg === "saved" && <span className="muted" style={{ color: "var(--green)", fontSize: "0.85rem" }}>{w.profileSaved}</span>}
              {profileMsg === "error" && <span style={{ color: "#c0362c", fontSize: "0.85rem" }}>{w.profileError}</span>}
            </div>
          </form>
        )}
      </div>

      {/* Step 1 — customer grants partner access */}
      <div className="card" style={{ marginTop: 12 }}>
        <b>{w.step1Title}</b>
        <p className="muted" style={{ fontSize: "0.85rem" }}>{w.step1Sub}</p>
        {/* Two prerequisites Meta enforces on ITS side that NO check in this
            wizard can see — every access check can pass and the build still
            fail, or worse, succeed and never spend. Both bit a real
            onboarding call on 2026-08-19, which is why this is loud and sits
            at the top of step 1: it is the only moment the customer is on the
            call with their own screen open, and the only moment either is
            cheap to fix. */}
        <div
          style={{
            marginTop: 12, marginBottom: 4, padding: "12px 14px",
            border: "2px solid #c0362c", borderRadius: 8, background: "#fdf3f2",
          }}
        >
          <b style={{ display: "block", marginBottom: 8, color: "#c0362c" }}>
            ⚠️ {w.step1PrereqTitle}
          </b>
          <ul style={{ margin: 0, paddingInlineStart: 20 }}>
            <li style={{ marginBottom: 8 }}>
              <b>WhatsApp:</b> {w.step1PrereqWhatsapp}
            </li>
            <li>
              <b>{w.fieldPaymentLabel}:</b> {w.step1PrereqPayment}
            </li>
          </ul>
          <p className="muted" style={{ fontSize: "0.75rem", margin: "10px 0 0" }}>
            {w.step1PrereqFooter}
          </p>
        </div>
        {/* Same script the customer's own Connect screen shows — one
            definition, so this and the customer-facing copy can never
            silently diverge again (they already have once). */}
        {c.steps.map((line, i) => (
          <div key={i} className="connect-step">
            <div className="idx">{i + 1}</div>
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{line}</div>
              {i === 0 && <a className="link" href="https://business.facebook.com/settings" target="_blank" rel="noreferrer" style={{ fontSize: "0.9rem" }}>{c.openMeta}</a>}
              {i === 2 && (
                <div className="copybox" style={{ marginTop: 10 }}>
                  <span className="mono muted" style={{ fontSize: "0.7rem" }}>{c.businessId}</span>
                  <b>{portfolioId ?? "…"}</b>
                  <button disabled={!portfolioId} onClick={() => { if (portfolioId) { navigator.clipboard?.writeText(portfolioId); setCopied(true); } }}>
                    {copied ? c.copied : c.copy}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}

        <div className="row gap16" style={{ marginTop: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field" style={{ minWidth: 220 }}>
            <label>{w.fieldAdAccountIdStep1}</label>
            <div className="field-prefix-group">
              <span className="prefix">{ACT_PREFIX}</span>
              <input
                value={acctId}
                onChange={(e) => setAcctId(stripActPrefix(e.target.value))}
                inputMode="numeric"
                placeholder="2181076988590009"
              />
            </div>
          </div>
          <button className="btn btn-outline btn-sm" disabled={checkingAsset !== null || !acctId.trim()} onClick={() => runCheck("ad_account", `${ACT_PREFIX}${acctId}`)}>
            {checkingAsset === "ad_account" ? w.checking : w.checkAdAccount}
          </button>
        </div>
        <CheckResult check={state?.checks.ad_account} />

        <div className="row gap16" style={{ marginTop: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field" style={{ minWidth: 260 }}>
            <label>{w.pickPageLabel}</label>
            {/* Same "pick, don't type" move as the step-4 ad-account picker
                (user request): `me/accounts` lists every Page the System
                User can actually manage, so the operator can never mistype
                an id — and a Page that isn't there yet is itself the signal
                that step 1 or 2 hasn't been done for it. */}
            <select value={pageId} onChange={(e) => setPageId(e.target.value)} disabled={loadingPages}>
              <option value="">{w.pickPagePlaceholder}</option>
              {(pages ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.id}){p.usedByCustomer ? ` — ${w.pickAssetUsedBy.replace("{name}", p.usedByCustomer.name)}` : ""}
                </option>
              ))}
            </select>
            {/* Loud, and only once SELECTED. In the option list this is a
                footnote among others; on the chosen row it is the one thing
                the operator needs to have decided on purpose. Still not a
                block — the same Page legitimately backs several customers. */}
            {selectedPageUsedBy && (
              <p style={{ color: "#c0362c", fontWeight: 700, fontSize: "0.85rem", marginTop: 6 }}>
                {w.pickAssetUsedByWarning.replace("{name}", selectedPageUsedBy.name)}
              </p>
            )}
            {loadingPages && <p className="muted" style={{ fontSize: "0.78rem", marginTop: 4 }}>{w.pickPageLoading}</p>}
            {pagesError && (
              <p style={{ color: "#c0362c", fontSize: "0.78rem", marginTop: 4 }}>
                {pagesError}{" "}
                <button type="button" className="btn btn-outline btn-sm" onClick={() => loadPages(pageScopeAccount)}>{w.pickRetry}</button>
              </p>
            )}
            {!pageScopeAccount && (
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: 4 }}>{w.pickPageNeedsAccount}</p>
            )}
            {!loadingPages && !pagesError && pageScopeAccount && pages?.length === 0 && (
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: 4 }}>{w.pickPageEmpty}</p>
            )}
            {/* AIC-98 applied to a SHORT list, not just an empty one. A page
                the operator expects and cannot find is the same failure as an
                empty list, and it looked identical to "there is only one
                page". Says which two conditions a Page must meet to appear,
                so the operator can go fix the right one in Meta. */}
            {!loadingPages && !pagesError && pageScopeAccount && (pages?.length ?? 0) > 0 && (
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: 4 }}>{w.pickPageMissingHint}</p>
            )}
          </div>
          <button className="btn btn-outline btn-sm" disabled={checkingAsset !== null || !pageId.trim()} onClick={() => runCheck("page", pageId)}>
            {checkingAsset === "page" ? w.checking : w.checkPage}
          </button>
        </div>
        <p className="muted" style={{ fontSize: "0.78rem", marginTop: 6 }}>{w.pageRequirementNote}</p>

        {/* Instagram, mirroring the Page picker directly above. Previously
            only reachable in step 4's provisioning form, even though this
            step's own script tells the operator to repeat the sharing step
            for Instagram here — a gap between the copy and the UI it
            described (found live, user report 2026-08-19). Same igAccounts
            list step 4 already loads (scoped to pageScopeAccount), so no new
            fetch — just a second control over data that was already there. */}
        <div className="row gap16" style={{ marginTop: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field" style={{ minWidth: 260 }}>
            <label>{w.fieldInstagramId}</label>
            <select value={instagramId} onChange={(e) => setInstagramId(e.target.value)} disabled={loadingIg}>
              <option value="">{w.pickInstagramPlaceholder}</option>
              {(igAccounts ?? []).map((a) => <option key={a.id} value={a.id}>@{a.username}</option>)}
            </select>
            {loadingIg && <p className="muted" style={{ fontSize: "0.78rem", marginTop: 4 }}>{w.pickInstagramLoading}</p>}
            {igError && (
              <p style={{ color: "#c0362c", fontSize: "0.78rem", marginTop: 4 }}>
                {igError}{" "}
                <button type="button" className="btn btn-outline btn-sm" onClick={() => loadInstagram(pageScopeAccount)}>{w.pickRetry}</button>
              </p>
            )}
            {!pageScopeAccount && (
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: 4 }}>{w.pickPageNeedsAccount}</p>
            )}
            {!loadingIg && !igError && pageScopeAccount && igAccounts?.length === 0 && (
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: 4 }}>{w.pickInstagramEmpty}</p>
            )}
            {/* The list being non-empty is not the same as it containing the
                account the operator wants — same reasoning as the Page hint. */}
            {!loadingIg && !igError && pageScopeAccount && (igAccounts?.length ?? 0) > 0 && (
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: 4 }}>{w.pickInstagramMissingHint}</p>
            )}
          </div>
          <button className="btn btn-outline btn-sm" disabled={checkingAsset !== null || !instagramId.trim()} onClick={() => runCheck("instagram", instagramId)}>
            {checkingAsset === "instagram" ? w.checking : w.checkInstagram}
          </button>
        </div>
        <p className="muted" style={{ fontSize: "0.78rem", marginTop: 6 }}>{w.instagramGateNote}</p>
        <CheckResult check={state?.checks.page} />
      </div>

      {/* Step 2 — we assign to the System User. Same check as step 1's
          buttons (one call verifies all three layers, including this one for
          both asset kinds) — surfaced here too so the operator can confirm
          the assignment worked without scrolling back up. */}
      <div className="card" style={{ marginTop: 12 }}>
        <b>{w.step2Title}</b>
        <p className="muted" style={{ fontSize: "0.85rem" }}>{w.step2Sub}</p>
        {w.step2Script.map((line, i) => <p key={i} style={{ marginTop: i === 0 ? 10 : 6 }}>{line}</p>)}
        <p className="muted" style={{ fontSize: "0.8rem", marginTop: 10 }}>⚠️ {w.step2Warning}</p>

        <p className="muted" style={{ fontSize: "0.85rem", marginTop: 16 }}>{w.step2VerifyIntro}</p>
        <div className="row gap16" style={{ marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn btn-outline btn-sm" disabled={checkingAsset !== null || !acctId.trim()} onClick={() => runCheck("ad_account", `${ACT_PREFIX}${acctId}`)}>
            {checkingAsset === "ad_account" ? w.checking : w.checkAdAccount}
          </button>
          <button className="btn btn-outline btn-sm" disabled={checkingAsset !== null || !pageId.trim()} onClick={() => runCheck("page", pageId)}>
            {checkingAsset === "page" ? w.checking : w.checkPage}
          </button>
          <button className="btn btn-outline btn-sm" disabled={checkingAsset !== null || !instagramId.trim()} onClick={() => runCheck("instagram", instagramId)}>
            {checkingAsset === "instagram" ? w.checking : w.checkInstagram}
          </button>
        </div>
        <CheckResult check={state?.checks.ad_account} />
        <CheckResult check={state?.checks.page} />
        <CheckResult check={state?.checks.instagram} />
      </div>

      {/* Step 3 — token scope check. The one failure assignment can never fix. */}
      <div className="card" style={{ marginTop: 12 }}>
        <b>{w.step3Title}</b>
        <p className="muted" style={{ fontSize: "0.85rem" }}>{w.step3Sub}</p>
        <button className="btn btn-outline btn-sm" style={{ marginTop: 10 }} disabled={checkingToken} onClick={runTokenCheck}>
          {checkingToken ? w.checking : w.checkTokenCta}
        </button>
        <CheckResult check={state?.checks.token} />
        {tokenMissing && tokenMissing.length > 0 && (
          <p className="mono muted" style={{ fontSize: "0.75rem", marginTop: 6 }}>missing: {tokenMissing.join(", ")}</p>
        )}
      </div>

      {/* Step 4 — provisioning (AIC-68). The page_id gate is enforced here,
          not just documented (AIC-69). */}
      <div className="card" style={{ marginTop: 12 }}>
        <b>{w.step4Title}</b>
        <p className="muted" style={{ fontSize: "0.85rem" }}>{w.step4Sub}</p>

        {/* Found live 2026-08-23, straight after the first end-to-end build:
            the operator was returned here and step 4 still presented the whole
            provisioning form — destination radio, four pickers, name, budget,
            WhatsApp number — plus a "יצירת הרשומות" button that could only
            ever fail. managed_campaigns is UNIQUE(customer_id) and that INSERT
            has no ON CONFLICT, so pressing it produced an opaque constraint
            violation.
            The builder already wrote every record. A form that cannot do
            anything is not neutral: it invites an operator to fill it in
            mid-call and then fails. Show what is true instead. */}
        {alreadyProvisioned ? (
          <div
            style={{
              marginTop: 12, padding: "12px 14px", borderRadius: 8,
              border: "1px solid var(--line)", background: "var(--cream-2, #f7f2ea)",
            }}
          >
            <b style={{ display: "block", marginBottom: 6 }}>✓ {w.alreadyProvisionedTitle}</b>
            <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>{w.alreadyProvisionedBody}</p>
          </div>
        ) : (
        <>
        <p className="muted" style={{ fontSize: "0.8rem", marginTop: 8 }}>ℹ️ {w.pageGateNote}</p>

        {/* AIC-103: asked explicitly, in customer-facing language, so the
            operator can put this question directly to the customer on the
            call — drives which fields below are actually required. Only
            meaningful once there's an actual campaign to attach it to
            (Branch A's "no campaigns yet" path asks this inside the builder
            instead — asking twice would be redundant). */}
        {branch === "adopt_existing" && form.destinationType === "engagement" && (
          <p className="muted" style={{ fontSize: "0.85rem", marginTop: 12 }}>ℹ️ {w.destinationEngagementDetected}</p>
        )}
        {branch === "adopt_existing" && form.destinationType !== "engagement" && (
          <div style={{ marginTop: 12 }}>
            <label style={{ display: "block", marginBottom: 6, fontSize: "0.9rem" }}>{w.fieldDestinationType}</label>
            <div className="row gap12">
              <label className="row gap12" style={{ alignItems: "center", cursor: "pointer" }}>
                <input type="radio" name="destinationType" checked={form.destinationType === "whatsapp"}
                  onChange={() => setForm({ ...form, destinationType: "whatsapp" })} />
                {w.destinationWhatsapp}
              </label>
              <label className="row gap12" style={{ alignItems: "center", cursor: "pointer" }}>
                <input type="radio" name="destinationType" checked={form.destinationType === "website"}
                  onChange={() => setForm({ ...form, destinationType: "website" })} />
                {w.destinationWebsite}
              </label>
            </div>
          </div>
        )}

        <div style={{ marginTop: 12, display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          {/* AIC-105 Branch B — pick, don't type. */}
          <div className="field">
            <label>{w.pickAdAccountLabel}</label>
            <select
              value={form.metaAdAccountId}
              onChange={(e) => pickAdAccount(e.target.value)}
              disabled={loadingAdAccounts}
            >
              <option value="">{w.pickAdAccountPlaceholder}</option>
              {adAccountChoices.options.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.id}){a.usedByCustomer ? ` — ${w.pickAdAccountUsedBy.replace("{name}", a.usedByCustomer.name)}` : ""}
                </option>
              ))}
            </select>
            {/* Say WHY only one is here — an unexplained single-option select
                reads as a broken list. Names where to change it, so the
                narrowing is a rule the operator can work with rather than a
                dead end. */}
            {adAccountChoices.scoped && (
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: 4 }}>{w.pickAdAccountScoped}</p>
            )}
            {loadingAdAccounts && <p className="muted" style={{ fontSize: "0.78rem", marginTop: 4 }}>{w.pickAdAccountLoading}</p>}
            {adAccountsError && (
              <p style={{ color: "#c0362c", fontSize: "0.78rem", marginTop: 4 }}>
                {adAccountsError}{" "}
                <button type="button" className="btn btn-outline btn-sm" onClick={loadAdAccounts}>{w.pickRetry}</button>
              </p>
            )}
            {!loadingAdAccounts && !adAccountsError && adAccounts?.length === 0 && (
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: 4 }}>{w.pickAdAccountEmpty}</p>
            )}
          </div>
          <div className="field">
            <label>{w.pickPageLabel}</label>
            <select
              value={form.pageIdForm}
              onChange={(e) => setForm({ ...form, pageIdForm: e.target.value })}
              disabled={loadingPages || !form.metaAdAccountId}
            >
              <option value="">{w.pickPagePlaceholder}</option>
              {(pages ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.id}){p.usedByCustomer ? ` — ${w.pickAssetUsedBy.replace("{name}", p.usedByCustomer.name)}` : ""}
                </option>
              ))}
            </select>
            {/* Loud, and only once SELECTED. In the option list this is a
                footnote among others; on the chosen row it is the one thing
                the operator needs to have decided on purpose. Still not a
                block — the same Page legitimately backs several customers. */}
            {formPageUsedBy && (
              <p style={{ color: "#c0362c", fontWeight: 700, fontSize: "0.85rem", marginTop: 6 }}>
                {w.pickAssetUsedByWarning.replace("{name}", formPageUsedBy.name)}
              </p>
            )}
            {!loadingPages && !pagesError && form.metaAdAccountId && pages?.length === 0 && (
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: 4 }}>{w.pickPageEmpty}</p>
            )}
          </div>
          <div className="field">
            <label>{w.fieldInstagramId}</label>
            <div className="row gap12" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
              <select
                style={{ flex: 1, minWidth: 160 }}
                value={form.instagramId}
                onChange={(e) => setForm({ ...form, instagramId: e.target.value })}
                disabled={!pageScopeAccount || loadingIg}
              >
                <option value="">{w.pickInstagramPlaceholder}</option>
                {(igAccounts ?? []).map((a) => (
                  <option key={a.id} value={a.id}>@{a.username}</option>
                ))}
              </select>
              <button
                type="button" className="btn btn-outline btn-sm"
                disabled={checkingAsset !== null || !form.instagramId.trim()}
                onClick={() => runCheck("instagram", form.instagramId)}
              >
                {checkingAsset === "instagram" ? w.checking : w.checkInstagram}
              </button>
            </div>
            {loadingIg && <p className="muted" style={{ fontSize: "0.78rem", marginTop: 4 }}>{w.pickInstagramLoading}</p>}
            {igError && (
              <p style={{ color: "#c0362c", fontSize: "0.78rem", marginTop: 4 }}>
                {igError}{" "}
                <button type="button" className="btn btn-outline btn-sm" onClick={() => loadInstagram(pageScopeAccount)}>{w.pickRetry}</button>
              </p>
            )}
            {/* An empty list is a real answer, not a blank (AIC-98): no IG
                account is attached to this ad account, which is fixed in Meta
                Business Settings rather than by anything here. */}
            {!loadingIg && !igError && pageScopeAccount && igAccounts?.length === 0 && (
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: 4 }}>{w.pickInstagramEmpty}</p>
            )}
            {/* The list being non-empty is not the same as it containing the
                account the operator wants — same reasoning as the Page hint. */}
            {!loadingIg && !igError && pageScopeAccount && (igAccounts?.length ?? 0) > 0 && (
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: 4 }}>{w.pickInstagramMissingHint}</p>
            )}
            <p className="muted" style={{ fontSize: "0.75rem", marginTop: 4 }}>
              {w.instagramGateNote}
            </p>
            {form.instagramId.trim() && <CheckResult check={state?.checks.instagram} />}
          </div>
          <div className="field">
            <label>{w.pickCampaignLabel}</label>
            <select
              value={form.metaCampaignId}
              onChange={(e) => pickCampaign(e.target.value)}
              disabled={!form.metaAdAccountId || loadingCampaigns}
            >
              <option value="">{w.pickCampaignPlaceholder}</option>
              {(campaigns ?? []).map((c) => (
                <option key={c.id} value={c.id} disabled={!c.destination.supported}>
                  {c.name} — {c.destination.supported
                    ? (c.destination.destinationType === "whatsapp" ? w.destinationWhatsapp
                       : c.destination.destinationType === "engagement" ? w.destinationEngagement
                       : w.destinationWebsite)
                    : campaignUnsupportedReason(c.destination.reason)}
                </option>
              ))}
            </select>
            {loadingCampaigns && <p className="muted" style={{ fontSize: "0.78rem", marginTop: 4 }}>{w.pickCampaignLoading}</p>}
            {campaignsError && (
              <p style={{ color: "#c0362c", fontSize: "0.78rem", marginTop: 4 }}>
                {campaignsError}{" "}
                <button type="button" className="btn btn-outline btn-sm" onClick={() => loadCampaigns(form.metaAdAccountId)}>{w.pickRetry}</button>
              </p>
            )}
            {/* An account that already has campaigns used to make adopting
                one the ONLY reachable path. The builder always
                supported creating another; only the wizard forbade it.

                Lives INSIDE the campaign field, directly under its select.
                As a direct child of the surrounding auto-fit grid it was laid
                out as its own column and rendered under an unrelated field —
                a control that reads as belonging to whatever happens to sit
                above it. */}
            {branch === "adopt_existing" && (
              <p style={{ fontSize: "0.78rem", marginTop: 6 }}>
                <button
                  type="button"
                  onClick={() => { setForceNewCampaign(true); setForm((f) => ({ ...f, metaCampaignId: "" })); }}
                  style={{ background: "none", border: 0, padding: 0, font: "inherit", cursor: "pointer", textDecoration: "underline", color: "inherit" }}
                >
                  {w.buildNewInstead}
                </button>
              </p>
            )}
            {branch === "new_campaign" && (campaigns?.length ?? 0) > 0 && (
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: 6 }}>
                {w.buildingNewNote}{" "}
                <button
                  type="button"
                  onClick={() => setForceNewCampaign(false)}
                  style={{ background: "none", border: 0, padding: 0, font: "inherit", cursor: "pointer", textDecoration: "underline", color: "inherit" }}
                >
                  {w.adoptExistingInstead}
                </button>
              </p>
            )}
            {noCampaignsForSelectedAccount && (
              <div style={{ marginTop: 6 }}>
                {/* Only when it is TRUE. Forcing new-campaign mode on an
                    account that has campaigns reaches this same block, and
                    "no campaigns found" would be a flat contradiction of the
                    select right above it — the line explaining that state is
                    buildingNewNote, printed there. */}
                {(campaigns?.length ?? 0) === 0 && (
                  <p className="muted" style={{ fontSize: "0.78rem" }}>{w.pickCampaignEmpty}</p>
                )}
                {/* AIC-106 gap, found live: this field is what was missing —
                    an operator could complete the entire builder wizard and
                    only discover there was no agreed ceiling on the final
                    click. Required before "צור קמפיין חדש" is enabled, same
                    pattern as the Page/Instagram verification gates above. */}
                <div className="field" style={{ maxWidth: 220, marginTop: 10 }}>
                  <label>{w.newCampaignBudgetLabel}</label>
                  <input
                    type="number" min="0" value={newCampaignBudgetShekels}
                    onChange={(e) => setNewCampaignBudgetShekels(e.target.value)}
                  />
                  <p className="muted" style={{ fontSize: "0.72rem", marginTop: 4 }}>{w.newCampaignBudgetNote}</p>
                </div>
                <button
                  type="button" className="btn btn-primary btn-sm" style={{ marginTop: 10 }}
                  disabled={startingNewCampaign || newCampaignBlockedBy() !== null} onClick={startNewCampaign}
                >
                  {startingNewCampaign ? w.startNewCampaignBusy : w.startNewCampaignCta}
                </button>
                {/* Never disabled without saying why: one reason, from the
                    same list that disabled it. */}
                {newCampaignBlockedBy() && (
                  <p className="muted" style={{ fontSize: "0.72rem", marginTop: 6 }}>
                    {NEW_CAMPAIGN_BLOCKER_COPY[newCampaignBlockedBy()!]}
                  </p>
                )}
                {startNewCampaignError && <p style={{ color: "#c0362c", fontSize: "0.78rem", marginTop: 6 }}>{startNewCampaignError}</p>}
              </div>
            )}
            {form.metaCampaignId && campaigns?.find((c) => c.id === form.metaCampaignId)?.destination.supported && (
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: 4 }}>{w.pickCampaignDetectedNote}</p>
            )}
          </div>
          {branch === "pick_account" && (
            <p className="muted" style={{ fontSize: "0.8rem" }}>{w.pickCampaignNeedsAccount}</p>
          )}
          {branch === "error" && (
            <p className="muted" style={{ fontSize: "0.8rem" }}>{w.pickCampaignFailedNoBranch}</p>
          )}
          {branch === "adopt_existing" && (
            <>
              <div className="field"><label>{w.fieldCampaignName}</label>
                <input value={form.campaignName} onChange={(e) => setForm({ ...form, campaignName: e.target.value })} /></div>
              <div className="field">
                <label>{w.fieldBudget} *</label>
                <input type="number" min="0" value={form.budgetShekels} onChange={(e) => setForm({ ...form, budgetShekels: e.target.value })} />
                {/* AIC-106: shown, never sourced-from — the live Meta figure
                    and the agreed ceiling are deliberately two separate
                    numbers. */}
                {(() => {
                  const live = campaigns?.find((c) => c.id === form.metaCampaignId)?.dailyBudgetAgorot;
                  return live != null
                    ? <p className="muted" style={{ fontSize: "0.78rem", marginTop: 4 }}>{w.fieldLiveBudgetNote.replace("{amount}", String(live / 100))}</p>
                    : null;
                })()}
              </div>
              {form.destinationType === "engagement" ? null : form.destinationType === "whatsapp" ? (
                <div className="field"><label>{w.fieldWhatsappDestination} *</label>
                  <input required value={form.whatsappDestination} onChange={(e) => setForm({ ...form, whatsappDestination: e.target.value })} placeholder="972…" /></div>
              ) : (
                <>
                  <div className="field"><label>{w.fieldLeadEventTypes} *</label>
                    <input required value={form.leadEventTypes} onChange={(e) => setForm({ ...form, leadEventTypes: e.target.value })} /></div>
                  <div className="field"><label>{w.fieldPixelId} *</label>
                    <input required value={form.trackingPixelId} onChange={(e) => setForm({ ...form, trackingPixelId: e.target.value })} /></div>
                  <div className="field">
                    <label>{w.fieldWebsiteUrl} *</label>
                    <input required value={form.websiteUrl} onChange={(e) => setForm({ ...form, websiteUrl: e.target.value })} placeholder="https://…?utm_source=meta&utm_medium=cpc&utm_campaign=…" />
                    <p className="muted" style={{ fontSize: "0.75rem", marginTop: 4 }}>{w.fieldWebsiteUrlUtmNote}</p>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {branch === "adopt_existing" && (
          <>
            <button className="btn btn-primary btn-sm" style={{ marginTop: 14 }} disabled={provisioning || provisionBlockedBy() !== null} onClick={submitProvision}>
              {w.provisionSubmit}
            </button>
            {/* Beside the button, never in the page header: a refusal the
                operator has to scroll to find is a refusal they will read as
                "nothing happened". */}
            {provisionBlockedBy() && (
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: 6 }}>
                {provisionBlockerText(provisionBlockedBy()!)}
              </p>
            )}
          </>
        )}

        {provisionBlocked && (
          <div style={{ marginTop: 10 }}>
            <p style={{ color: "#c0362c", fontSize: "0.85rem" }}>{w.pageGateBlocked}</p>
            <CheckResult check={{ ok: false, layer: null, diagnosis: provisionBlocked, detail: null, assetId: null, at: new Date().toISOString() }} />
          </div>
        )}
        {provisionResult && <p className="muted" style={{ marginTop: 10, fontSize: "0.85rem" }}>{provisionResult}</p>}
        {provisionFailure && <p style={{ marginTop: 10, fontSize: "0.85rem", color: "#c0362c" }}>{provisionFailure}</p>}
        </>
        )}
      </div>

      {/* Step 5 — the same check the recommendation engine relies on. */}
      <div className="card" style={{ marginTop: 12, marginBottom: 24 }}>
        <b>{w.step5Title}</b>
        <p className="muted" style={{ fontSize: "0.85rem" }}>{w.step5Sub}</p>
        <button className="btn btn-primary btn-sm" style={{ marginTop: 10 }} disabled={finalizing} onClick={finalize}>
          {finalizing ? w.finalizing : w.finalizeCta}
        </button>
        {finalizeHealth && (
          <p style={{ marginTop: 10, fontSize: "0.9rem" }}>
            {finalizeHealth === "ok" ? (campaignLinked ? w.finalizeOk : w.finalizeOkNoCampaign) : w.finalizeNotOk}
            {" "}<span className="mono muted" style={{ fontSize: "0.75rem" }}>({finalizeHealth})</span>
          </p>
        )}
      </div>
    </div>
  );
}
