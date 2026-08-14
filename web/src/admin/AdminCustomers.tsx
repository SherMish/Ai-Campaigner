import { useEffect, useState, useCallback, type FormEvent } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { formatShekel } from "@aic/shared";
import {
  api,
  createCustomer, updateCustomer, deactivateCustomer, reactivateCustomer, deleteCustomer, getCustomerAudit,
  type CustomerWriteFields, type AuditEntry,
} from "../api";
import { strings } from "../strings";

const t = strings.he.ops;
const a = strings.he.admin;
const cc = strings.he.customerCrud;

// The 13 recommendation-engine thresholds (AIC-77a, server/src/recommendations/
// rules.ts's RULE_THRESHOLDS), grouped for the edit form the same way they're
// grouped in RULES.md — one editable number input per key, blank = no override.
const THRESHOLD_GROUPS: Array<{ label: string; keys: string[] }> = [
  { label: cc.thresholds.groupEvidence, keys: ["MIN_DAYS_DATA", "MIN_DELIVERY_DAYS", "MIN_CAMPAIGN_LEADS"] },
  { label: cc.thresholds.groupCreative, keys: ["MIN_CREATIVE_SPEND_AGOROT", "PAUSE_MIN_PEERS", "PAUSE_WEAK_CPL_MULTIPLIER", "REPLACE_DECAY_MULTIPLIER"] },
  { label: cc.thresholds.groupAudience, keys: ["AUDIENCE_MIN_SPEND_AGOROT", "AUDIENCE_MIN_LEADS", "AUDIENCE_CPL_MULTIPLIER"] },
  { label: cc.thresholds.groupBudget, keys: ["BUDGET_CPL_RISE_PCT", "BUDGET_INCREASE_STEP", "BUDGET_DECREASE_STEP"] },
];

interface CustomerRow {
  id: string;
  businessName: string;
  category: string;
  isTest: boolean;
  isActive: boolean;
  deactivatedAt: string | null;
  subscriptionStatus: string | null;
  accessHealth: string | null;
  campaignStatus: string | null;
  campaignId: string | null;
  agreedBudgetAgorot: number | null;
  openRecommendations: number;
}

// Full record (AIC-44): the list row plus everything only the detail route
// returns — business/contact detail, next charge date, open ops count.
interface CustomerDetail extends CustomerRow {
  mainService: string;
  geoArea: string;
  primaryCustomer: string;
  offer: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  nextChargeDate: string | null;
  openOpsItems: number;
  noRecReason: string | null;
  noRecDetail: Record<string, unknown> | null;
  // AIC-77a: this account's explicit overrides (sparse) and the fully-resolved
  // effective set (override → budget-relative formula → global default) —
  // resolveThresholds() already ran server-side, this is display-ready.
  thresholdOverrides: Record<string, number>;
  effectiveThresholds: Record<string, number>;
}

interface OpsItem {
  id: string;
  type: string;
  severity: string;
  status: string;
  detail: string;
  claimedBy: string | null;
}

interface Readout {
  name: string;
  status: string;
  period: { current: { start: string; end: string } };
  current: { spendAgorot: number; leads: number; cplAgorot: number | null };
  delta: { spendPct: number | null; leadsPct: number | null; cplPct: number | null };
  perCreative: Array<{ metaObjectId: string; creativeName: string | null; spendAgorot: number; leads: number; cplAgorot: number | null; deliveryStatus: string }>;
}

interface LeadQualityWeek { weekStart: string; leadsReported: number; relevantCount: number; customersWon: number | null }
interface HistoryEntry { when: string; summary: string; automated: boolean; result: "success" | "failed" }

const money = (agorot: number | null) => (agorot === null ? a.noData : formatShekel(agorot));
const pct = (p: number | null) => (p === null ? a.noData : `${p > 0 ? "+" : ""}${p}%`);

