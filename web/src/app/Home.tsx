import { useState } from "react";
import { Link } from "react-router-dom";
import { strings } from "../strings";
import { AppHeader, StatusPill } from "./components";

const a = strings.he.app;
const h = a.home;

type HState = "ok" | "rec" | "collecting" | "paused" | "attention";
const PILL: Record<HState, "ok" | "info" | "neutral" | "attn"> = {
  ok: "ok", rec: "info", collecting: "neutral", paused: "neutral", attention: "attn",
};

export function Home() {
  const [state, setState] = useState<HState>("ok");
  const [period, setPeriod] = useState<"month" | "days7" | "prev">("month");
  const st = h.states[state];

  return (
    <div>
      <AppHeader recCount={1} />
      <div className="wrap page">
        <div className="row between" style={{ marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
          <h1>{h.title}</h1>
          <div className="tabs">
            {(["month", "days7", "prev"] as const).map((p) => (
              <button key={p} className={period === p ? "active" : ""} onClick={() => setPeriod(p)}>{h.periods[p]}</button>
            ))}
          </div>
        </div>

        {/* status hero */}
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="row between" style={{ flexWrap: "wrap", gap: 16 }}>
            <div>
              <StatusPill variant={PILL[state]}>{st.badge}</StatusPill>
              <h2 style={{ fontSize: "2rem", margin: "14px 0 10px" }}>{st.title}</h2>
              <p className="muted" style={{ maxWidth: "40em" }}>{st.body}</p>
            </div>
            {"cta" in st && st.cta && <Link className="btn btn-primary" to="/app/recommendations">{st.cta}</Link>}
          </div>
        </div>

        {/* KPIs — the four questions */}
        <div className="grid-3" style={{ marginBottom: 24 }}>
          <div className="kpi"><b>₪41</b><div className="lbl">{h.kpiCpl}</div><div className="delta good">▼ נמוך ב־8% מהחודש שעבר</div></div>
          <div className="kpi"><b>18</b><div className="lbl">{h.kpiLeads}</div><div className="delta good">▲ 4 פניות יותר מהתקופה המקבילה</div></div>
          <div className="kpi"><b>₪734</b><div className="lbl">{h.kpiSpend}</div></div>
        </div>

        <div className="grid-2">
          <div className="stack gap24">
            {/* recommendation / no-action */}
            {state === "rec" ? (
              <div className="rec">
                <div className="k">{h.recWaitingTitle}</div>
                <h3>{h.recWaiting}</h3>
                <p className="muted">{h.recWaitingReason}</p>
                <div className="actions">
                  <Link className="btn btn-primary" to="/app/recommendations/1">{h.viewApprove}</Link>
                  <span className="link">{a.notNow}</span>
                </div>
              </div>
            ) : (
              <div className="card">
                <StatusPill variant="ok">{h.noActionTitle}</StatusPill>
                <p className="muted" style={{ marginTop: 12 }}>{h.noAction}</p>
              </div>
            )}

            {/* weekly feedback */}
            <WeeklyFeedback noLeads={false} />

            {/* recent activity */}
            <div className="card">
              <div className="row between" style={{ marginBottom: 8 }}>
                <b>{h.recentTitle}</b>
                <Link className="link" to="/app/recommendations" style={{ fontSize: "0.9rem" }}>{h.recentAll}</Link>
              </div>
              <div className="timeline">
                {h.recent.map((it, i) => (
                  <div className="t-item" key={i}><span className="when">{it.d}</span><span>{it.t}</span></div>
                ))}
              </div>
            </div>
          </div>

          {/* campaign summary sidebar */}
          <div className="card">
            <b style={{ fontSize: "1.05rem" }}>{h.summaryTitle}</b>
            <div style={{ marginTop: 14 }}>
              <div className="summary-row"><span className="k">{h.sMode}</span><StatusPill variant="ok">{h.states.ok.badge}</StatusPill></div>
              <div className="summary-row"><span className="k">{h.sBudget}</span><b>{h.sBudgetVal}</b></div>
              <div className="summary-row"><span className="k">{h.sAds}</span><b>{h.sAdsVal}</b></div>
              <div className="summary-row"><span className="k">{h.sLeads}</span><b>{h.sLeadsVal}</b></div>
            </div>
          </div>
        </div>

        {/* dev state switcher */}
        <div className="row gap8" style={{ marginTop: 30, flexWrap: "wrap" }}>
          {(["ok", "rec", "collecting", "paused", "attention"] as HState[]).map((k) => (
            <button key={k} className={`btn btn-sm ${k === state ? "btn-dark" : "btn-outline"}`} onClick={() => setState(k)}>{h.states[k].badge}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

function WeeklyFeedback({ noLeads }: { noLeads: boolean }) {
  const [count, setCount] = useState(7);
  const [saved, setSaved] = useState(false);
  if (noLeads)
    return <div className="card"><b>{h.weeklyTitle}</b><p className="muted" style={{ marginTop: 10 }}>{h.weeklyNoLeads}</p></div>;
  return (
    <div className="card">
      <b>{h.weeklyTitle}</b>
      {saved ? (
        <div style={{ marginTop: 12 }}><StatusPill variant="ok">✓ {h.weeklyThanksTitle}</StatusPill><p className="muted" style={{ marginTop: 10 }}>{h.weeklyThanks}</p></div>
      ) : (
        <>
          <p style={{ margin: "8px 0 16px", fontWeight: 500 }}>{h.weeklyCount}</p>
          <div className="row gap16" style={{ flexWrap: "wrap" }}>
            <div className="stepper-inline">
              <button onClick={() => setCount((c) => Math.max(0, c - 1))}>−</button>
              <span className="v">{count}</span>
              <button onClick={() => setCount((c) => c + 1)}>+</button>
            </div>
            <button className="btn btn-dark" onClick={() => setSaved(true)}>{a.save}</button>
          </div>
        </>
      )}
    </div>
  );
}
