import { useEffect, useState, useCallback } from "react";
import { formatShekel } from "@aic/shared";
import { api } from "../api";
import { strings } from "../strings";

const t = strings.he.ops;

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

// Internal ops console (AIC-16/17/18/19): customers at a glance, the
// needs-attention queue with triage, and a per-customer review action.
export function OpsConsole() {
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [queue, setQueue] = useState<OpsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CustomerRow | null>(null);

  const load = useCallback(async () => {
    const [c, q] = await Promise.all([
      api<{ customers: CustomerRow[] }>("/admin/customers"),
      api<{ items: OpsItem[] }>("/admin/ops-queue"),
    ]);
    setCustomers(c.customers);
    setQueue(q.items);
    setLoading(false);
  }, []);

  useEffect(() => {
    load().catch(() => setLoading(false));
  }, [load]);

  const claim = async (id: string) => { await api(`/admin/ops-queue/${id}/claim`, { method: "POST", body: "{}" }); load(); };
  const resolve = async (id: string) => { await api(`/admin/ops-queue/${id}/resolve`, { method: "POST", body: JSON.stringify({ note: "resolved" }) }); load(); };
  const review = async (campaignId: string, outcome: string) => {
    await api(`/admin/campaigns/${campaignId}/review`, { method: "POST", body: JSON.stringify({ reviewer: "operator", outcome }) });
    load();
  };

  if (loading) return <main dir="rtl" style={S.page}>{strings.he.admin.loading}</main>;

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
            <tr key={c.id} style={{ cursor: "pointer" }} onClick={() => setSelected(c)}>
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
        <div style={S.panel}>
          <h3 style={{ marginTop: 0 }}>{selected.businessName}</h3>
          <p style={S.muted}>{t.campaign}: {selected.campaignStatus ?? t.none} · {t.connection}: {selected.accessHealth ?? t.none}</p>
          {selected.campaignId && selected.campaignStatus === "under_review" && (
            <div>
              <strong>{t.review}:</strong>{" "}
              <button style={S.btn} onClick={() => review(selected.campaignId!, "approved")}>{t.approve}</button>
              <button style={S.btn} onClick={() => review(selected.campaignId!, "changes_requested")}>{t.requestChanges}</button>
              <button style={S.btn} onClick={() => review(selected.campaignId!, "unsupported")}>{t.unsupported}</button>
            </div>
          )}
          <button style={{ ...S.btn, marginTop: 12 }} onClick={() => setSelected(null)}>✕</button>
        </div>
      )}
    </main>
  );
}

function Sev({ s }: { s: string }) {
  const color = s === "high" ? "#dc2626" : s === "medium" ? "#d97706" : "#6b7280";
  return <span style={{ color, fontWeight: 700 }}>{s}</span>;
}

const S: Record<string, React.CSSProperties> = {
  page: { fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 980, margin: "0 auto" },
  muted: { color: "#6b7280" },
  table: { width: "100%", borderCollapse: "collapse", marginTop: 8 },
  th: { textAlign: "right", borderBottom: "2px solid #e5e7eb", padding: "8px 6px", fontSize: 13, color: "#6b7280" },
  td: { borderBottom: "1px solid #f0f0f0", padding: "8px 6px", fontSize: 14 },
  btn: { margin: "0 4px", padding: "4px 10px", border: "1px solid #d1d5db", borderRadius: 6, background: "#f9fafb", cursor: "pointer" },
  panel: { position: "fixed", insetInlineStart: 24, bottom: 24, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 20, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", minWidth: 320 },
};
