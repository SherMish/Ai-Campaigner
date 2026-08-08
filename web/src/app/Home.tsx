import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { strings } from "../strings";
import {
  getOverview,
  postLeadQuality,
  shekels,
  type CustomerOverview,
  type HomeState,
} from "../api";
import { AppHeader, StatusPill } from "./components";

const a = strings.he.app;
const h = a.home;
const L = h.live;

const PILL: Record<HomeState, "ok" | "info" | "neutral" | "attn"> = {
  ok: "ok", collecting: "neutral", paused: "neutral", attention: "attn", no_campaign: "neutral",
};

// Which status-hero copy + optional CTA each real state shows. Only CTAs that
// point at a real screen are wired; paused/collecting/ok carry no button.
function hero(state: HomeState): { badge: string; title: string; body: string; cta?: { to: string; label: string } } {
  switch (state) {
    case "attention":
      return { ...h.states.attention, cta: { to: "/connect", label: h.states.attention.cta } };
    case "paused":
      return { badge: h.states.paused.badge, title: h.states.paused.title, body: h.states.paused.body };
    case "collecting":
      return h.states.collecting;
    case "no_campaign":
      return { ...h.states.setup, cta: { to: "/onboarding", label: h.states.setup.cta } };
    default:
      return h.states.ok;
  }
}

// A signed percent delta as an arrow + label. `goodDown` flips the color meaning
// (CPL improving = down = good; leads improving = up = good).
function Delta({ pct, goodDown }: { pct: number | null; goodDown?: boolean }) {
  if (pct === null || pct === 0) return null;
  const up = pct > 0;
  const good = goodDown ? !up : up;
  return (
    <div className={`delta ${good ? "good" : "bad"}`}>
      {up ? "▲" : "▼"} {Math.abs(pct)}% {L.vsPrev}
    </div>
  );
}

