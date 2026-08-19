import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FIXED_DESTINATION, WEBSITE_DESTINATION, missingRequiredFields } from "@aic/shared";
import { api, ApiError } from "../api";
import { strings } from "../strings";
import { diagnosisCopy, type AccessDiagnosis } from "./onboarding-copy";

const w = strings.he.onboardingWizard;
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
interface CustomerBasics { id: string; businessName: string }

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
interface InstagramOption {
  id: string;
  username: string;
}

interface PageOption {
  id: string;
  name: string;
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
  const [pages, setPages] = useState<PageOption[] | null>(null);
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

  useEffect(() => {
    if (!id) return;
    api<CustomerBasics>(`/admin/customers/${id}`).then(setCustomer).catch(() => {});
    api<{ state: OnboardingState; businessPortfolioId: string }>(`/admin/customers/${id}/onboarding`)
      .then((r) => { setState(r.state); setPortfolioId(r.businessPortfolioId); })
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

  function goToStep(n: number) {
    if (!id) return;
    api<{ state: OnboardingState }>(`/admin/customers/${id}/onboarding/step`, {
      method: "POST", body: JSON.stringify({ step: n }),
    }).then((r) => setState(r.state)).catch(() => {});
  }

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
      .catch((e) => setCampaignsError(e instanceof Error ? e.message : w.pickCampaignError))
      .finally(() => setLoadingCampaigns(false));
  }

  function pickAdAccount(metaAdAccountId: string) {
    // Changing the ad account invalidates any campaign already picked under
    // the PREVIOUS one — clearing it rather than leaving a stale, mismatched
    // campaign id silently attached to a different account.
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

  function submitProvision() {
    if (!id) return;
    const budgetAgorot = Math.round(Number(form.budgetShekels) * 100);
    if (!form.metaAdAccountId || !form.metaCampaignId || !form.campaignName || !(budgetAgorot > 0)) {
      setError(w.errorGeneric);
      return;
    }
    if (pageIdUnverified()) {
      setError(w.errorPageNotVerified);
      return;
    }
    if (instagramIdUnverified()) {
      setError(w.errorInstagramNotVerified);
      return;
    }
    // AIC-103: the SAME table/function resolveAdditionAvailability checks at
    // read time — client-side so the operator sees this before submitting,
    // not just after the server's own 400.
    const missing = missingRequiredFields(form.destinationType === "whatsapp" ? FIXED_DESTINATION : WEBSITE_DESTINATION, {
      whatsappDestination: form.whatsappDestination.trim() || null,
      websiteUrl: form.websiteUrl.trim() || null,
      trackingPixelId: form.trackingPixelId.trim() || null,
      leadEventTypes: form.leadEventTypes.trim() ? form.leadEventTypes.split(",").map((s) => s.trim()) : null,
    });
    if (missing.length > 0) {
      setError(`${w.errorIncompleteConfig} (${missing.join(", ")})`);
      return;
    }
    setProvisioning(true);
    setError(null);
    setProvisionBlocked(null);
    api<{ result: { connectionId: string; campaignId: string; pageIdSaved: boolean } }>(
      `/admin/customers/${id}/onboarding/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          metaAdAccountId: form.metaAdAccountId.trim(),
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
      .then(() => { setProvisionResult(w.provisionSuccess); goToStep(5); })
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

  function startNewCampaign() {
    if (!id || !form.metaAdAccountId) return;
    if (newCampaignPageMissing()) {
      setStartNewCampaignError(w.errorPageRequiredForNewCampaign);
      return;
    }
    if (pageIdUnverified()) {
      setStartNewCampaignError(w.errorPageNotVerified);
      return;
    }
    if (instagramIdUnverified()) {
      setStartNewCampaignError(w.errorInstagramNotVerified);
      return;
    }
    if (newCampaignBudgetMissing()) {
      setStartNewCampaignError(w.errorNewCampaignBudgetRequired);
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
    api<{ health: string; state: OnboardingState }>(`/admin/customers/${id}/onboarding/finalize`, {
      method: "POST", body: "{}",
    })
      .then((r) => { setFinalizeHealth(r.health); setState(r.state); })
      .catch((e) => setError(e instanceof Error ? e.message : w.errorGeneric))
      .finally(() => setFinalizing(false));
  }

  if (!id) return null;

  const step = state?.currentStep ?? 1;
  // AIC-105 Branch A: a picked ad account with a confirmed-empty campaign
  // list — the precondition for "צור קמפיין חדש" instead of the picker.
  const noCampaignsForSelectedAccount =
    !loadingCampaigns && !campaignsError && !!form.metaAdAccountId && campaigns?.length === 0;

  return (
    <div>
      <Link className="link" to={`/admin/customers`}>{w.backToCustomer}</Link>
      <h1 style={{ margin: "12px 0 4px" }}>{w.title}</h1>
      <p className="muted">{customer?.businessName ?? id} — {w.subtitle}</p>
      {state && state.updatedAt !== state.startedAt && !state.completedAt && (
        <p className="muted" style={{ fontSize: "0.85rem" }}>{w.resumedNote}</p>
      )}
      {state?.completedAt && (
        <div className="pill ok" style={{ marginTop: 10, padding: "4px 12px" }}><span className="dot" />{w.finalizeOk}</div>
      )}
      {error && <p style={{ color: "#c0362c", fontSize: "0.85rem", marginTop: 8 }}>{error}</p>}

      {/* Step indicator — persists progress, doesn't hide sections */}
      <div className="row gap8" style={{ marginTop: 16, marginBottom: 8, flexWrap: "wrap" }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            className={`btn btn-sm ${n === step ? "btn-primary" : "btn-outline"}`}
            onClick={() => goToStep(n)}
          >
            {w.stepOf.replace("{n}", String(n))}
          </button>
        ))}
      </div>

      {/* Step 1 — customer grants partner access */}
      <div className="card" style={{ marginTop: 12 }}>
        <b>{w.step1Title}</b>
        <p className="muted" style={{ fontSize: "0.85rem" }}>{w.step1Sub}</p>
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
              {(pages ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
            </select>
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
        <p className="muted" style={{ fontSize: "0.8rem", marginTop: 8 }}>ℹ️ {w.pageGateNote}</p>

        {/* AIC-103: asked explicitly, in customer-facing language, so the
            operator can put this question directly to the customer on the
            call — drives which fields below are actually required. Only
            meaningful once there's an actual campaign to attach it to
            (Branch A's "no campaigns yet" path asks this inside the builder
            instead — asking twice would be redundant). */}
        {!noCampaignsForSelectedAccount && form.destinationType === "engagement" && (
          <p className="muted" style={{ fontSize: "0.85rem", marginTop: 12 }}>ℹ️ {w.destinationEngagementDetected}</p>
        )}
        {!noCampaignsForSelectedAccount && form.destinationType !== "engagement" && (
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
              {(adAccounts ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.id}){a.usedByCustomer ? ` — ${w.pickAdAccountUsedBy.replace("{name}", a.usedByCustomer.name)}` : ""}
                </option>
              ))}
            </select>
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
              {(pages ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
            </select>
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
            {noCampaignsForSelectedAccount && (
              <div style={{ marginTop: 6 }}>
                <p className="muted" style={{ fontSize: "0.78rem" }}>{w.pickCampaignEmpty}</p>
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
                  disabled={startingNewCampaign || newCampaignPageMissing() || pageIdUnverified() || instagramIdUnverified() || newCampaignBudgetMissing()} onClick={startNewCampaign}
                >
                  {startingNewCampaign ? w.startNewCampaignBusy : w.startNewCampaignCta}
                </button>
                {newCampaignPageMissing() && <p className="muted" style={{ fontSize: "0.72rem", marginTop: 6 }}>{w.errorPageRequiredForNewCampaign}</p>}
                {!newCampaignPageMissing() && pageIdUnverified() && <p className="muted" style={{ fontSize: "0.72rem", marginTop: 6 }}>{w.errorPageNotVerified}</p>}
                {startNewCampaignError && <p style={{ color: "#c0362c", fontSize: "0.78rem", marginTop: 6 }}>{startNewCampaignError}</p>}
              </div>
            )}
            {form.metaCampaignId && campaigns?.find((c) => c.id === form.metaCampaignId)?.destination.supported && (
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: 4 }}>{w.pickCampaignDetectedNote}</p>
            )}
          </div>
          {!noCampaignsForSelectedAccount && (
            <>
              <div className="field"><label>{w.fieldCampaignName}</label>
                <input value={form.campaignName} onChange={(e) => setForm({ ...form, campaignName: e.target.value })} /></div>
              <div className="field">
                <label>{w.fieldBudget}</label>
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

        {!noCampaignsForSelectedAccount && (
          <>
            <button className="btn btn-primary btn-sm" style={{ marginTop: 14 }} disabled={provisioning || pageIdUnverified() || instagramIdUnverified()} onClick={submitProvision}>
              {w.provisionSubmit}
            </button>
            {pageIdUnverified() && <p className="muted" style={{ fontSize: "0.78rem", marginTop: 6 }}>{w.errorPageNotVerified}</p>}
            {instagramIdUnverified() && <p className="muted" style={{ fontSize: "0.78rem", marginTop: 6 }}>{w.errorInstagramNotVerified}</p>}
          </>
        )}

        {provisionBlocked && (
          <div style={{ marginTop: 10 }}>
            <p style={{ color: "#c0362c", fontSize: "0.85rem" }}>{w.pageGateBlocked}</p>
            <CheckResult check={{ ok: false, layer: null, diagnosis: provisionBlocked, detail: null, assetId: null, at: new Date().toISOString() }} />
          </div>
        )}
        {provisionResult && <p className="muted" style={{ marginTop: 10, fontSize: "0.85rem" }}>{provisionResult}</p>}
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
            {finalizeHealth === "ok" ? w.finalizeOk : w.finalizeNotOk}
            {" "}<span className="mono muted" style={{ fontSize: "0.75rem" }}>({finalizeHealth})</span>
          </p>
        )}
      </div>
    </div>
  );
}
