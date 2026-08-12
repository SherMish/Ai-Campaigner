import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { formatShekel } from "@aic/shared";
import { api, getCampaignExplorer, type ExplorerResult, type ExplorerMetrics, type ExplorerAdSet, type ExplorerAd } from "../api";
import { strings } from "../strings";

const m = strings.he.metaExplorer;
const a = strings.he.admin;

interface CustomerPick {
  id: string;
  businessName: string;
  campaignId: string | null;
  campaignName: string | null;
}

const money = (agorot: number | null) => (agorot === null ? a.noData : formatShekel(agorot));
const num = (n: number | null) => (n === null ? a.noData : n.toLocaleString("he-IL"));
const pct = (p: number | null) => (p === null ? a.noData : `${p}%`);

function MetricGrid({ metrics }: { metrics: ExplorerMetrics }) {
  return (
    <div className="op-metric-grid">
      <div className="op-metric"><b>{money(metrics.spendAgorot)}</b><div className="lbl">{m.metrics.spend}</div></div>
      <div className="op-metric"><b>{num(metrics.impressions)}</b><div className="lbl">{m.metrics.impressions}</div></div>
      <div className="op-metric"><b>{num(metrics.reach)}</b><div className="lbl">{m.metrics.reach}</div></div>
      <div className="op-metric"><b>{metrics.frequency ?? a.noData}</b><div className="lbl">{m.metrics.frequency}</div></div>
      <div className="op-metric"><b>{money(metrics.cpmAgorot)}</b><div className="lbl">{m.metrics.cpm}</div></div>
      <div className="op-metric"><b>{pct(metrics.ctrPct)}</b><div className="lbl">{m.metrics.ctr}</div></div>
      <div className="op-metric"><b>{money(metrics.cpcAgorot)}</b><div className="lbl">{m.metrics.cpc}</div></div>
      <div className="op-metric"><b>{num(metrics.leads)}</b><div className="lbl">{m.metrics.leads}</div></div>
      <div className="op-metric"><b>{money(metrics.cplAgorot)}</b><div className="lbl">{m.metrics.cpl}</div></div>
      <div className="op-metric"><b>{metrics.qualityRanking ?? a.noData}</b><div className="lbl">{m.metrics.qualityRanking}</div></div>
      <div className="op-metric"><b>{metrics.engagementRateRanking ?? a.noData}</b><div className="lbl">{m.metrics.engagementRateRanking}</div></div>
      <div className="op-metric"><b>{metrics.conversionRateRanking ?? a.noData}</b><div className="lbl">{m.metrics.conversionRateRanking}</div></div>
    </div>
  );
}

