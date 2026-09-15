import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { strings } from "../strings";

const b = strings.he.onboardingWizard.bulk;

// AIC-190 — import every campaign on the ad account at once.
//
// The preview is computed by the SERVER with `dryRun: true`, by the same
// planner the import runs. A preview computed in the browser would be a second
// implementation of "what gets imported" — and a preview that can disagree with
// what then happens is worse than none.

type Destination = "whatsapp" | "website" | "engagement";
interface Planned {
  metaCampaignId: string; campaignName: string; agreedBudgetAgorot: number;
  budgetSource: "meta" | "fallback"; destinationType: Destination; effectiveStatus: string;
}
interface Skipped { metaCampaignId: string; campaignName: string; reason: keyof typeof b.skip }
interface Plan { adopt: Planned[]; skip: Skipped[] }
interface Result { metaCampaignId: string; campaignName: string; outcome: keyof typeof b.outcome; detail?: string }

export interface BulkImportProps {
  customerId: string;
  metaAdAccountId: string;
  adAccountName: string | null;
  currency: string | null;
  pageId: string | null;
  instagramId: string | null;
  initialWhatsapp: string;
  destinationLabel: (d: Destination) => string;
  onClose: () => void;
  onImported: () => void;
}

export function BulkImportPanel(p: BulkImportProps) {
  const [whatsapp, setWhatsapp] = useState(p.initialWhatsapp);
  const [budgetShekels, setBudgetShekels] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function body(dryRun: boolean) {
    const shekels = Number(budgetShekels);
    return JSON.stringify({
      dryRun,
      metaAdAccountId: p.metaAdAccountId,
      adAccountName: p.adAccountName,
      currency: p.currency,
      pageId: p.pageId,
      instagramId: p.instagramId,
      whatsappDestination: whatsapp.trim() || null,
      fallbackBudgetAgorot: budgetShekels.trim() && shekels > 0 ? Math.round(shekels * 100) : null,
    });
  }

  function explain(e: unknown): string {
    if (e instanceof ApiError && (e.body as { code?: string } | undefined)?.code === "meta_rate_limited") return b.rateLimited;
    if (e instanceof ApiError && typeof (e.body as { error?: string } | undefined)?.error === "string") {
      return (e.body as { error: string }).error;
    }
    return b.failed;
  }

  function preview() {
    setLoading(true);
    setError(null);
    api<{ plan: Plan }>(`/admin/customers/${p.customerId}/onboarding/provision-all`, { method: "POST", body: body(true) })
      .then((r) => setPlan(r.plan))
      .catch((e) => setError(explain(e)))
      .finally(() => setLoading(false));
  }

  // First preview on open, with whatever the wizard already knows.
  useEffect(preview, []); // eslint-disable-line react-hooks/exhaustive-deps

  function runImport() {
    setImporting(true);
    setError(null);
    api<{ plan: Plan; results: Result[] }>(`/admin/customers/${p.customerId}/onboarding/provision-all`, { method: "POST", body: body(false) })
      .then((r) => { setPlan(r.plan); setResults(r.results); p.onImported(); })
      .catch((e) => setError(explain(e)))
      .finally(() => setImporting(false));
  }

  // Only ask for what some campaign actually needs.
  const needsWhatsapp = !!plan && (
    plan.skip.some((s) => s.reason === "missing_whatsapp") || plan.adopt.some((a) => a.destinationType === "whatsapp")
  );
  const needsBudget = !!plan && (
    plan.skip.some((s) => s.reason === "no_budget") || plan.adopt.some((a) => a.budgetSource === "fallback")
  );

  return (
    <div className="op-modal-backdrop" onClick={p.onClose}>
      <div className="op-modal" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ fontSize: "1.15rem" }}>{b.title}</h3>
        <p className="muted" style={{ fontSize: "0.85rem", margin: "8px 0 16px" }}>{b.sub}</p>

        {(needsWhatsapp || needsBudget) && !results && (
          <div style={{ display: "grid", gap: 12, marginBottom: 12 }}>
            {needsWhatsapp && (
              <div className="field">
                <label>{b.whatsappLabel}</label>
                <input value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} inputMode="tel" placeholder="9725XXXXXXXX" />
                <span className="muted" style={{ fontSize: "0.75rem" }}>{b.whatsappHint}</span>
              </div>
            )}
            {needsBudget && (
              <div className="field">
                <label>{b.budgetLabel}</label>
                <input value={budgetShekels} onChange={(e) => setBudgetShekels(e.target.value)} inputMode="decimal" placeholder="30" />
                <span className="muted" style={{ fontSize: "0.75rem" }}>{b.budgetHint}</span>
              </div>
            )}
            <div>
              <button type="button" className="btn btn-outline btn-sm" onClick={preview} disabled={loading}>{b.refresh}</button>
            </div>
          </div>
        )}

        {loading && <p className="muted">{b.loading}</p>}
        {error && <p role="alert" style={{ color: "#c0362c", fontSize: "0.85rem" }}>{error}</p>}

        {plan && !loading && !results && (
          <>
            <h4 style={{ fontSize: "0.95rem", marginTop: 8 }}>{b.willImport(plan.adopt.length)}</h4>
            {plan.adopt.length === 0 && <p className="muted" style={{ fontSize: "0.85rem" }}>{b.nothingToImport}</p>}
            <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 14px", display: "grid", gap: 6 }}>
              {plan.adopt.map((a) => (
                <li key={a.metaCampaignId} className="summary-row" style={{ fontSize: "0.85rem" }}>
                  <span>✓ {a.campaignName} <span className="muted">· {p.destinationLabel(a.destinationType)}</span></span>
                  <span className="muted">
                    ₪{(a.agreedBudgetAgorot / 100).toLocaleString("he-IL")} · {a.budgetSource === "meta" ? b.budgetFromMeta : b.budgetFromFallback}
                  </span>
                </li>
              ))}
            </ul>
            {plan.skip.length > 0 && (
              <>
                <h4 style={{ fontSize: "0.95rem" }}>{b.willSkip(plan.skip.length)}</h4>
                <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 14px", display: "grid", gap: 6 }}>
                  {plan.skip.map((s) => (
                    <li key={s.metaCampaignId} className="summary-row" style={{ fontSize: "0.85rem" }}>
                      <span>— {s.campaignName}</span>
                      <span className="muted">{b.skip[s.reason] ?? s.reason}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        {results && (
          <>
            <h4 style={{ fontSize: "0.95rem", marginTop: 8 }}>{b.resultTitle}</h4>
            <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 14px", display: "grid", gap: 6 }}>
              {results.map((r) => (
                <li key={r.metaCampaignId} className="summary-row" style={{ fontSize: "0.85rem" }}>
                  <span>{r.campaignName}</span>
                  <span style={{ color: r.outcome === "failed" ? "#c0362c" : undefined }}>
                    {b.outcome[r.outcome]}{r.detail ? ` · ${r.detail}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="row gap12" style={{ justifyContent: "flex-end", marginTop: 8 }}>
          <button type="button" className="btn btn-ghost" onClick={p.onClose}>{b.cancel}</button>
          {!results && (
            <button
              type="button" className="btn btn-primary"
              disabled={!plan || plan.adopt.length === 0 || importing || loading}
              onClick={runImport}
            >
              {importing ? b.importing : b.confirm(plan?.adopt.length ?? 0)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
