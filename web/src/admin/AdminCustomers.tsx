import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { formatShekel } from "@aic/shared";
import { api } from "../api";
import { strings } from "../strings";

const t = strings.he.ops;
const a = strings.he.admin;

interface CustomerRow {
  id: string;
  businessName: string;
  subscriptionStatus: string | null;
  accessHealth: string | null;
  campaignStatus: string | null;
  campaignId: string | null;
  agreedBudgetAgorot: number | null;
  openRecommendations: number;
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

const money = (agorot: number | null) => (agorot === null ? a.noData : formatShekel(agorot));
const pct = (p: number | null) => (p === null ? a.noData : `${p > 0 ? "+" : ""}${p}%`);

// Customers section (AIC-43, content carried over from the pre-shell single
// dashboard): the needs-attention queue + all customers, with a per-customer
// drill-down folding in the campaign readout (AIC-7) and the first-campaign
// review action. Full CRUD (create/edit/deactivate/delete) is AIC-44.
export function AdminCustomers() {
  const [params] = useSearchParams();
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [queue, setQueue] = useState<OpsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CustomerRow | null>(null);
  const [readout, setReadout] = useState<Readout | null>(null);

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
    setReadout(null);
    if (c.campaignId) {
      try { setReadout(await api<Readout>(`/admin/campaigns/${c.campaignId}/readout`)); } catch { /* no data yet */ }
    }
  }

  const claim = async (id: string) => { await api(`/admin/ops-queue/${id}/claim`, { method: "POST", body: "{}" }); load(); };
  const resolve = async (id: string) => { await api(`/admin/ops-queue/${id}/resolve`, { method: "POST", body: JSON.stringify({ note: "resolved" }) }); load(); };
  const review = async (campaignId: string, outcome: string) => {
    await api(`/admin/campaigns/${campaignId}/review`, { method: "POST", body: JSON.stringify({ reviewer: "operator", outcome }) });
    load();
  };

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
        <b style={{ fontSize: "1.05rem" }}>{t.customers} ({customers.length})</b>
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
            {customers.map((c) => (
              <tr key={c.id} className={selected?.id === c.id ? "selected" : ""} onClick={() => select(c)}>
                <td>{c.businessName}</td>
                <td>{c.subscriptionStatus ?? t.none}</td>
                <td>{c.accessHealth ?? t.none}</td>
                <td>{c.campaignStatus ?? t.none}</td>
                <td>{c.agreedBudgetAgorot ? formatShekel(c.agreedBudgetAgorot) : t.none}</td>
                <td>{c.openRecommendations}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="row between">
            <b style={{ fontSize: "1.1rem" }}>{selected.businessName}</b>
            <button className="btn btn-outline btn-sm" onClick={() => { setSelected(null); setReadout(null); }}>✕</button>
          </div>
          <p className="muted" style={{ marginTop: 6 }}>{t.campaign}: {selected.campaignStatus ?? t.none} · {t.connection}: {selected.accessHealth ?? t.none}</p>

          {selected.campaignId && selected.campaignStatus === "under_review" && (
            <div style={{ margin: "14px 0" }}>
              <b>{t.review}:</b>{" "}
              <button className="btn btn-outline btn-sm" style={{ marginInlineEnd: 6 }} onClick={() => review(selected.campaignId!, "approved")}>{t.approve}</button>
              <button className="btn btn-outline btn-sm" style={{ marginInlineEnd: 6 }} onClick={() => review(selected.campaignId!, "changes_requested")}>{t.requestChanges}</button>
              <button className="btn btn-outline btn-sm" onClick={() => review(selected.campaignId!, "unsupported")}>{t.unsupported}</button>
            </div>
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
        </div>
      )}
    </div>
  );
}