// AIC-64: the exact gate/threshold that blocked, so the operator can act or
// explain — not just a label. Numbers come straight from the engine's own
// computation (rules.ts), never re-derived here.
function noRecDetailLine(reason: string, detail: Record<string, unknown> | null): string | null {
  if (!detail) return null;
  const num = (k: string) => Number(detail[k] ?? 0);
  switch (reason) {
    case "budget_below_threshold":
      return `${money(num("currentBudgetAgorot"))}/יום × 7 = ${money(num("maxWindowSpendAgorot"))} < נדרש ${money(num("requiredSpendAgorot"))}`;
    case "collecting":
      return `${num("daysSoFar")}/${num("daysNeeded")} ימים · ${num("deliveryDaysSoFar")}/${num("deliveryDaysNeeded")} ימי הפצה · ${num("leadsSoFar")}/${num("leadsNeeded")} פניות`;
    case "delivery_blocked": {
      const ids = Array.isArray(detail.problemAdSetIds) ? (detail.problemAdSetIds as string[]) : [];
      return ids.length ? `ad set: ${ids.join(", ")}` : null;
    }
    case "no_comparable_audiences": // AIC-85, was single_ad_set
      return `${num("comparableCount")} קהלים ברי-השוואה (לא כולל קהלים כמעט-לא-פעילים)`;
    case "no_comparable_creatives": // AIC-85 — rarely stored, see rules.ts
      return `${num("comparableCount")} מודעות ברות-השוואה`;
    case "below_object_evidence_floor": { // AIC-85
      const kind = detail.kind === "audience" ? "קהלים" : "מודעות";
      return `${kind}: ${num("withEvidenceCount")}/${num("comparableCount")} עברו את סף ${money(num("requiredSpendAgorot"))}`;
    }
    case "cooling_down": {
      const resumesAt = typeof detail.resumesAt === "string" ? detail.resumesAt.slice(0, 10) : null;
      return `${detail.suppressedType} · ${num("cooldownDays")} ימי צינון${resumesAt ? ` · חוזר ${resumesAt}` : ""}`;
    }
    default:
      return null;
  }
}

const EMPTY_FORM: CustomerWriteFields = {
  businessName: "", category: "", mainService: "", geoArea: "", primaryCustomer: "",
  offer: "", contactName: "", contactPhone: "", contactEmail: "", isTest: false,
};

function BusinessFields({ form, onChange }: { form: CustomerWriteFields; onChange: (f: CustomerWriteFields) => void }) {
  const set = (k: keyof CustomerWriteFields) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...form, [k]: e.target.value });
  return (
    <div className="op-form-grid">
      <div className="field span-2"><label>{cc.fieldBusinessName}</label><input value={form.businessName ?? ""} onChange={set("businessName")} required /></div>
      <div className="field"><label>{cc.fieldCategory}</label><input value={form.category ?? ""} onChange={set("category")} /></div>
      <div className="field"><label>{cc.fieldMainService}</label><input value={form.mainService ?? ""} onChange={set("mainService")} /></div>
      <div className="field"><label>{cc.fieldGeoArea}</label><input value={form.geoArea ?? ""} onChange={set("geoArea")} /></div>
      <div className="field"><label>{cc.fieldPrimaryCustomer}</label><input value={form.primaryCustomer ?? ""} onChange={set("primaryCustomer")} /></div>
      <div className="field span-2"><label>{cc.fieldOffer}</label><input value={form.offer ?? ""} onChange={set("offer")} /></div>
      <div className="field"><label>{cc.fieldContactName}</label><input value={form.contactName ?? ""} onChange={set("contactName")} /></div>
      <div className="field"><label>{cc.fieldContactPhone}</label><input value={form.contactPhone ?? ""} onChange={set("contactPhone")} /></div>
      <div className="field span-2"><label>{cc.fieldContactEmail}</label><input type="email" value={form.contactEmail ?? ""} onChange={set("contactEmail")} /></div>
      <label className="check span-2">
        <input type="checkbox" checked={form.isTest ?? false} onChange={(e) => onChange({ ...form, isTest: e.target.checked })} />
        {cc.fieldIsTest}
      </label>
    </div>
  );
}

