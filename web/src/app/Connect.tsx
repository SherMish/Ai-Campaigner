import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { strings, META_BUSINESS_PORTFOLIO_ID } from "../strings";
import { getOverview, recheckConnection, type CustomerOverview } from "../api";
import { Brand, StatusPill, WA } from "./components";

const a = strings.he.app;
const c = a.connect;

type Check = "idle" | "checking" | "connected" | "missing";

export function Connect() {
  const [ov, setOv] = useState<CustomerOverview | null>(null);
  const [check, setCheck] = useState<Check>("idle");
  const [copied, setCopied] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    getOverview().then((o) => {
      setOv(o);
      // reflect the already-known connection state on load
      if (o.connection) setCheck(o.connection.accessHealth === "ok" ? "connected" : "missing");
    }).catch(() => {});
  }, []);

  const name = ov?.account.name?.trim();
  const conn = ov?.connection;

  const runCheck = () => {
    setCheck("checking");
    recheckConnection()
      .then((r) => setCheck(r.accessHealth === "ok" ? "connected" : "missing"))
      .catch(() => setCheck("missing"));
  };

  return (
    <div>
      <header className="appbar">
        <div className="wrap inner">
          <span className="userpill">
            {name ? <><span className="av">{name.split(/\s+/).slice(0, 2).map((p) => p[0]).join("")}</span>{name}</>
                  : <><span className="av sk" /><span className="sk sk-line" /></>}
          </span>
          <Link to="/app"><Brand /></Link>
        </div>
      </header>

      <div className="wrap page" style={{ maxWidth: 780, marginInline: "auto" }}>
        <Link className="link" to="/onboarding">{c.backToStatus}</Link>
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
                {i === 2 && (
                  <div className="copybox" style={{ marginTop: 10 }}>
                    <span className="mono muted" style={{ fontSize: "0.7rem" }}>{c.businessId}</span>
                    <b>{META_BUSINESS_PORTFOLIO_ID}</b>
                    <button onClick={() => { navigator.clipboard?.writeText(META_BUSINESS_PORTFOLIO_ID); setCopied(true); }}>
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

        {check !== "idle" && (
          <div className="card" style={{ marginTop: 20 }}>
            {check === "checking" && (
              <div className="row gap16"><div className="spinner" /><div><b>{c.checking}</b><p className="muted" style={{ fontSize: "0.9rem" }}>{c.checkingSub}</p></div></div>
            )}
            {check === "connected" && (
              <>
                <StatusPill variant="ok">✓ {c.connectedTitle}</StatusPill>
                <div style={{ marginTop: 16 }}>
                  <div className="summary-row"><span className="k">{c.adAccount}</span><b>{conn?.adAccount?.name || "—"}</b></div>
                  <div className="summary-row"><span className="k">{c.fbPage}</span><b>{conn?.pageId || "—"}</b></div>
                  <div className="summary-row"><span className="k">{c.instagram}</span><b>{conn?.instagramId || "—"}</b></div>
                </div>
                {conn?.adAccount && (
                  <p className="mono muted" style={{ fontSize: "0.72rem", margin: "12px 0" }}>
                    {c.technical}: {conn.adAccount.metaAdAccountId}
                    {conn.pageId ? ` · ${conn.pageId}` : ""}{conn.instagramId ? ` · ${conn.instagramId}` : ""}
                  </p>
                )}
                <button className="btn btn-primary" onClick={() => nav("/onboarding")}>{c.continue}</button>
              </>
            )}
            {check === "missing" && (
              <>
                <StatusPill variant="attn">! {c.missingTitle}</StatusPill>
                <p className="muted" style={{ margin: "14px 0" }}>{c.missingBody}</p>
                <b>{c.howToFix}</b>
                <ol className="muted" style={{ margin: "8px 0 16px", paddingInlineStart: 20 }}>{c.fixSteps.map((f, i) => <li key={i}>{f}</li>)}</ol>
                <div className="row gap12"><button className="btn btn-primary" onClick={runCheck}>{c.recheck}</button><a className="btn btn-outline" href={WA}>{a.talk}</a></div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
