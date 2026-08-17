import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
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
}
interface OnboardingState {
  customerId: string;
  currentStep: number;
  checks: Partial<Record<"ad_account" | "page" | "token" | "connection", StoredCheck>>;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}
interface CustomerBasics { id: string; businessName: string }

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
  const [customer, setCustomer] = useState<CustomerBasics | null>(null);
  const [state, setState] = useState<OnboardingState | null>(null);
  const [portfolioId, setPortfolioId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [acctId, setAcctId] = useState("");
  const [pageId, setPageId] = useState("");
  const [checkingAsset, setCheckingAsset] = useState<"ad_account" | "page" | null>(null);
  const [checkingToken, setCheckingToken] = useState(false);
  const [tokenMissing, setTokenMissing] = useState<string[] | null>(null);

  const [form, setForm] = useState({
    metaAdAccountId: "", pageIdForm: "", instagramId: "",
    metaCampaignId: "", campaignName: "", budgetShekels: "",
    leadEventTypes: "", trackingPixelId: "", websiteUrl: "",
  });
  const [provisioning, setProvisioning] = useState(false);
  const [provisionResult, setProvisionResult] = useState<string | null>(null);
  const [provisionBlocked, setProvisionBlocked] = useState<AccessDiagnosis | null>(null);

  const [finalizing, setFinalizing] = useState(false);
  const [finalizeHealth, setFinalizeHealth] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api<CustomerBasics>(`/admin/customers/${id}`).then(setCustomer).catch(() => {});
    api<{ state: OnboardingState; businessPortfolioId: string }>(`/admin/customers/${id}/onboarding`)
      .then((r) => { setState(r.state); setPortfolioId(r.businessPortfolioId); })
      .catch(() => setError(w.errorGeneric));
  }, [id]);

  function goToStep(n: number) {
    if (!id) return;
    api<{ state: OnboardingState }>(`/admin/customers/${id}/onboarding/step`, {
      method: "POST", body: JSON.stringify({ step: n }),
    }).then((r) => setState(r.state)).catch(() => {});
  }

  function runCheck(asset: "ad_account" | "page", assetId: string) {
    if (!id || !assetId.trim()) return;
    setCheckingAsset(asset);
    setError(null);
    api<{ result: { verdict: { ok: boolean } }; state: OnboardingState }>(
      `/admin/customers/${id}/onboarding/check`,
      { method: "POST", body: JSON.stringify({ asset, assetId: assetId.trim() }) },
    )
      .then((r) => setState(r.state))
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

  function submitProvision() {
    if (!id) return;
    const budgetAgorot = Math.round(Number(form.budgetShekels) * 100);
    if (!form.metaAdAccountId || !form.metaCampaignId || !form.campaignName || !(budgetAgorot > 0)) {
      setError(w.errorGeneric);
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
        setError(e instanceof Error ? e.message : w.errorGeneric);
      })
      .finally(() => setProvisioning(false));
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
            <label>{w.fieldAdAccountId}</label>
            <input value={acctId} onChange={(e) => setAcctId(e.target.value)} placeholder="act_…" />
          </div>
          <button className="btn btn-outline btn-sm" disabled={checkingAsset !== null || !acctId.trim()} onClick={() => runCheck("ad_account", acctId)}>
            {checkingAsset === "ad_account" ? w.checking : w.checkAdAccount}
          </button>
        </div>
        <CheckResult check={state?.checks.ad_account} />

        <div className="row gap16" style={{ marginTop: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field" style={{ minWidth: 220 }}>
            <label>{w.fieldPageId}</label>
            <input value={pageId} onChange={(e) => setPageId(e.target.value)} />
          </div>
          <button className="btn btn-outline btn-sm" disabled={checkingAsset !== null || !pageId.trim()} onClick={() => runCheck("page", pageId)}>
            {checkingAsset === "page" ? w.checking : w.checkPage}
          </button>
        </div>
        <CheckResult check={state?.checks.page} />
      </div>

      {/* Step 2 — we assign to the System User. No separate check button: the
          probe above already verifies layer 2 as part of the same call. */}
      <div className="card" style={{ marginTop: 12 }}>
        <b>{w.step2Title}</b>
        <p className="muted" style={{ fontSize: "0.85rem" }}>{w.step2Sub}</p>
        {w.step2Script.map((line, i) => <p key={i} style={{ marginTop: i === 0 ? 10 : 6 }}>{line}</p>)}
        <p className="muted" style={{ fontSize: "0.8rem", marginTop: 10 }}>⚠️ {w.step2Warning}</p>
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

        <div style={{ marginTop: 12, display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <div className="field"><label>{w.fieldAdAccountId}</label>
            <input value={form.metaAdAccountId} onChange={(e) => setForm({ ...form, metaAdAccountId: e.target.value })} placeholder="act_…" /></div>
          <div className="field"><label>{w.fieldPageId}</label>
            <input value={form.pageIdForm} onChange={(e) => setForm({ ...form, pageIdForm: e.target.value })} /></div>
          <div className="field"><label>{w.fieldInstagramId}</label>
            <input value={form.instagramId} onChange={(e) => setForm({ ...form, instagramId: e.target.value })} /></div>
          <div className="field"><label>{w.fieldCampaignId}</label>
            <input value={form.metaCampaignId} onChange={(e) => setForm({ ...form, metaCampaignId: e.target.value })} /></div>
          <div className="field"><label>{w.fieldCampaignName}</label>
            <input value={form.campaignName} onChange={(e) => setForm({ ...form, campaignName: e.target.value })} /></div>
          <div className="field"><label>{w.fieldBudget}</label>
            <input type="number" min="0" value={form.budgetShekels} onChange={(e) => setForm({ ...form, budgetShekels: e.target.value })} /></div>
          <div className="field"><label>{w.fieldLeadEventTypes}</label>
            <input value={form.leadEventTypes} onChange={(e) => setForm({ ...form, leadEventTypes: e.target.value })} /></div>
          <div className="field"><label>{w.fieldPixelId}</label>
            <input value={form.trackingPixelId} onChange={(e) => setForm({ ...form, trackingPixelId: e.target.value })} /></div>
          <div className="field"><label>{w.fieldWebsiteUrl}</label>
            <input value={form.websiteUrl} onChange={(e) => setForm({ ...form, websiteUrl: e.target.value })} placeholder="https://…" /></div>
        </div>

        <button className="btn btn-primary btn-sm" style={{ marginTop: 14 }} disabled={provisioning} onClick={submitProvision}>
          {w.provisionSubmit}
        </button>

        {provisionBlocked && (
          <div style={{ marginTop: 10 }}>
            <p style={{ color: "#c0362c", fontSize: "0.85rem" }}>{w.pageGateBlocked}</p>
            <CheckResult check={{ ok: false, layer: null, diagnosis: provisionBlocked, detail: null, at: new Date().toISOString() }} />
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