// Customers section (AIC-43 shell; AIC-44 adds full CRUD): the needs-attention
// queue + the operator's customer roster, with a per-customer drill-down
// folding in the full record, campaign readout, lead-quality, action + audit
// history, and the review action.
export function AdminCustomers() {
  const [params] = useSearchParams();
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [queue, setQueue] = useState<OpsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "deactivated">("all");

  const [selected, setSelected] = useState<CustomerRow | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [readout, setReadout] = useState<Readout | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [leadQuality, setLeadQuality] = useState<LeadQualityWeek[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<CustomerWriteFields>(EMPTY_FORM);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<CustomerWriteFields>({});
  const [budgetShekels, setBudgetShekels] = useState("");
  // One string per threshold key, controlled inputs — blank = no override.
  const [thresholdForm, setThresholdForm] = useState<Record<string, string>>({});
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [showDelete, setShowDelete] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [c, q] = await Promise.all([
      api<{ customers: CustomerRow[] }>("/admin/customers"),
      api<{ items: OpsItem[] }>("/admin/ops-queue"),
    ]);
    setCustomers(c.customers);
    setQueue(q.items);
    setLoading(false);
    return c.customers;
  }, []);

  useEffect(() => { load().catch(() => setLoading(false)); }, [load]);

  // Jump-to from the Overview search (?focus=<id>).
  useEffect(() => {
    const focusId = params.get("focus");
    if (!focusId || customers.length === 0) return;
    const row = customers.find((c) => c.id === focusId);
    if (row) select(row);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, customers]);

  async function select(c: CustomerRow) {
    setSelected(c);
    setDetail(null);
    setReadout(null);
    setAudit([]);
    setLeadQuality([]);
    setHistory([]);
    setEditing(false);
    setSaveError(null);
    setShowDelete(false);

    try { setDetail(await api<CustomerDetail>(`/admin/customers/${c.id}`)); } catch { /* falls back to the list row */ }
    try { setAudit((await getCustomerAudit(c.id)).entries); } catch { /* audit is best-effort in the UI */ }
    if (c.campaignId) {
      try { setReadout(await api<Readout>(`/admin/campaigns/${c.campaignId}/readout`)); } catch { /* no data yet */ }
      try { setLeadQuality((await api<{ weeks: LeadQualityWeek[] }>(`/admin/campaigns/${c.campaignId}/lead-quality`)).weeks); } catch { /* none yet */ }
      try { setHistory((await api<{ entries: HistoryEntry[] }>(`/admin/campaigns/${c.campaignId}/history?condensed=true`)).entries); } catch { /* none yet */ }
    }
  }

  async function reselect(id: string) {
    const rows = await load();
    const fresh = rows.find((r) => r.id === id);
    if (fresh) await select(fresh); else { setSelected(null); setDetail(null); }
  }

  const claim = async (id: string) => { await api(`/admin/ops-queue/${id}/claim`, { method: "POST", body: "{}" }); load(); };
  const resolve = async (id: string) => { await api(`/admin/ops-queue/${id}/resolve`, { method: "POST", body: JSON.stringify({ note: "resolved" }) }); load(); };
  const review = async (campaignId: string, outcome: string) => {
    await api(`/admin/campaigns/${campaignId}/review`, { method: "POST", body: JSON.stringify({ reviewer: "operator", outcome }) });
    if (selected) reselect(selected.id); else load();
  };

  const filtered = customers.filter((c) => {
    if (statusFilter === "active" && !c.isActive) return false;
    if (statusFilter === "deactivated" && c.isActive) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return c.businessName.toLowerCase().includes(q) || c.category.toLowerCase().includes(q);
  });

  async function submitCreate(e: FormEvent) {
    e.preventDefault();
    if (!createForm.businessName?.trim()) return;
    setCreateBusy(true); setCreateError(null);
    try {
      await createCustomer({ ...createForm, businessName: createForm.businessName.trim() });
      setShowCreate(false);
      setCreateForm(EMPTY_FORM);
      await load();
    } catch {
      setCreateError(cc.createError);
    } finally {
      setCreateBusy(false);
    }
  }

  function startEdit() {
    if (!detail) return;
    setEditForm({
      businessName: detail.businessName, category: detail.category, mainService: detail.mainService,
      geoArea: detail.geoArea, primaryCustomer: detail.primaryCustomer, offer: detail.offer,
      contactName: detail.contactName, contactPhone: detail.contactPhone, contactEmail: detail.contactEmail,
      isTest: detail.isTest,
    });
    setBudgetShekels(detail.agreedBudgetAgorot != null ? String(detail.agreedBudgetAgorot / 100) : "");
    // Only overridden keys get a pre-filled value — everything else starts
    // blank, showing its resolved default via the input's placeholder.
    const seeded: Record<string, string> = {};
    for (const key of Object.keys(detail.thresholdOverrides)) seeded[key] = String(detail.thresholdOverrides[key]);
    setThresholdForm(seeded);
    setEditing(true);
    setSaveError(null);
  }

  async function submitEdit(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setSaveBusy(true); setSaveError(null);
    const fields: CustomerWriteFields = { ...editForm };
    if (detail?.campaignId && budgetShekels.trim() !== "") {
      const n = Number(budgetShekels);
      if (!Number.isNaN(n) && n >= 0) fields.agreedBudgetAgorot = Math.round(n * 100);
    }
    // Rebuilt fresh from the form every save — a cleared field is simply
    // absent, which the server treats as "no override" (falls back to the
    // formula/global default), not a partial no-op.
    const thresholdOverrides: Record<string, number> = {};
    for (const [key, raw] of Object.entries(thresholdForm)) {
      if (raw.trim() === "") continue;
      const n = Number(raw);
      if (!Number.isNaN(n)) thresholdOverrides[key] = n;
    }
    fields.thresholdOverrides = thresholdOverrides;
    try {
      await updateCustomer(selected.id, fields);
      setEditing(false);
      await reselect(selected.id);
    } catch {
      setSaveError(cc.saveError);
    } finally {
      setSaveBusy(false);
    }
  }

  async function toggleActive() {
    if (!selected) return;
    if (selected.isActive) {
      if (!window.confirm(cc.deactivateConfirm)) return;
      await deactivateCustomer(selected.id);
    } else {
      await reactivateCustomer(selected.id);
    }
    await reselect(selected.id);
  }

  async function submitDelete() {
    if (!selected || deleteText.trim() !== selected.businessName) return;
    setDeleteBusy(true); setDeleteError(null);
    try {
      await deleteCustomer(selected.id, deleteText.trim());
      setShowDelete(false);
      setSelected(null);
      setDetail(null);
      await load();
    } catch {
      setDeleteError(cc.saveError);
    } finally {
      setDeleteBusy(false);
    }
  }

  if (loading) return <div className="wrap page dash"><p className="muted">{a.loading}</p></div>;

  return (
    <div className="wrap page dash">
      <h1 className="dash-title">{t.title}</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        <b style={{ fontSize: "1.05rem" }}>{t.queue} ({queue.length})</b>
        {queue.length === 0 ? <p className="muted" style={{ marginTop: 10 }}>{t.empty}</p> : (
          <table className="op-table">
            <tbody>
              {queue.map((i) => (
                <tr key={i.id}>
                  <td><span className={`op-sev-${i.severity}`}>{i.severity}</span></td>
                  <td>{i.type}</td>
                  <td>{i.detail}</td>
                  <td>{i.status}{i.claimedBy ? ` · ${i.claimedBy}` : ""}</td>
                  <td>
                    <button className="btn btn-outline btn-sm" style={{ marginInlineEnd: 6 }} onClick={() => claim(i.id)}>{t.claim}</button>
                    <button className="btn btn-outline btn-sm" onClick={() => resolve(i.id)}>{t.resolve}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="row between" style={{ flexWrap: "wrap", gap: 10 }}>
          <b style={{ fontSize: "1.05rem" }}>{t.customers} ({filtered.length}/{customers.length})</b>
          <button className="btn btn-primary btn-sm" onClick={() => { setShowCreate((v) => !v); setCreateError(null); }}>
            + {cc.newCustomer}
          </button>
        </div>

        {showCreate && (
          <form onSubmit={submitCreate} style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
            <BusinessFields form={createForm} onChange={setCreateForm} />
            {createError && <p style={{ color: "var(--orange)", fontSize: "0.85rem" }}>{createError}</p>}
            <button type="submit" className="btn btn-primary btn-sm" disabled={createBusy} style={{ marginInlineEnd: 8 }}>
              {createBusy ? cc.saving : cc.create}
            </button>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowCreate(false)}>{cc.cancel}</button>
          </form>
        )}

        <div className="row" style={{ gap: 10, margin: "14px 0", flexWrap: "wrap" }}>
          <input
            placeholder={cc.searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: 200, font: "inherit", padding: "10px 14px", borderRadius: 12, border: "1.5px solid var(--line)" }}
          />
          <div className="tabs">
            <button type="button" className={statusFilter === "all" ? "active" : ""} onClick={() => setStatusFilter("all")}>{cc.filterAll}</button>
            <button type="button" className={statusFilter === "active" ? "active" : ""} onClick={() => setStatusFilter("active")}>{cc.filterActive}</button>
            <button type="button" className={statusFilter === "deactivated" ? "active" : ""} onClick={() => setStatusFilter("deactivated")}>{cc.filterDeactivated}</button>
          </div>
        </div>

        {filtered.length === 0 ? <p className="muted">{cc.noResults}</p> : (
          <table className="op-table">
            <thead>
              <tr>
                <th>{t.business}</th>
                <th>{t.subscription}</th>
                <th>{t.connection}</th>
                <th>{t.campaign}</th>
                <th>{t.budget}</th>
                <th>{t.openRecs}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className={selected?.id === c.id ? "selected" : ""} onClick={() => select(c)}>
                  <td>{c.businessName}{!c.isActive && <span className="pill neutral" style={{ marginInlineStart: 8, padding: "2px 9px", fontSize: "0.72rem" }}>{cc.deactivatedBadge}</span>}</td>
                  <td>{c.subscriptionStatus ?? t.none}</td>
                  <td>{c.accessHealth ?? t.none}</td>
                  <td>{c.campaignStatus ?? t.none}</td>
                  <td>{c.agreedBudgetAgorot ? formatShekel(c.agreedBudgetAgorot) : t.none}</td>
                  <td>{c.openRecommendations}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="row between">
            <b style={{ fontSize: "1.1rem" }}>
              {selected.businessName}
              {!selected.isActive && <span className="pill neutral" style={{ marginInlineStart: 10, padding: "2px 9px", fontSize: "0.72rem" }}>{cc.deactivatedBadge}</span>}
            </b>
            <button className="btn btn-outline btn-sm" onClick={() => { setSelected(null); setDetail(null); }}>✕</button>
          </div>
          <p className="muted" style={{ marginTop: 6 }}>{t.campaign}: {selected.campaignStatus ?? t.none} · {t.connection}: {selected.accessHealth ?? t.none}</p>
          {!selected.isActive && <p className="muted" style={{ fontSize: "0.85rem" }}>{cc.deactivatedNote}</p>}

          {/* CRUD actions */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "14px 0" }}>
            {!editing && <button className="btn btn-outline btn-sm" onClick={startEdit} disabled={!detail}>{cc.edit}</button>}
            <button className="btn btn-outline btn-sm" onClick={toggleActive}>{selected.isActive ? cc.deactivate : cc.reactivate}</button>
            <button className="btn btn-outline btn-sm" style={{ color: "#c0362c", borderColor: "#c0362c" }} onClick={() => { setShowDelete(true); setDeleteText(""); setDeleteError(null); }}>
              {cc.deleteButton}
            </button>
          </div>

          {editing && detail && (
            <form onSubmit={submitEdit} style={{ marginBottom: 18, paddingBottom: 14, borderBottom: "1px solid var(--line)" }}>
              <BusinessFields form={editForm} onChange={setEditForm} />
              {detail.campaignId ? (
                <div className="field" style={{ maxWidth: 260, marginTop: 4 }}>
                  <label>{cc.fieldAgreedBudget}</label>
                  <input type="number" min="0" step="1" value={budgetShekels} onChange={(e) => setBudgetShekels(e.target.value)} />
                </div>
              ) : <p className="muted" style={{ fontSize: "0.85rem" }}>{a.noCampaigns}</p>}

              {detail.campaignId && (
                <div style={{ marginTop: 16 }}>
                  <p className="muted" style={{ fontSize: "0.85rem", marginBottom: 2 }}><strong>{cc.thresholds.title}</strong></p>
                  <p className="muted" style={{ fontSize: "0.78rem", marginBottom: 8 }}>{cc.thresholds.hint}</p>
                  {THRESHOLD_GROUPS.map((group) => (
                    <div key={group.label} style={{ marginBottom: 10 }}>
                      <p className="muted" style={{ fontSize: "0.78rem", fontWeight: 600, marginBottom: 4 }}>{group.label}</p>
                      <div className="grid-2">
                        {group.keys.map((key) => (
                          <div className="field" key={key} style={{ maxWidth: 260 }}>
                            <label style={{ fontSize: "0.82rem" }}>{cc.thresholds[key as keyof typeof cc.thresholds] as string}</label>
                            <input
                              type="number"
                              step="any"
                              value={thresholdForm[key] ?? ""}
                              placeholder={String(detail.effectiveThresholds[key] ?? "")}
                              onChange={(e) => setThresholdForm((f) => ({ ...f, [key]: e.target.value }))}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {saveError && <p style={{ color: "var(--orange)", fontSize: "0.85rem" }}>{saveError}</p>}
              <div style={{ marginTop: 12 }}>
                <button type="submit" className="btn btn-primary btn-sm" disabled={saveBusy} style={{ marginInlineEnd: 8 }}>{saveBusy ? cc.saving : cc.save}</button>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setEditing(false)}>{cc.cancel}</button>
              </div>
            </form>
          )}

          {detail && !editing && (
            <div className="grid-2" style={{ marginBottom: 16 }}>
              <div>
                <div className="summary-row"><span className="k">{cc.fieldMainService}</span><span>{detail.mainService || a.noData}</span></div>
                <div className="summary-row"><span className="k">{cc.fieldGeoArea}</span><span>{detail.geoArea || a.noData}</span></div>
                <div className="summary-row"><span className="k">{cc.fieldPrimaryCustomer}</span><span>{detail.primaryCustomer || a.noData}</span></div>
                <div className="summary-row"><span className="k">{cc.fieldOffer}</span><span>{detail.offer || a.noData}</span></div>
              </div>
              <div>
                <div className="summary-row"><span className="k">{cc.fieldContactName}</span><span>{detail.contactName || a.noData}</span></div>
                <div className="summary-row"><span className="k">{cc.fieldContactPhone}</span><span>{detail.contactPhone || a.noData}</span></div>
                <div className="summary-row"><span className="k">{cc.fieldContactEmail}</span><span>{detail.contactEmail || a.noData}</span></div>
                <div className="summary-row"><span className="k">{t.subscription}</span><span>{detail.subscriptionStatus ?? t.none}{detail.nextChargeDate ? ` · ${detail.nextChargeDate}` : ""}</span></div>
                {detail.campaignId && (
                  <div className="summary-row">
                    <span className="k">{cc.thresholds.title}</span>
                    <span>
                      {Object.keys(detail.thresholdOverrides).length === 0
                        ? cc.thresholds.summaryNone
                        : cc.thresholds.summaryActive(Object.keys(detail.thresholdOverrides).length)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {detail?.campaignId && detail.noRecReason && (
            <p className="muted" style={{ margin: "0 0 14px" }}>
              {t.noRecTitle} {t.noRecReason[detail.noRecReason] ?? detail.noRecReason}
              {(() => {
                const line = noRecDetailLine(detail.noRecReason, detail.noRecDetail);
                return line ? ` (${line})` : "";
              })()}
            </p>
          )}

          {selected.campaignId && selected.campaignStatus === "under_review" && (
            <div style={{ margin: "14px 0" }}>
              <b>{t.review}:</b>{" "}
              <button className="btn btn-outline btn-sm" style={{ marginInlineEnd: 6 }} onClick={() => review(selected.campaignId!, "approved")}>{t.approve}</button>
              <button className="btn btn-outline btn-sm" style={{ marginInlineEnd: 6 }} onClick={() => review(selected.campaignId!, "changes_requested")}>{t.requestChanges}</button>
              <button className="btn btn-outline btn-sm" onClick={() => review(selected.campaignId!, "unsupported")}>{t.unsupported}</button>
            </div>
          )}

          {selected.campaignId && (
            <p style={{ margin: "0 0 14px" }}>
              <Link className="link" to={`/admin/meta?campaign=${selected.campaignId}`}>{t.openMetaExplorer}</Link>
            </p>
          )}

          {readout ? (
            <>
              <p className="muted" style={{ margin: "12px 0" }}>{a.readoutTitle} · {readout.period.current.start} – {readout.period.current.end}</p>
              <div className="grid-3" style={{ marginBottom: 12 }}>
                <div className="kpi"><b>{money(readout.current.spendAgorot)}</b><div className="lbl">{a.spend}</div><div className="muted" style={{ fontSize: "0.78rem" }}>{a.vsPrevious}: {pct(readout.delta.spendPct)}</div></div>
                <div className="kpi"><b>{readout.current.leads}</b><div className="lbl">{a.leads}</div><div className="muted" style={{ fontSize: "0.78rem" }}>{a.vsPrevious}: {pct(readout.delta.leadsPct)}</div></div>
                <div className="kpi"><b>{money(readout.current.cplAgorot)}</b><div className="lbl">{a.cpl}</div><div className="muted" style={{ fontSize: "0.78rem" }}>{a.vsPrevious}: {pct(readout.delta.cplPct)}</div></div>
              </div>
              {readout.perCreative.length > 0 && (
                <>
                  <b style={{ fontSize: "0.95rem" }}>{a.perCreative}</b>
                  <table className="op-table">
                    <thead><tr><th>{a.creative}</th><th>{a.spend}</th><th>{a.leads}</th><th>{a.cpl}</th></tr></thead>
                    <tbody>
                      {readout.perCreative.map((c) => (
                        <tr key={c.metaObjectId} style={{ cursor: "default" }}><td>{c.creativeName ?? c.metaObjectId}</td><td>{money(c.spendAgorot)}</td><td>{c.leads}</td><td>{money(c.cplAgorot)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          ) : (
            <p className="muted">{selected.campaignId ? a.noData : a.noCampaigns}</p>
          )}

          {leadQuality.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <b style={{ fontSize: "0.95rem" }}>{t.leadQuality}</b>
              <table className="op-table">
                <thead><tr><th>{cc.leadQualityWeek}</th><th>{t.leadQuality}</th><th>{cc.leadQualityRelevant}</th><th>{cc.leadQualityWon}</th></tr></thead>
                <tbody>
                  {leadQuality.map((w) => (
                    <tr key={w.weekStart} style={{ cursor: "default" }}><td>{w.weekStart}</td><td>{w.leadsReported}</td><td>{w.relevantCount}</td><td>{w.customersWon ?? a.noData}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {history.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <b style={{ fontSize: "0.95rem" }}>{cc.historyTitle}</b>
              {history.slice(0, 8).map((h, i) => (
                <div key={i} className="op-audit-item">
                  {h.summary} {h.automated ? cc.historyAutomated : ""} {h.result === "failed" ? cc.historyFailed : ""}
                  <div className="who">{new Date(h.when).toLocaleString("he-IL")}</div>
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 18 }}>
            <b style={{ fontSize: "0.95rem" }}>{cc.auditTitle}</b>
            {audit.length === 0 ? <p className="muted" style={{ fontSize: "0.85rem" }}>{cc.auditEmpty}</p> : (
              audit.map((e) => (
                <div key={e.id} className="op-audit-item">
                  {cc.auditActionLabels[e.action] ?? e.action} — {e.detail}
                  <div className="who">{e.actorLabel} · {new Date(e.createdAt).toLocaleString("he-IL")}</div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {showDelete && selected && (
        <div className="op-modal-backdrop" onClick={() => setShowDelete(false)}>
          <div className="op-modal" onClick={(e) => e.stopPropagation()}>
            <b style={{ fontSize: "1.1rem" }}>{cc.deleteTitle}</b>
            <p className="muted" style={{ marginTop: 10, fontSize: "0.9rem" }}>{cc.deleteWarning}</p>
            <div className="field" style={{ marginTop: 14 }}>
              <label>{cc.deleteConfirmLabel} <b>{selected.businessName}</b></label>
              <input value={deleteText} onChange={(e) => setDeleteText(e.target.value)} autoFocus />
            </div>
            {deleteText.length > 0 && deleteText.trim() !== selected.businessName && (
              <p style={{ color: "var(--orange)", fontSize: "0.82rem", marginTop: 6 }}>{cc.deleteConfirmMismatch}</p>
            )}
            {deleteError && <p style={{ color: "var(--orange)", fontSize: "0.85rem" }}>{deleteError}</p>}
            <div style={{ marginTop: 18, display: "flex", gap: 8 }}>
              <button
                className="btn btn-sm"
                style={{ background: "#c0362c", color: "#fff" }}
                disabled={deleteBusy || deleteText.trim() !== selected.businessName}
                onClick={submitDelete}
              >
                {deleteBusy ? cc.saving : cc.confirmDelete}
              </button>
              <button className="btn btn-outline btn-sm" onClick={() => setShowDelete(false)}>{cc.cancel}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
