import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { strings } from "../strings";
import { Brand, StatusPill, WA } from "./components";

const a = strings.he.app;
const c = a.connect;

type Check = "idle" | "checking" | "connected" | "missing" | "notVerified";

export function Connect() {
  const [check, setCheck] = useState<Check>("idle");
  const [copied, setCopied] = useState(false);
  const nav = useNavigate();

  const runCheck = () => {
    setCheck("checking");
    window.setTimeout(() => setCheck("connected"), 1500);
  };

  return (
    <div>
      <header className="appbar">
        <div className="wrap inner">
          <span className="userpill"><span className="av">{a.mock.userInitials}</span>{a.mock.userName}</span>
          <Link to="/app"><Brand /></Link>
        </div>
      </header>

      <div className="wrap page" style={{ maxWidth: 780, marginInline: "auto" }}>
        <Link className="link" to="/onboarding?s=C">{c.backToStatus}</Link>
        <h1 style={{ margin: "16px 0 10px" }}>{c.title}</h1>
        <p className="muted">{c.sub}</p>
        <div className="pill neutral" style={{ marginTop: 16 }}><span className="dot" />🔒 {c.noPassword}</div>

        <div className="card" style={{ marginTop: 24 }}>
          <h3 style={{ fontSize: "1.2rem", marginBottom: 8 }}>{c.howTitle}</h3>
          {c.steps.map((step, i) => (
            <div className="connect-step" key={i}>
              <div className="idx">{i + 1}</div>
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{step}</div>
                {i === 0 && <a className="link" href="https://business.facebook.com/settings" target="_blank" rel="noreferrer" style={{ fontSize: "0.9rem" }}>{c.openMeta}</a>}
                {i === 1 && (
                  <div className="copybox" style={{ marginTop: 10 }}>
                    <span className="mono muted" style={{ fontSize: "0.7rem" }}>{c.businessId}</span>
                    <b>{a.mock.businessId}</b>
                    <button onClick={() => { navigator.clipboard?.writeText(a.mock.businessId); setCopied(true); }}>
                      {copied ? c.copied : c.copy}
                    </button>
                  </div>
                )}
                {i === 3 && <p className="muted" style={{ fontSize: "0.85rem", marginTop: 6 }}><b>{c.whenNeeded}</b> {c.whenNeededBody}</p>}
              </div>
            </div>
          ))}
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={runCheck} disabled={check === "checking"}>
            {c.checkCta}
          </button>
        </div>

        {/* check outcome */}
        {check !== "idle" && (
          <div className="card" style={{ marginTop: 20 }}>
            {check === "checking" && (
              <div className="row gap16"><div className="spinner" /><div><b>{c.checking}</b><p className="muted" style={{ fontSize: "0.9rem" }}>{c.checkingSub}</p></div></div>
            )}
            {check === "connected" && (
              <>
                <StatusPill variant="ok">✓ {c.connectedTitle}</StatusPill>
                <div style={{ marginTop: 16 }}>
                  <div className="summary-row"><span className="k">{c.adAccount}</span><b>סטודיו לילך — פרסום</b></div>
                  <div className="summary-row"><span className="k">{c.fbPage}</span><b>סטודיו לילך</b></div>
                  <div className="summary-row"><span className="k">{c.instagram}</span><b>@studio.lilach</b></div>
                </div>
                <p className="mono muted" style={{ fontSize: "0.72rem", margin: "12px 0" }}>{c.technical}: act_882401553 · page_1049823117 · ig_17841400082</p>
                <button className="btn btn-primary" onClick={() => nav("/onboarding?s=D")}>{c.continue}</button>
              </>
            )}
            {check === "missing" && (
              <>
                <StatusPill variant="warn">! {c.missingTitle}</StatusPill>
                <p className="muted" style={{ margin: "14px 0" }}>{c.missingBody}</p>
                <div className="row gap12" style={{ marginBottom: 14 }}>
                  <StatusPill variant="ok">{c.adAccount}: {c.connected}</StatusPill>
                  <StatusPill variant="attn">{c.fbPage}: {c.missing}</StatusPill>
                </div>
                <b>{c.howToFix}</b>
                <ol className="muted" style={{ margin: "8px 0 16px", paddingInlineStart: 20 }}>{c.fixSteps.map((f, i) => <li key={i}>{f}</li>)}</ol>
                <div className="row gap12"><button className="btn btn-primary" onClick={runCheck}>{c.recheck}</button><a className="btn btn-outline" href={WA}>{a.talk}</a></div>
              </>
            )}
            {check === "notVerified" && (
              <>
                <StatusPill variant="attn">! {c.notVerifiedTitle}</StatusPill>
                <p className="muted" style={{ margin: "14px 0" }}>{c.notVerifiedBody}</p>
                <div className="row gap12"><button className="btn btn-primary" onClick={runCheck}>{c.retry}</button><a className="btn btn-outline" href={WA}>{a.talk}</a></div>
              </>
            )}
          </div>
        )}

        {/* dev preview switcher for the outcomes */}
        <div className="row gap8" style={{ marginTop: 24, flexWrap: "wrap" }}>
          {(["connected", "missing", "notVerified"] as Check[]).map((k) => (
            <button key={k} className="btn btn-sm btn-outline" onClick={() => setCheck(k)}>{k}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
