import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { formatShekel } from "@aic/shared";
import {
  api, getAdminRecommendations, flagRecommendation, unflagRecommendation, getOutcomeSummary,
  type AdminRecRow, type OutcomeAggregateRow, type OutcomeVerdict,
} from "../api";
import { strings } from "../strings";

const r = strings.he.recsOversight;
const a = strings.he.admin;
const o = r.outcome;
const os = r.outcomeSummary;

interface CustomerOption { id: string; businessName: string }

const money = (agorot: number | null) => (agorot === null ? a.noData : formatShekel(agorot));
const STATES = ["proposed", "approved", "executing", "executed", "failed", "dismissed", "expired"];
const TYPES = ["pause_creative", "pause_adset", "increase_budget", "decrease_budget", "replace_creative", "no_action", "add_creatives_for_comparison"];
const VERDICTS: OutcomeVerdict[] = ["improved", "degraded", "neutral", "confounded", "insufficient_data", "not_measurable"];
const pct = (v: number | null) => (v === null ? a.noData : `${v > 0 ? "+" : ""}${v}%`);

// Recommendations oversight (AIC-46): every recommendation the engine has
// produced, across every customer, with its evidence and lifecycle status.
// Deliberately read + flag only — no operator-initiated approve/execute (see
// server/src/services/recommendation-oversight.ts for why).
export function AdminRecommendations() {
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [rows, setRows] = useState<AdminRecRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [stateFilter, setStateFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [customerFilter, setCustomerFilter] = useState("");
  const [selected, setSelected] = useState<AdminRecRow | null>(null);
  const [flagNote, setFlagNote] = useState("");
  const [flagBusy, setFlagBusy] = useState(false);
  const [outcomeSummary, setOutcomeSummary] = useState<OutcomeAggregateRow[]>([]);

  useEffect(() => {
    api<{ customers: CustomerOption[] }>("/admin/customers").then((res) => setCustomers(res.customers));
    getOutcomeSummary().then((res) => setOutcomeSummary(res.byType));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getAdminRecommendations({ state: stateFilter, type: typeFilter, customerId: customerFilter });
    setRows(res.recommendations);
    setLoading(false);
  }, [stateFilter, typeFilter, customerFilter]);

  useEffect(() => { load(); }, [load]);

  function select(row: AdminRecRow) {
    setSelected(row);
    setFlagNote(row.flagNote ?? "");
  }

  async function toggleFlag() {
    if (!selected) return;
    setFlagBusy(true);
    try {
      if (selected.flaggedForReview) await unflagRecommendation(selected.id);
      else await flagRecommendation(selected.id, flagNote.trim());
      await load();
      const fresh = (await getAdminRecommendations({ state: stateFilter, type: typeFilter, customerId: customerFilter })).recommendations.find((x) => x.id === selected.id);
      setSelected(fresh ?? null);
    } finally {
      setFlagBusy(false);
    }
  }

  return (
    <div className="wrap page dash">
      <h1 className="dash-title">{r.title}</h1>
      <p className="muted">{r.subtitle}</p>

      <div className="card" style={{ marginBottom: 16 }}>
        <b style={{ fontSize: "0.95rem" }}>{os.title}</b>
        <p className="muted" style={{ margin: "4px 0 10px", fontSize: "0.85rem" }}>{os.disclaimer}</p>
        {outcomeSummary.length === 0 ? <p className="muted">{os.empty}</p> : (
          <table className="op-table">
            <thead>
              <tr>
                <th>{os.colType}</th>
                <th>{os.colExecuted}</th>
                {VERDICTS.map((v) => <th key={v}>{o.verdictLabels[v]}</th>)}
              </tr>
            </thead>
            <tbody>
              {outcomeSummary.map((row) => (
                <tr key={row.type} style={{ cursor: "default" }}>
                  <td>{r.typeLabels[row.type] ?? row.type}</td>
                  <td>{row.executed}</td>
                  {VERDICTS.map((v) => <td key={v}>{row.byVerdict[v] ?? 0}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="row" style={{ gap: 10, margin: "14px 0", flexWrap: "wrap" }}>
        <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} style={{ padding: "8px 12px", borderRadius: 10, border: "1.5px solid var(--line)" }}>
          <option value="">{r.filterState}: {r.all}</option>
          {STATES.map((s) => <option key={s} value={s}>{r.stateLabels[s] ?? s}</option>)}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={{ padding: "8px 12px", borderRadius: 10, border: "1.5px solid var(--line)" }}>
          <option value="">{r.filterType}: {r.all}</option>
          {TYPES.map((t) => <option key={t} value={t}>{r.typeLabels[t] ?? t}</option>)}
        </select>
        <select value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} style={{ padding: "8px 12px", borderRadius: 10, border: "1.5px solid var(--line)" }}>
          <option value="">{r.filterCustomer}: {r.all}</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.businessName}</option>)}
        </select>
      </div>

      <div className="card">
        {loading ? <p className="muted">{a.loading}</p> : rows.length === 0 ? <p className="muted">{r.noResults}</p> : (
          <table className="op-table">
            <thead>
              <tr>
                <th>{r.business}</th>
                <th>{r.type}</th>
                <th>{r.state}</th>
                <th>{r.impact}</th>
                <th>{r.created}</th>
                <th>{r.flagged}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={selected?.id === row.id ? "selected" : ""} onClick={() => select(row)}>
                  <td>{row.businessName}</td>
                  <td>{r.typeLabels[row.type] ?? row.type}</td>
                  <td className={row.state === "failed" ? "op-sev-high" : undefined}>{r.stateLabels[row.state] ?? row.state}</td>
                  <td>{money(row.maxSpendImpactAgorot)}</td>
                  <td>{new Date(row.createdAt).toLocaleDateString("he-IL")}</td>
                  <td>{row.flaggedForReview ? "🚩" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="row between">
            <b style={{ fontSize: "1.1rem" }}>{selected.businessName} — {r.typeLabels[selected.type] ?? selected.type}</b>
            <button className="btn btn-outline btn-sm" onClick={() => setSelected(null)}>✕</button>
          </div>
          <p className="muted" style={{ marginTop: 6 }}>{r.state}: {r.stateLabels[selected.state] ?? selected.state} · {selected.campaignName}</p>

          <div className="grid-2" style={{ marginTop: 14 }}>
            <div>
              <div className="summary-row"><span className="k">{r.currentBudget}</span><span>{money(selected.currentBudgetAgorot)}</span></div>
              <div className="summary-row"><span className="k">{r.proposedBudget}</span><span>{money(selected.proposedBudgetAgorot)}</span></div>
              <div className="summary-row"><span className="k">{r.impact}</span><span>{money(selected.maxSpendImpactAgorot)}</span></div>
              <div className="summary-row"><span className="k">{r.rationale}</span><span>{selected.rationale || a.noData}</span></div>
            </div>
            <div>
              <div className="summary-row"><span className="k">{r.approvedBy}</span><span>{selected.approvedBy ?? a.noData}</span></div>
              <div className="summary-row"><span className="k">{r.executedAt}</span><span>{selected.executedAt ? new Date(selected.executedAt).toLocaleString("he-IL") : a.noData}</span></div>
              <div className="summary-row"><span className="k">{r.executionResult}</span><span>{selected.executionResult ?? a.noData}</span></div>
            </div>
          </div>

          {selected.actionHistoryId && (
            <p style={{ margin: "10px 0" }}>
              <Link className="link" to={`/admin/customers?focus=${selected.customerId}`}>{r.viewActionHistory}</Link>
            </p>
          )}

          {selected.state === "executed" && (
            <div style={{ margin: "14px 0", paddingTop: 14, borderTop: "1px solid var(--line)" }}>
              <b style={{ fontSize: "0.9rem" }}>{o.sectionTitle}</b>
              {!selected.outcome ? (
                <p className="muted" style={{ marginTop: 6 }}>{o.notYetMeasured}</p>
              ) : (
                <>
                  <p className="muted" style={{ margin: "6px 0" }}>{o.disclaimer}</p>
                  <div className="summary-row"><span className="k">{r.state}</span><span>{o.verdictLabels[selected.outcome.verdict]}</span></div>
                  <div className="summary-row"><span className="k">{o.cplBefore}</span><span>{money(selected.outcome.beforeFeatures.cplAgorot)}</span></div>
                  <div className="summary-row"><span className="k">{o.cplAfter}</span><span>{money(selected.outcome.afterFeatures.cplAgorot)}</span></div>
                  <div className="summary-row"><span className="k">{o.delta}</span><span>{pct(selected.outcome.delta.cplPct)}</span></div>
                  <div className="summary-row"><span className="k">{o.window}</span><span>{selected.outcome.beforeStart}…{selected.outcome.beforeEnd} → {selected.outcome.afterStart}…{selected.outcome.afterEnd}</span></div>
                  <div className="summary-row"><span className="k">{o.measuredAt}</span><span>{new Date(selected.outcome.measuredAt).toLocaleDateString("he-IL")}</span></div>
                  {selected.outcome.confoundDetail && (
                    <div style={{ marginTop: 8 }}>
                      <b style={{ fontSize: "0.85rem" }}>{o.confoundTitle}</b>
                      <ul style={{ margin: "4px 0 0", paddingInlineStart: 18 }}>
                        {(selected.outcome.confoundDetail.otherActions ?? []).map((a2, i) => (
                          <li key={`a-${i}`} className="muted" style={{ fontSize: "0.85rem" }}>
                            {o.confoundOtherAction}: {a2.actionType} — {new Date(a2.occurredAt).toLocaleDateString("he-IL")}
                          </li>
                        ))}
                        {(selected.outcome.confoundDetail.zeroSpendDays ?? []).map((d) => (
                          <li key={`z-${d}`} className="muted" style={{ fontSize: "0.85rem" }}>{o.confoundZeroSpend}: {d}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <b style={{ fontSize: "0.9rem" }}>{r.evidence}</b>
          <table className="op-table">
            <tbody>
              {Object.entries(selected.evidence).map(([k, v]) => (
                <tr key={k} style={{ cursor: "default" }}>
                  <td style={{ fontWeight: 600 }}>{k}</td>
                  <td>{typeof v === "object" ? JSON.stringify(v) : String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
            {!selected.flaggedForReview && (
              <div className="field" style={{ maxWidth: 420, marginBottom: 10 }}>
                <label>{r.flagNoteLabel}</label>
                <input value={flagNote} onChange={(e) => setFlagNote(e.target.value)} placeholder={r.flagNotePlaceholder} />
              </div>
            )}
            <button className="btn btn-outline btn-sm" disabled={flagBusy} onClick={toggleFlag}>
              {selected.flaggedForReview ? r.unflagButton : r.flagButton}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
