import { useEffect, useState, useCallback } from "react";
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

// The single internal admin dashboard: the needs-attention queue + all customers,
// with a per-customer drill-down that folds in the campaign readout (AIC-7) and
// the first-campaign review action. Replaces the old /admin/ops + /admin/readout.
export function AdminDashboard() {
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
  }, []);

  useEffect(() => { load().catch(() => setLoading(false)); }, [load]);

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

  if (loading) return <main dir="rtl" style={S.page}>{a.loading}</main>;

  return (
    <main dir="rtl" style={S.page}>
      <h1 style={{ margin: "0 0 16px" }}>{t.title}</h1>

      <h2>{t.queue} ({queue.length})</h2>
      {queue.length === 0 ? <p style={S.muted}>{t.empty}</p> : (
        <table style={S.table}>
          <tbody>
            {queue.map((i) => (
              <tr key={i.id}>
                <td style={S.td}><Sev s={i.severity} /></td>
                <td style={S.td}>{i.type}</td>
                <td style={S.td}>{i.detail}</td>
                <td style={S.td}>{i.status}{i.claimedBy ? ` · ${i.claimedBy}` : ""}</td>
                <td style={S.td}>
                  <button style={S.btn} onClick={() => claim(i.id)}>{t.claim}</button>
                  <button style={S.btn} onClick={() => resolve(i.id)}>{t.resolve}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ marginTop: 32 }}>{t.customers} ({customers.length})</h2>
      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>{t.business}</th>
            <th style={S.th}>{t.subscription}</th>
            <th style={S.th}>{t.connection}</th>
            <th style={S.th}>{t.campaign}</th>
            <th style={S.th}>{t.budget}</th>
            <th style={S.th}>{t.openRecs}</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => (
            <tr key={c.id} style={{ cursor: "pointer", background: selected?.id === c.id ? "#f3f4f6" : undefined }} onClick={() => select(c)}>
              <td style={S.td}>{c.businessName}</td>
              <td style={S.td}>{c.subscriptionStatus ?? t.none}</td>
              <td style={S.td}>{c.accessHealth ?? t.none}</td>
              <td style={S.td}>{c.campaignStatus ?? t.none}</td>
              <td style={S.td}>{c.agreedBudgetAgorot ? formatShekel(c.agreedBudgetAgorot) : t.none}</td>
              <td style={S.td}>{c.openRecommendations}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected && (
        <section style={S.drill}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>{selected.businessName}</h3>
            <button style={S.btn} onClick={() => { setSelected(null); setReadout(null); }}>✕</button>
          </div>
          <p style={S.muted}>{t.campaign}: {selected.campaignStatus ?? t.none} · {t.connection}: {selected.accessHealth ?? t.none}</p>

          {selected.campaignId && selected.campaignStatus === "under_review" && (
            <div style={{ marginBottom: 16 }}>
              <strong>{t.review}:</strong>{" "}
              <button style={S.btn} onClick={() => review(selected.campaignId!, "approved")}>{t.approve}</button>
              <button style={S.btn} onClick={() => review(selected.campaignId!, "changes_requested")}>{t.requestChanges}</button>
              <button style={S.btn} onClick={() => review(selected.campaignId!, "unsupported")}>{t.unsupported}</button>
            </div>
          )}

          {readout ? (
            <>
              <p style={{ color: "#6b7280", margin: "0 0 12px" }}>{a.readoutTitle} · {readout.period.current.start} – {readout.period.current.end}</p>
              <div style={S.tiles}>
                <Tile label={a.spend} value={money(readout.current.spendAgorot)} sub={`${a.vsPrevious}: ${pct(readout.delta.spendPct)}`} />
                <Tile label={a.leads} value={String(readout.current.leads)} sub={`${a.vsPrevious}: ${pct(readout.delta.leadsPct)}`} />
                <Tile label={a.cpl} value={money(readout.current.cplAgorot)} sub={`${a.vsPrevious}: ${pct(readout.delta.cplPct)}`} />
              </div>
              {readout.perCreative.length > 0 && (
                <>
                  <h4 style={{ margin: "16px 0 4px" }}>{a.perCreative}</h4>
                  <table style={S.table}>
                    <thead><tr><th style={S.th}>{a.creative}</th><th style={S.th}>{a.spend}</th><th style={S.th}>{a.leads}</th><th style={S.th}>{a.cpl}</th></tr></thead>
                    <tbody>
                      {readout.perCreative.map((c) => (
                        <tr key={c.metaObjectId}><td style={S.td}>{c.creativeName ?? c.metaObjectId}</td><td style={S.td}>{money(c.spendAgorot)}</td><td style={S.td}>{c.leads}</td><td style={S.td}>{money(c.cplAgorot)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          ) : (
            <p style={S.muted}>{selected.campaignId ? a.noData : a.noCampaigns}</p>
          )}
        </section>
      )}
    </main>
  );
}

function Sev({ s }: { s: string }) {
  const color = s === "high" ? "#dc2626" : s === "medium" ? "#d97706" : "#6b7280";
  return <span style={{ color, fontWeight: 700 }}>{s}</span>;
}
function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={S.tile}>
      <div style={{ color: "#6b7280", fontSize: 13 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700 }}>{value}</div>
      {sub && <div style={{ color: "#9ca3af", fontSize: 12 }}>{sub}</div>}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 980, margin: "0 auto" },
  muted: { color: "#6b7280" },
  table: { width: "100%", borderCollapse: "collapse", marginTop: 8 },
  th: { textAlign: "right", borderBottom: "2px solid #e5e7eb", padding: "8px 6px", fontSize: 13, color: "#6b7280" },
  td: { borderBottom: "1px solid #f0f0f0", padding: "8px 6px", fontSize: 14 },
  btn: { margin: "0 4px", padding: "4px 10px", border: "1px solid #d1d5db", borderRadius: 6, background: "#f9fafb", cursor: "pointer" },
  drill: { marginTop: 24, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 20 },
  tiles: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 },
  tile: { border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 },
};
