import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { strings } from "../strings";
import {
  listRecommendations,
  getRecommendation,
  approveRecommendation,
  dismissRecommendation,
  shekels,
  ApiError,
  type CustomerRec,
  type CustomerRecList,
} from "../api";
import { StatusPill, WA } from "./components";

const a = strings.he.app;
const rc = a.recs;
const rd = a.recDetail;
const L = a.home.live;

const isBudget = (t: string) => t === "increase_budget" || t === "decrease_budget";

export function Recommendations() {
  const [data, setData] = useState<CustomerRecList | null>(null);
  const [err, setErr] = useState(false);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true); setErr(false);
    listRecommendations().then(setData).catch(() => setErr(true)).finally(() => setLoading(false));
  }
  useEffect(load, []);

  return (
    <div>
      <div className="wrap page dash" style={{ maxWidth: 820, marginInline: "auto" }}>
        <h1 className="dash-title">{rc.title}</h1>

        {loading ? (
          <p className="muted">{a.loading}</p>
        ) : err || !data ? (
          <div className="card">
            <p className="muted" style={{ marginBottom: 12 }}>{a.loadError}</p>
            <button className="btn btn-outline btn-sm" onClick={load}>{a.retry}</button>
          </div>
        ) : (
          <>
            {data.pending.length === 0 ? (
              <div className="card" style={{ marginBottom: 28 }}>
                <b style={{ fontSize: "1.1rem" }}>{rc.emptyTitle}</b>
                <p className="muted" style={{ marginTop: 8 }}>{rc.empty}</p>
              </div>
            ) : (
              data.pending.map((r) => (
                <div className="rec" style={{ marginBottom: 16 }} key={r.id}>
                  <div className="row between">
                    <StatusPill variant="warn">{rc.waiting}</StatusPill>
                  </div>
                  <h3 style={{ marginTop: 12 }}>{rd.titles[r.type]}</h3>
                  <p className="muted">{r.explanation}</p>
                  <div className="actions"><Link className="btn btn-primary" to={`/app/recommendations/${r.id}`}>{rc.view}</Link></div>
                </div>
              ))
            )}

            <h3 style={{ fontSize: "1.2rem", margin: "28px 0 8px" }}>{rc.doneTitle}</h3>
            <div className="card">
              {data.history.length === 0 ? (
                <p className="muted">{L.noActivity}</p>
              ) : (
                <div className="timeline">
                  {data.history.map((it, i) => (
                    <div className="t-item" key={i}>
                      <span className="when">{new Date(it.when).toLocaleDateString("he-IL", { day: "numeric", month: "short" })}</span>
                      <span className="grow">{it.summary}</span>
                      <StatusPill variant={it.result === "success" ? "ok" : "attn"}>{it.result === "success" ? "✓" : "!"}</StatusPill>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        <p className="center" style={{ marginTop: 24 }}>
          <span className="muted">{rc.notSure} </span><a className="link" href={WA}>{a.talk}</a>
        </p>
      </div>
    </div>
  );
}

type Phase = "idle" | "executing" | "executed" | "held" | "failed" | "dismissed";

export function RecommendationDetail() {
  const { id = "" } = useParams();
  const [rec, setRec] = useState<CustomerRec | null>(null);
  const [err, setErr] = useState(false);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true); setErr(false);
    getRecommendation(id).then(setRec).catch(() => setErr(true)).finally(() => setLoading(false));
  }, [id]);

  function approve() {
    setPhase("executing");
    approveRecommendation(id)
      .then((r) => {
        if (r.outcome === "executed") setPhase("executed");
        else if (r.outcome === "aborted") { setMessage(r.customerMessage); setPhase("held"); }
        else { setMessage(r.customerMessage); setPhase("failed"); }
      })
      .catch((e) => {
        setMessage(e instanceof ApiError && e.status === 503 ? rd.unavailableSub : null);
        setPhase(e instanceof ApiError && e.status === 503 ? "held" : "failed");
      });
  }
  function dismiss() {
    dismissRecommendation(id).then(() => setPhase("dismissed")).catch(() => setPhase("failed"));
  }

  return (
    <div>
      <div className="wrap page dash" style={{ maxWidth: 720, marginInline: "auto" }}>
        <Link className="link" to="/app/recommendations">{rd.back}</Link>

        {loading ? (
          <p className="muted" style={{ marginTop: 20 }}>{a.loading}</p>
        ) : err || !rec ? (
          <div className="card" style={{ marginTop: 20 }}>
            <p className="muted">{a.loadError}</p>
          </div>
        ) : phase === "executing" ? (
          <div className="card" style={{ marginTop: 20 }}>
            <div className="row gap16"><div className="spinner" /><div><b>{rd.approvedTitle}</b><p className="muted" style={{ fontSize: "0.9rem" }}>{rd.approvedSub}</p></div></div>
          </div>
        ) : phase === "executed" ? (
          <div className="card center" style={{ marginTop: 20, padding: 44 }}>
            <StatusPill variant="ok">✓</StatusPill>
            <h1 className="dash-title" style={{ margin: "14px 0 18px" }}>{rd.executedTitle}</h1>
            <div className="summary-row"><span className="k">{rd.whatWeDid}</span><b>{rd.titles[rec.type]}</b></div>
            <Link className="btn btn-primary" style={{ marginTop: 20 }} to="/app/recommendations">{rd.backToRecs}</Link>
          </div>
        ) : phase === "held" ? (
          <Result title={rd.heldTitle} sub={message || rd.heldSub} variant="neutral" />
        ) : phase === "failed" ? (
          <Result title={rd.failedTitle} sub={message || rd.failedSub} variant="attn" />
        ) : phase === "dismissed" ? (
          <Result title={rd.dismissedTitle} sub={rd.dismissedSub} variant="neutral" />
        ) : (
          <>
            <div className="row between" style={{ margin: "16px 0" }}>
              <StatusPill variant="warn">{rc.waiting}</StatusPill>
            </div>
            <h1 className="dash-title" style={{ marginBottom: 20 }}>{rd.titles[rec.type]}</h1>

            <div className="card" style={{ marginBottom: 16 }}>
              <b>{rd.whyTitle}</b>
              <p className="muted" style={{ marginTop: 8 }}>{rec.explanation}</p>
            </div>

            {isBudget(rec.type) && rec.currentBudgetAgorot != null && rec.proposedBudgetAgorot != null && (
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="row gap24" style={{ justifyContent: "center", padding: "6px 0" }}>
                  <div className="center"><div className="muted">{rd.today}</div><b style={{ fontSize: "1.4rem" }}>{shekels(rec.currentBudgetAgorot)} {L.perDay}</b></div>
                  <div style={{ fontSize: "1.6rem" }}>←</div>
                  <div className="center"><div className="muted">{rd.proposed}</div><b style={{ fontSize: "1.4rem", color: "var(--orange)" }}>{shekels(rec.proposedBudgetAgorot)} {L.perDay}</b></div>
                </div>
                {rec.maxSpendImpactAgorot != null && rec.maxSpendImpactAgorot > 0 && (
                  <p className="muted center" style={{ fontSize: "0.9rem" }}>{rd.maxImpactPrefix} {shekels(rec.maxSpendImpactAgorot)} {L.perDay}.</p>
                )}
              </div>
            )}

            <div className="card" style={{ marginBottom: 20 }}>
              <b>{rd.whatChangesTitle}</b>
              {rec.type === "pause_creative" && <ul className="muted" style={{ margin: "8px 0 0", paddingInlineStart: 18 }}>{rd.pauseChanges.map((x, i) => <li key={i}>{x}</li>)}</ul>}
              {rec.type === "pause_adset" && <p className="muted" style={{ marginTop: 8 }}>{rd.changesAudience}</p>}
              {isBudget(rec.type) && <p className="muted" style={{ marginTop: 8 }}>{rd.changesBudget}</p>}
              {rec.type === "replace_creative" && <p className="muted" style={{ marginTop: 8 }}>{rd.changesReplace}</p>}
            </div>

            <div className="row gap12" style={{ flexWrap: "wrap" }}>
              <button className="btn btn-primary" onClick={approve}>{a.approve}</button>
              <button className="btn btn-outline" onClick={dismiss}>{a.notNow}</button>
              <a className="btn btn-ghost" href={WA} style={{ marginInlineStart: "auto" }}>{rd.wantToTalk} {a.talk}</a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Result({ title, sub, variant }: { title: string; sub: string; variant: "info" | "neutral" | "attn" }) {
  return (
    <div className="card center" style={{ marginTop: 20, padding: 44 }}>
      <StatusPill variant={variant}>●</StatusPill>
      <h1 className="dash-title" style={{ margin: "14px 0 10px" }}>{title}</h1>
      <p className="muted">{sub}</p>
    </div>
  );
}