export function Home() {
  const [ov, setOv] = useState<CustomerOverview | null>(null);
  const [err, setErr] = useState(false);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setErr(false);
    getOverview()
      .then(setOv)
      .catch(() => setErr(true))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  if (loading)
    return (
      <div>
        <AppHeader recCount={0} />
        <div className="wrap page"><p className="muted">{a.loading}</p></div>
      </div>
    );

  if (err || !ov)
    return (
      <div>
        <AppHeader recCount={0} />
        <div className="wrap page">
          <div className="card">
            <p className="muted" style={{ marginBottom: 12 }}>{a.loadError}</p>
            <button className="btn btn-outline btn-sm" onClick={load}>{a.retry}</button>
          </div>
        </div>
      </div>
    );

  const state = ov.homeState;
  const hd = hero(state);
  const r = ov.readout;
  const leads = r?.current.leads ?? 0;
  const cpl = r?.current.cplAgorot ?? null;
  const spend = r?.current.spendAgorot ?? 0;
  const activeAds = r?.perCreative.length ?? 0;
  const period = ov.campaign?.budgetPeriod === "monthly" ? L.perMonth : L.perDay;

  return (
    <div>
      <AppHeader recCount={0} userName={ov.account.name} />
      <div className="wrap page">
        <div className="row between" style={{ marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
          <h1>{h.title}</h1>
        </div>

        {/* status hero */}
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="row between" style={{ flexWrap: "wrap", gap: 16 }}>
            <div>
              <StatusPill variant={PILL[state]}>{hd.badge}</StatusPill>
              <h2 style={{ fontSize: "2rem", margin: "14px 0 10px" }}>{hd.title}</h2>
              <p className="muted" style={{ maxWidth: "40em" }}>{hd.body}</p>
            </div>
            {hd.cta && <Link className="btn btn-primary" to={hd.cta.to}>{hd.cta.label}</Link>}
          </div>
        </div>

        {/* KPIs — the questions the customer actually asks */}
        <div className="grid-3" style={{ marginBottom: 24 }}>
          <div className="kpi">
            <b>{cpl === null ? L.none : shekels(cpl)}</b>
            <div className="lbl">{h.kpiCpl}</div>
            <Delta pct={r?.delta.cplPct ?? null} goodDown />
          </div>
          <div className="kpi">
            <b>{leads}</b>
            <div className="lbl">{h.kpiLeads}</div>
            <Delta pct={r?.delta.leadsPct ?? null} />
          </div>
          <div className="kpi">
            <b>{shekels(spend)}</b>
            <div className="lbl">{h.kpiSpend}</div>
            <Delta pct={r?.delta.spendPct ?? null} />
          </div>
        </div>

        <div className="grid-2">
          <div className="stack gap24">
            {/* no-action reassurance — only when nothing needs the customer */}
            {(state === "ok" || state === "collecting") && (
              <div className="card">
                <StatusPill variant="ok">{h.noActionTitle}</StatusPill>
                <p className="muted" style={{ marginTop: 12 }}>{h.noAction}</p>
              </div>
            )}

            {/* weekly feedback */}
            {ov.campaign && <WeeklyFeedback leadsReported={leads} />}

            {/* recent activity — real action history (empty until we act) */}
            <div className="card">
              <div className="row between" style={{ marginBottom: 8 }}>
                <b>{h.recentTitle}</b>
                <Link className="link" to="/app/recommendations" style={{ fontSize: "0.9rem" }}>{h.recentAll}</Link>
              </div>
              {ov.recentActivity.length === 0 ? (
                <p className="muted" style={{ marginTop: 4 }}>{L.noActivity}</p>
              ) : (
                <div className="timeline">
                  {ov.recentActivity.map((it, i) => (
                    <div className="t-item" key={i}>
                      <span className="when">
                        {new Date(it.when).toLocaleDateString("he-IL", { day: "numeric", month: "short" })}
                      </span>
                      <span>{it.summary} · <span className="muted">{it.automated ? L.automated : L.byUs}</span></span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* campaign summary sidebar */}
          <div className="card">
            <b style={{ fontSize: "1.05rem" }}>{ov.campaign?.name || h.summaryTitle}</b>
            <div style={{ marginTop: 14 }}>
              <div className="summary-row"><span className="k">{h.sMode}</span><StatusPill variant={PILL[state]}>{hd.badge}</StatusPill></div>
              <div className="summary-row"><span className="k">{h.sBudget}</span><b>{ov.campaign ? `${shekels(ov.campaign.agreedBudgetAgorot)} ${period}` : L.none}</b></div>
              <div className="summary-row"><span className="k">{h.sAds}</span><b>{activeAds > 0 ? `${activeAds} ${L.adsActive}` : L.none}</b></div>
              <div className="summary-row"><span className="k">{h.sLeads}</span><b>{leads}</b></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function WeeklyFeedback({ leadsReported }: { leadsReported: number }) {
  const [count, setCount] = useState(leadsReported);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  if (leadsReported === 0)
    return <div className="card"><b>{h.weeklyTitle}</b><p className="muted" style={{ marginTop: 10 }}>{h.weeklyNoLeads}</p></div>;

  function submit() {
    setSaving(true);
    setError(false);
    postLeadQuality(leadsReported, Math.min(count, leadsReported))
      .then(() => setSaved(true))
      .catch(() => setError(true))
      .finally(() => setSaving(false));
  }

  return (
    <div className="card">
      <b>{h.weeklyTitle}</b>
      {saved ? (
        <div style={{ marginTop: 12 }}><StatusPill variant="ok">✓ {h.weeklyThanksTitle}</StatusPill><p className="muted" style={{ marginTop: 10 }}>{h.weeklyThanks}</p></div>
      ) : (
        <>
          <p className="muted" style={{ margin: "8px 0 4px" }}>{leadsReported} {h.weeklyLeadsLine}</p>
          <p style={{ margin: "4px 0 16px", fontWeight: 500 }}>{h.weeklyCount}</p>
          <div className="row gap16" style={{ flexWrap: "wrap" }}>
            <div className="stepper-inline">
              <button onClick={() => setCount((c) => Math.max(0, c - 1))}>−</button>
              <span className="v">{count}</span>
              <button onClick={() => setCount((c) => Math.min(leadsReported, c + 1))}>+</button>
            </div>
            <button className="btn btn-dark" onClick={submit} disabled={saving}>{a.save}</button>
          </div>
          {error && <p className="muted" style={{ marginTop: 10 }}>{a.loadError}</p>}
        </>
      )}
    </div>
  );
}
