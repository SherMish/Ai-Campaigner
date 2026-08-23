import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { formatShekel, type OpsQueueType, type OpsSeverity } from "@aic/shared";
import { api } from "../api";
import { strings } from "../strings";
import { TimeSeries, ProportionBar } from "./AdminCharts";
import type { DayPoint } from "./chart-geometry";

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
  // AIC-122 analytics blocks.
  trend: DayPoint[];
  automation: { total: number; automated: number; human: number; rate: number };
  queueHealth: { open: number; openBySeverity: Partial<Record<OpsSeverity, number>>; topTypes: Array<{ type: OpsQueueType; count: number }> };
  health: { managed: number; deliveryOk: number; deliveryBroken: number; trackingOk: number; trackingBroken: number };
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

      {/* AIC-122 #1 — fleet spend & leads trend. Two stacked charts sharing an
          x-axis, never one chart with two y-scales: spend (agorot) and leads
          (single digits) differ by orders of magnitude, and a dual axis lets
          any correlation be manufactured by choosing the scales. */}
      <div className="card" style={{ marginBottom: 20 }}>
        <b style={{ fontSize: "1.05rem" }}>{f.trendTitle}</b>
        <p className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>{f.trendSub}</p>
        {ov.trend.length === 0 ? (
          <p className="muted" style={{ marginTop: 10 }}>{f.trendEmpty}</p>
        ) : (
          <>
            <TimeSeries
              points={ov.trend}
              valueOf={(p) => p.spendAgorot}
              color="var(--orange)"
              label={f.trendSpend}
              format={(v) => formatShekel(v)}
            />
            <TimeSeries
              points={ov.trend}
              valueOf={(p) => p.leads}
              color="var(--indigo)"
              label={f.trendLeads}
              format={(v) => String(v)}
            />
          </>
        )}
      </div>

      <div className="ac-grid-2" style={{ marginBottom: 20 }}>
        {/* AIC-122 #7 — automation rate. Byproduct of action_history's
            human_involved, logged on every write since AIC-17. */}
        <div className="card">
          <b style={{ fontSize: "1.05rem" }}>{f.automationTitle}</b>
          <p className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>{f.automationSub}</p>
          {ov.automation.total === 0 ? (
            <p className="muted" style={{ marginTop: 10 }}>{f.automationEmpty}</p>
          ) : (
            <>
              <div className="ac-hero" style={{ marginTop: 12 }}>{Math.round(ov.automation.rate * 100)}%</div>
              <ProportionBar
                parts={[
                  { label: f.automationAutomated, value: ov.automation.automated, color: "var(--indigo)" },
                  { label: f.automationHuman, value: ov.automation.human, color: "var(--cream-2)" },
                ]}
              />
            </>
          )}
        </div>

        {/* AIC-122 #9 — fleet health. Every status color ships with a visible
            count AND text label: the status palette's amber fails the 3:1
            contrast check and green/amber sit in the CVD floor band, so color
            may never be the only carrier of meaning here. */}
        <div className="card">
          <b style={{ fontSize: "1.05rem" }}>{f.healthTitle}</b>
          <p className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>{f.healthSub}</p>
          {ov.health.managed === 0 ? (
            <p className="muted" style={{ marginTop: 10 }}>{f.healthEmpty}</p>
          ) : (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: "0.85rem", fontWeight: 600 }}>{f.healthDelivery}</div>
              <ProportionBar
                parts={[
                  { label: f.healthOk, value: ov.health.deliveryOk, color: "var(--green)" },
                  { label: f.healthBroken, value: ov.health.deliveryBroken, color: "var(--orange)" },
                ]}
              />
              <div style={{ fontSize: "0.85rem", fontWeight: 600, marginTop: 16 }}>{f.healthTracking}</div>
              <ProportionBar
                parts={[
                  { label: f.healthOk, value: ov.health.trackingOk, color: "var(--green)" },
                  { label: f.healthBroken, value: ov.health.trackingBroken, color: "var(--orange)" },
                ]}
              />
            </div>
          )}
        </div>
      </div>

      {/* AIC-122 #4 — queue health: open backlog by severity + recurring types. */}
      <div className="card" style={{ marginBottom: 20 }}>
        <b style={{ fontSize: "1.05rem" }}>{f.queueHealthTitle}</b>
        <p className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>{f.queueHealthSub}</p>
        {ov.queueHealth.open === 0 ? (
          <p className="muted" style={{ marginTop: 10 }}>{f.queueHealthEmpty}</p>
        ) : (
          <>
            <ProportionBar
              parts={[
                { label: strings.he.ops.queueSeverityHigh, value: ov.queueHealth.openBySeverity.high ?? 0, color: "var(--orange)" },
                { label: strings.he.ops.queueSeverityMedium, value: ov.queueHealth.openBySeverity.medium ?? 0, color: "#e08a2b" },
                { label: strings.he.ops.queueSeverityLow, value: ov.queueHealth.openBySeverity.low ?? 0, color: "var(--cream-2)" },
              ]}
            />
            <div className="ac-rows">
              {ov.queueHealth.topTypes.map((tt) => (
                <div className="ac-row" key={tt.type}>
                  <span className="ac-row-label">{strings.he.ops.queueTypeLabel[tt.type]}</span>
                  <span className="ac-row-track">
                    <span
                      className="ac-row-fill"
                      style={{
                        width: `${(tt.count / Math.max(...ov.queueHealth.topTypes.map((x) => x.count))) * 100}%`,
                        background: "var(--indigo)",
                      }}
                    />
                  </span>
                  <span className="ac-row-n">{tt.count}</span>
                </div>
              ))}
            </div>
          </>
        )}
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
