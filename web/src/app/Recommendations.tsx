import { useState } from "react";
import { Link } from "react-router-dom";
import { strings } from "../strings";
import { AppHeader, StatusPill, WA } from "./components";

const a = strings.he.app;
const rc = a.recs;
const rd = a.recDetail;

export function Recommendations() {
  return (
    <div>
      <AppHeader recCount={1} />
      <div className="wrap page" style={{ maxWidth: 820, marginInline: "auto" }}>
        <h1 style={{ marginBottom: 24 }}>{rc.title}</h1>

        {/* waiting for approval */}
        <div className="rec" style={{ marginBottom: 28 }}>
          <div className="row between">
            <StatusPill variant="warn">{rc.waiting}</StatusPill>
            <span className="mono muted" style={{ fontSize: "0.75rem" }}>{rd.createdAgo}</span>
          </div>
          <h3 style={{ marginTop: 12 }}>{rd.pauseTitle}</h3>
          <p className="muted">{a.home.recWaitingReason}</p>
          <div className="actions"><Link className="btn btn-primary" to="/app/recommendations/1">{rc.view}</Link></div>
        </div>

        {/* history */}
        <h3 style={{ fontSize: "1.2rem", marginBottom: 8 }}>{rc.doneTitle}</h3>
        <div className="card">
          <div className="timeline">
            {a.home.recent.map((it, i) => (
              <div className="t-item" key={i}>
                <span className="when">{it.d}</span>
                <span className="grow">{it.t}</span>
                <StatusPill variant="ok">✓</StatusPill>
              </div>
            ))}
          </div>
        </div>

        <p className="center" style={{ marginTop: 24 }}>
          <span className="muted">{rc.notSure} </span><a className="link" href={WA}>{a.talk}</a>
        </p>
      </div>
    </div>
  );
}

type Kind = "pause" | "increase" | "replace";
type Phase = "idle" | "approved" | "executed" | "dismissed";

export function RecommendationDetail() {
  const [kind, setKind] = useState<Kind>("pause");
  const [phase, setPhase] = useState<Phase>("idle");

  return (
    <div>
      <AppHeader recCount={1} />
      <div className="wrap page" style={{ maxWidth: 720, marginInline: "auto" }}>
        <Link className="link" to="/app/recommendations">{rd.back}</Link>

        {phase === "approved" && <Result title={rd.approvedTitle} sub={rd.approvedSub} variant="info" />}
        {phase === "executed" && (
          <div className="card center" style={{ marginTop: 20, padding: 44 }}>
            <StatusPill variant="ok">✓</StatusPill>
            <h1 style={{ margin: "14px 0 18px" }}>{rd.executedTitle}</h1>
            <div className="summary-row"><span className="k">{rd.whatWeDid}</span><b>{title(kind)}</b></div>
            <div className="summary-row"><span className="k">{rd.whenDone}</span><b>12 באוגוסט, 09:24</b></div>
            <Link className="btn btn-primary" style={{ marginTop: 20 }} to="/app/recommendations">{rd.backToRecs}</Link>
          </div>
        )}
        {phase === "dismissed" && <Result title={rd.dismissedTitle} sub={rd.dismissedSub} variant="neutral" />}

        {phase === "idle" && (
          <>
            <div className="row between" style={{ margin: "16px 0" }}>
              <StatusPill variant="warn">{rc.waiting}</StatusPill>
              <span className="mono muted" style={{ fontSize: "0.75rem" }}>{rd.createdAgo}</span>
            </div>
            <h1 style={{ marginBottom: 20 }}>{title(kind)}</h1>

            <div className="card" style={{ marginBottom: 16 }}>
              <b>{rd.whyTitle}</b>
              <p className="muted" style={{ marginTop: 8 }}>{why(kind)}</p>
            </div>

            {kind === "increase" && (
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="row gap24" style={{ justifyContent: "center", padding: "6px 0" }}>
                  <div className="center"><div className="muted">{rd.today}</div><b style={{ fontSize: "1.4rem" }}>{rd.incFrom}</b></div>
                  <div style={{ fontSize: "1.6rem" }}>←</div>
                  <div className="center"><div className="muted">{rd.proposed}</div><b style={{ fontSize: "1.4rem", color: "var(--orange)" }}>{rd.incTo}</b></div>
                </div>
                <p className="muted center" style={{ fontSize: "0.9rem" }}>{rd.maxImpact}</p>
              </div>
            )}

            <div className="card" style={{ marginBottom: 20 }}>
              <b>{rd.whatChangesTitle}</b>
              {kind === "pause" && <ul className="muted" style={{ margin: "8px 0 0", paddingInlineStart: 18 }}>{rd.pauseChanges.map((x, i) => <li key={i}>{x}</li>)}</ul>}
              {kind === "increase" && <p className="muted" style={{ marginTop: 8 }}>{rd.incChange}</p>}
              {kind === "replace" && <p className="muted" style={{ marginTop: 8 }}>{rd.replaceNote}</p>}
            </div>

            <div className="row gap12" style={{ flexWrap: "wrap" }}>
              <button className="btn btn-primary" onClick={() => { setPhase("approved"); window.setTimeout(() => setPhase("executed"), 1600); }}>{a.approve}</button>
              <button className="btn btn-outline" onClick={() => setPhase("dismissed")}>{a.notNow}</button>
              <a className="btn btn-ghost" href={WA} style={{ marginInlineStart: "auto" }}>{rd.wantToTalk} {a.talk}</a>
            </div>

            {/* dev type switcher */}
            <div className="row gap8" style={{ marginTop: 28, flexWrap: "wrap" }}>
              {(["pause", "increase", "replace"] as Kind[]).map((k) => (
                <button key={k} className={`btn btn-sm ${k === kind ? "btn-dark" : "btn-outline"}`} onClick={() => setKind(k)}>{k}</button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function title(k: Kind) { return k === "pause" ? rd.pauseTitle : k === "increase" ? rd.incTitle : rd.replaceTitle; }
function why(k: Kind) { return k === "pause" ? rd.pauseWhy : k === "increase" ? rd.incWhy : rd.replaceWhy; }

function Result({ title, sub, variant }: { title: string; sub: string; variant: "info" | "neutral" }) {
  return (
    <div className="card center" style={{ marginTop: 20, padding: 44 }}>
      <StatusPill variant={variant}>●</StatusPill>
      <h1 style={{ margin: "14px 0 10px" }}>{title}</h1>
      <p className="muted">{sub}</p>
    </div>
  );
}