function AdCard({ ad }: { ad: ExplorerAd }) {
  const problem = ad.issues.length > 0;
  const c = ad.creative;
  return (
    <div className={"op-ad-card" + (problem ? " op-problem" : "")}>
      {c?.imageUrl ? (
        <img className="op-ad-thumb" src={c.imageUrl} alt="" />
      ) : c?.isFlexible ? (
        <div className="op-ad-thumb flex">{m.flexibleCreative}</div>
      ) : (
        <div className="op-ad-thumb" />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="op-node-head">
          <b>{ad.name ?? ad.id}</b>
          <span className="muted" style={{ fontSize: "0.78rem" }}>{ad.effectiveStatus ?? a.noData}</span>
        </div>
        {problem && ad.issues.map((iss, i) => <div key={i} className="op-issue">{iss}</div>)}
        {c ? (
          <>
            {c.isFlexible && c.flexibleAssetCounts ? (
              <p className="muted" style={{ fontSize: "0.82rem", margin: "4px 0" }}>
                {m.flexibleCreative} — {c.flexibleAssetCounts.images} {m.flexibleImages} · {c.flexibleAssetCounts.videos} {m.flexibleVideos} · {c.flexibleAssetCounts.bodies} {m.flexibleBodies} · {c.flexibleAssetCounts.titles} {m.flexibleTitles}
              </p>
            ) : (
              <p className="muted" style={{ fontSize: "0.82rem", margin: "4px 0" }}>
                {[c.title, c.body, c.callToActionType].filter(Boolean).join(" · ") || a.noData}
              </p>
            )}
          </>
        ) : (
          <p className="muted" style={{ fontSize: "0.82rem", margin: "4px 0" }}>{m.noCreative}</p>
        )}
        {c?.pageId && <p className="muted" style={{ fontSize: "0.75rem", margin: "2px 0" }}>{m.pageLabel}: {c.pageId}</p>}
        <MetricGrid metrics={ad.metrics} />
      </div>
    </div>
  );
}

function AdSetCard({ adSet }: { adSet: ExplorerAdSet }) {
  const problem = adSet.issues.length > 0;
  const t = adSet.targeting;
  return (
    <div className={"op-node" + (problem ? " op-problem" : "")}>
      <div className="op-node-head">
        <b style={{ fontSize: "1.02rem" }}>{adSet.name ?? adSet.id}</b>
        <span className="pill neutral" style={{ padding: "2px 10px", fontSize: "0.76rem" }}>{adSet.effectiveStatus ?? a.noData}</span>
      </div>
      {problem && adSet.issues.map((iss, i) => <div key={i} className="op-issue">{iss}</div>)}

      <div className="row" style={{ gap: 22, flexWrap: "wrap", margin: "8px 0", fontSize: "0.85rem" }}>
        <span><b>{m.dailyBudget}:</b> {money(adSet.dailyBudgetAgorot)}</span>
        <span><b>{m.lifetimeBudget}:</b> {money(adSet.lifetimeBudgetAgorot)}</span>
        <span><b>{m.bidStrategy}:</b> {adSet.bidStrategy ?? a.noData}</span>
      </div>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        <b>{m.targeting}:</b>{" "}
        {m.age} {t.ageMin ?? "–"}–{t.ageMax ?? "–"} · {m.gender} {t.genders.join(", ")} · {m.geo} {t.geoCountries.join(", ") || a.noData}
        {t.interests.length > 0 && <> · {m.interests}: {t.interests.join(", ")}</>}
      </p>

      <MetricGrid metrics={adSet.metrics} />

      <div className="op-ad-list">
        {adSet.ads.length === 0 ? <p className="muted" style={{ fontSize: "0.85rem" }}>{m.noAds}</p> : adSet.ads.map((ad) => <AdCard key={ad.id} ad={ad} />)}
      </div>
    </div>
  );
}

// Full Meta data explorer (AIC-45): the unrestricted internal deep view — the
// complete campaign→ad-set→ad→creative tree, every metric (including the ones
// hidden from customers, PRD §14), delivery errors, targeting, budgets + bid
// strategy. Always fetched live on open/refresh — see campaign-explorer.ts for
// why this is the deliberate exception to "no live Meta calls at render."
export function AdminMeta() {
  const [params, setParams] = useSearchParams();
  const [customers, setCustomers] = useState<CustomerPick[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [result, setResult] = useState<ExplorerResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    api<{ customers: CustomerPick[] }>("/admin/customers").then((r) => {
      const withCampaign = r.customers.filter((c) => c.campaignId);
      setCustomers(withCampaign);
      const fromUrl = params.get("campaign");
      const initial = (fromUrl && withCampaign.find((c) => c.campaignId === fromUrl)?.campaignId) || withCampaign[0]?.campaignId || null;
      setSelectedCampaignId(initial);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    });
  }, []);

  const load = useCallback(async (campaignId: string) => {
    setLoading(true); setLoadError(false);
    try {
      setResult(await getCampaignExplorer(campaignId));
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (selectedCampaignId) load(selectedCampaignId); }, [selectedCampaignId, load]);

  function pick(campaignId: string) {
    setSelectedCampaignId(campaignId);
    setParams({ campaign: campaignId });
  }

  return (
    <div className="wrap page dash">
      <h1 className="dash-title">{m.title}</h1>
      <p className="muted">{m.subtitle}</p>

      {customers.length > 1 && (
        <div className="tabs" style={{ margin: "14px 0" }}>
          {customers.map((c) => (
            <button key={c.id} type="button" className={selectedCampaignId === c.campaignId ? "active" : ""} onClick={() => pick(c.campaignId!)}>
              {c.businessName}
            </button>
          ))}
        </div>
      )}

      {customers.length === 0 ? (
        <div className="card" style={{ marginTop: 16 }}><p className="muted">{m.noCampaigns}</p></div>
      ) : loading && !result ? (
        <div className="card" style={{ marginTop: 16 }}><p className="muted">{a.loading}</p></div>
      ) : loadError ? (
        <div className="card" style={{ marginTop: 16 }}><p className="muted">{m.metaError}</p></div>
      ) : result?.unavailableReason ? (
        <div className="card" style={{ marginTop: 16 }}>
          <p className="muted">
            {result.unavailableReason === "no_meta_campaign" ? m.noMetaCampaign
              : result.unavailableReason === "no_token" ? m.noToken
              : `${m.metaError} ${result.errorDetail ?? ""}`}
          </p>
        </div>
      ) : result?.tree ? (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="op-node-head">
            <div>
              <b style={{ fontSize: "1.15rem" }}>{result.tree.name ?? result.name}</b>{" "}
              <span className="pill neutral" style={{ padding: "2px 10px", fontSize: "0.76rem" }}>{result.tree.effectiveStatus ?? a.noData}</span>
            </div>
            <button className="btn btn-outline btn-sm" disabled={loading} onClick={() => load(result.campaignId)}>
              {loading ? m.refreshing : m.refresh}
            </button>
          </div>
          <p className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>
            {m.period}: {result.tree.period.start} – {result.tree.period.end} · {m.fetchedAt}: {new Date(result.tree.fetchedAt).toLocaleString("he-IL")}
          </p>
          <div className="row" style={{ gap: 22, flexWrap: "wrap", margin: "10px 0", fontSize: "0.85rem" }}>
            <span><b>{m.dailyBudget}:</b> {money(result.tree.dailyBudgetAgorot)}</span>
            <span><b>{m.lifetimeBudget}:</b> {money(result.tree.lifetimeBudgetAgorot)}</span>
            <span><b>{m.bidStrategy}:</b> {result.tree.bidStrategy ?? a.noData}</span>
          </div>

          <b style={{ fontSize: "0.9rem" }}>{m.campaignLevel}</b>
          <MetricGrid metrics={result.tree.metrics} />

          <b style={{ fontSize: "0.95rem", display: "block", marginTop: 18 }}>{m.adSets} ({result.tree.adSets.length})</b>
          {result.tree.adSets.length === 0 ? <p className="muted">{m.noAdSets}</p> : result.tree.adSets.map((as) => <AdSetCard key={as.id} adSet={as} />)}
        </div>
      ) : null}
    </div>
  );
}
