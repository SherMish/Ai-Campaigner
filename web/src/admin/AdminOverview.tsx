import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { formatShekel } from "@aic/shared";
import { api } from "../api";
import { strings } from "../strings";

const f = strings.he.fleet;
const a = strings.he.admin;

interface FleetOverview {
  campaignsByStatus: Record<string, number>;
  delivering: number;
  needsAttentionDelivery: number;
  spendAgorot: number;
  leads: number;
  period: { start: string; end: string };
  openOpsItems: number;
  conversion: { customers: number; setupPaid: number; subscribed: number; setupToSubscriptionRate: number | null };
}

interface SearchRow {
  id: string;
  businessName: string;
  campaignName: string | null;
}

// The operator's landing page (AIC-43): "how is the whole book of business
// doing?" in one read, plus a jump-to-anything search. Campaigns/spend/delivery
// numbers cover every managed campaign (including internal/dogfood accounts —
// the operator watches those too); the billing/conversion tile explicitly
// excludes test customers, so it never overstates real revenue.
export function AdminOverview() {
  const nav = useNavigate();
  const [ov, setOv] = useState<FleetOverview | null>(null);
  const [customers, setCustomers] = useState<SearchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  useEffect(() => {
    Promise.all([
      api<FleetOverview>("/admin/overview"),
      api<{ customers: SearchRow[] }>("/admin/customers"),
    ])
      .then(([o, c]) => { setOv(o); setCustomers(c.customers); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    return customers
      .filter((c) => c.businessName.toLowerCase().includes(query) || (c.campaignName ?? "").toLowerCase().includes(query))
      .slice(0, 8);
  }, [q, customers]);

  if (loading) return <div className="wrap page dash"><p className="muted">{a.loading}</p></div>;
  if (!ov) return <div className="wrap page dash"><div className="card"><p className="muted">{a.noData}</p></div></div>;

  const statusLabel = (s: string) => (f.statusLabels as Record<string, string>)[s] ?? s;
  const totalCampaigns = Object.values(ov.campaignsByStatus).reduce((n, v) => n + v, 0);

  return (
    <div className="wrap page dash">
      <h1 className="dash-title">{f.title}</h1>
      <p className="muted" style={{ marginBottom: 20 }}>{f.subtitle}</p>

      {/* global search */}
      <div className="card" style={{ marginBottom: 20, position: "relative" }}>
        <input
          className="field"
          style={{ width: "100%", border: "1.5px solid var(--line)", borderRadius: 14, padding: "12px 16px", font: "inherit" }}
          placeholder={strings.he.adminShell.searchPlaceholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q.trim() && (
          <div style={{ marginTop: 10 }}>
            {results.length === 0 ? (
              <p className="muted" style={{ fontSize: "0.9rem" }}>{strings.he.adminShell.searchNoResults}</p>
            ) : (
              results.map((r) => (
                <div
                  key={r.id}
                  className="summary-row"
                  style={{ cursor: "pointer" }}
                  onClick={() => nav(`/admin/customers?focus=${r.id}`)}
                >
                  <span className="k">{r.businessName}</span>
                  <b>{r.campaignName ?? "—"}</b>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="grid-3" style={{ marginBottom: 20 }}>
        <div className="kpi">
          <b>{formatShekel(ov.spendAgorot)}</b>
          <div className="lbl">{f.spendThisPeriod}</div>
        </div>
        <div className="kpi">
          <b>{ov.leads}</b>
          <div className="lbl">{f.leadsThisPeriod}</div>
        </div>
        <div className="kpi">
          <b>{ov.delivering}/{ov.delivering + ov.needsAttentionDelivery}</b>
          <div className="lbl">{f.delivering}</div>
        </div>
      </div>

      <div className="grid-2" style={{ marginBottom: 20 }}>
        <div className="card" style={{ cursor: "pointer" }} onClick={() => nav("/admin/customers")}>
          <b style={{ fontSize: "1.05rem" }}>{f.campaignsByStatus} ({totalCampaigns})</b>
          <div style={{ marginTop: 12 }}>
            {Object.entries(ov.campaignsByStatus).map(([status, n]) => (
              <div className="summary-row" key={status}><span className="k">{statusLabel(status)}</span><b>{n}</b></div>
            ))}
            {totalCampaigns === 0 && <p className="muted">{a.noCampaigns}</p>}
          </div>
          <p className="link" style={{ marginTop: 10, fontSize: "0.85rem" }}>{f.viewCustomers} →</p>
        </div>

        <div className="card" style={{ cursor: "pointer" }} onClick={() => nav("/admin/customers")}>
          <b style={{ fontSize: "1.05rem" }}>{f.openQueue}</b>
          <div style={{ fontSize: "2rem", fontWeight: 800, margin: "10px 0" }}>{ov.openOpsItems}</div>
          <p className="link" style={{ fontSize: "0.85rem" }}>{f.viewQueue} →</p>
        </div>
      </div>

      <div className="card">
        <b style={{ fontSize: "1.05rem" }}>{f.billingTitle}</b>
        {ov.conversion.customers === 0 ? (
          <p className="muted" style={{ marginTop: 10 }}>{f.noRealCustomers}</p>
        ) : (
          <div style={{ marginTop: 12 }}>
            <div className="summary-row"><span className="k">{f.realCustomers}</span><b>{ov.conversion.customers}</b></div>
            <div className="summary-row"><span className="k">{f.setupPaid}</span><b>{ov.conversion.setupPaid}</b></div>
            <div className="summary-row"><span className="k">{f.subscribed}</span><b>{ov.conversion.subscribed}</b></div>
            <div className="summary-row"><span className="k">{f.conversionRate}</span><b>{ov.conversion.setupToSubscriptionRate === null ? "—" : `${Math.round(ov.conversion.setupToSubscriptionRate * 100)}%`}</b></div>
          </div>
        )}
      </div>
    </div>
  );
}
