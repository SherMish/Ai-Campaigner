import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { strings } from "../strings";
import { Brand, StatusPill, WA } from "./components";

const a = strings.he.app;
const r = a.review;

export function Review() {
  const [confirmed, setConfirmed] = useState(false);
  const nav = useNavigate();

  return (
    <div>
      <header className="appbar">
        <div className="wrap inner">
          <span className="userpill"><span className="av">{a.mock.userInitials}</span>{a.mock.userName}</span>
          <Link to="/app"><Brand /></Link>
        </div>
      </header>

      <div className="wrap page" style={{ maxWidth: 820, marginInline: "auto" }}>
        {confirmed ? (
          <div className="card center" style={{ padding: 48 }}>
            <StatusPill variant="ok" >✓</StatusPill>
            <h1 style={{ margin: "16px 0 10px" }}>{r.confirmedTitle}</h1>
            <p className="muted" style={{ marginBottom: 24 }}>{r.confirmedSub}</p>
            <button className="btn btn-primary" onClick={() => nav("/onboarding?s=F")}>{r.backToStatus}</button>
          </div>
        ) : (
          <>
            <h1 style={{ marginBottom: 10 }}>{r.title}</h1>
            <p className="muted" style={{ marginBottom: 24 }}>{r.sub}</p>

            <div className="card" style={{ marginBottom: 20 }}>
              <div className="row between" style={{ marginBottom: 8 }}>
                <b style={{ fontSize: "1.1rem" }}>{r.campaign}</b>
                <StatusPill variant="ok">{r.active}</StatusPill>
              </div>
              <div className="grid-3" style={{ gap: 0 }}>
                <div className="summary-row" style={{ borderBottom: 0 }}><span className="k">{r.budget}</span><b>{r.budgetVal}</b></div>
                <div className="summary-row" style={{ borderBottom: 0 }}><span className="k">{r.area}</span><b>{r.areaVal}</b></div>
                <div className="summary-row" style={{ borderBottom: 0 }}><span className="k">{r.ads}</span><b>{r.adsVal}</b></div>
              </div>
              <div className="summary-row" style={{ borderBottom: 0 }}><span className="k">{r.goal}</span><b>{r.goalVal}</b></div>
            </div>

            <div className="card" style={{ marginBottom: 20 }}>
              <b>{r.running}</b>
              <div className="row gap8" style={{ marginTop: 12, flexWrap: "wrap" }}>
                <StatusPill variant="ok">{r.keep}</StatusPill>
                <StatusPill variant="attn">{r.pauseRec}</StatusPill>
                <StatusPill variant="info">{r.isNew}</StatusPill>
              </div>
            </div>

            <div className="card">
              <h3 style={{ fontSize: "1.2rem", marginBottom: 8 }}>{r.proposalsTitle}</h3>
              {r.proposals.map((p, i) => (
                <div key={i} style={{ padding: "14px 0", borderBottom: i < r.proposals.length - 1 ? "1px solid var(--line)" : 0 }}>
                  <b>{p.t}</b>
                  <p className="muted" style={{ fontSize: "0.92rem" }}>{p.d}</p>
                </div>
              ))}
              <div className="row gap12" style={{ marginTop: 18, flexWrap: "wrap" }}>
                <button className="btn btn-primary" onClick={() => setConfirmed(true)}>{r.approveStart}</button>
                <a className="btn btn-outline" href={WA}>{a.talk}</a>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
