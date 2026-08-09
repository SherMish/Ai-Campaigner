import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { strings } from "../strings";
import {
  getOverview,
  postLeadQuality,
  getCampaignAudiences,
  shekels,
  type CustomerOverview,
  type HomeState,
  type CampaignAudiences,
} from "../api";
import { StatusPill } from "./components";

const a = strings.he.app;
const h = a.home;
const L = h.live;
const D = h.details;

const PILL: Record<HomeState, "ok" | "info" | "neutral" | "attn"> = {
  ok: "ok", collecting: "neutral", paused: "neutral", attention: "attn", no_campaign: "neutral",
};

// Which status-hero copy + optional CTA each real state shows. Only CTAs that
// point at a real screen are wired; paused/collecting/ok carry no button.
function hero(state: HomeState, attentionKind: CustomerOverview["attentionKind"]): { badge: string; title: string; body: string; cta?: { to: string; label: string } } {
  switch (state) {
    case "attention":
      // A delivery problem (AIC-39) reads differently from a lost connection.
      if (attentionKind === "delivery")
        return { badge: h.states.delivery.badge, title: h.states.delivery.title, body: h.states.delivery.body };
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
    return <div className="wrap page"><p className="muted">{a.loading}</p></div>;

  if (err || !ov)
    return (
      <div className="wrap page">
        <div className="card">
          <p className="muted" style={{ marginBottom: 12 }}>{a.loadError}</p>
          <button className="btn btn-outline btn-sm" onClick={load}>{a.retry}</button>
        </div>
      </div>
    );

  const state = ov.homeState;
  const hd = hero(state, ov.attentionKind);
  const r = ov.readout;
  const leads = r?.current.leads ?? 0;
  const cpl = r?.current.cplAgorot ?? null;
  const spend = r?.current.spendAgorot ?? 0;
  // De-duplicated by creative NAME (AIC-37): the same creative can run under
  // multiple audiences (ad sets) as distinct Meta ad objects, but the customer
  // thinks of it as one creative — the roll-up should count concepts, not rows.
  const activeAds = new Set((r?.perCreative ?? []).map((c) => c.creativeName ?? c.metaObjectId)).size;
  const period = ov.campaign?.budgetPeriod === "monthly" ? L.perMonth : L.perDay;

  return (
    <div className="wrap page dash">
      <h1 className="dash-title">{h.title}</h1>

      <div className="dash-grid">
        {/* MAIN column */}
        <div className="dash-main">
          {/* status hero */}
          <div className="card">
            <div className="row between" style={{ flexWrap: "wrap", gap: 14 }}>
              <div>
                <StatusPill variant={PILL[state]}>{hd.badge}</StatusPill>
                <h2 style={{ fontSize: "1.35rem", margin: "12px 0 8px" }}>{hd.title}</h2>
                <p className="muted" style={{ maxWidth: "42em" }}>{hd.body}</p>
              </div>
              {hd.cta && <Link className="btn btn-primary btn-sm" to={hd.cta.to}>{hd.cta.label}</Link>}
            </div>
          </div>

          {/* KPIs — the questions the customer actually asks */}
          <div className="grid-3">
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

          {/* opt-in per-audience / per-creative details (AIC-37) — collapsed by default */}
          {ov.campaign && <AudienceDetails />}

          {/* a pending recommendation outranks the reassurance card */}
          {ov.pendingRecommendations > 0 ? (
            <div className="rec">
              <div className="k">{h.recWaitingTitle}</div>
              <h3>{h.recWaiting}</h3>
              <div className="actions">
                <Link className="btn btn-primary btn-sm" to="/app/recommendations">{h.viewApprove}</Link>
              </div>
            </div>
          ) : (state === "ok" || state === "collecting") ? (
            <div className="card">
              <StatusPill variant="ok">{h.noActionTitle}</StatusPill>
              <p className="muted" style={{ marginTop: 12 }}>{h.noAction}</p>
            </div>
          ) : null}

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

        {/* RAIL — campaign at a glance */}
        <div className="dash-rail">
          <div className="card">
            <b style={{ fontSize: "0.98rem" }}>{ov.campaign?.name || h.summaryTitle}</b>
            <div style={{ marginTop: 12 }}>
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

// The opt-in "details" door (AIC-37): collapsed by default, fetched lazily only
// when the customer opens it. Per-audience rows, each expandable to its own
// per-creative breakdown. Business-framed labels only (audience by its human
// dimension, creative by design name) — no raw ad-jargon metrics.
//
// Instrumentation note: AIC-37 asks this toggle to feed the "do customers want
// abstraction or detail" product question via the AIC-28 metrics layer. AIC-28
// isn't built yet, so there's no event sink to write to — deferred until it
// lands rather than half-building a bespoke one here.
function AudienceDetails() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<CampaignAudiences | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !data) {
      setLoading(true);
      getCampaignAudiences().then(setData).catch(() => {}).finally(() => setLoading(false));
    }
  }

  return (
    <div className="card">
      <button
        className="row between"
        style={{ width: "100%", background: "none", border: "none", cursor: "pointer", padding: 0, font: "inherit", color: "inherit" }}
        onClick={toggle}
        aria-expanded={open}
      >
        <b>{open ? D.hide : D.show}</b>
        <span style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform .15s" }}>▾</span>
      </button>

      {open && (
        <div style={{ marginTop: 14 }}>
          {loading ? (
            <p className="muted">{a.loading}</p>
          ) : !data || data.audiences.length === 0 ? (
            <p className="muted">{D.empty}</p>
          ) : (
            <div className="stack gap8">
              {data.audiences.map((aud) => (
                <div key={aud.adSetId} className="soft" style={{ borderRadius: 14, padding: 14 }}>
                  <button
                    className="row between"
                    style={{ width: "100%", background: "none", border: "none", cursor: "pointer", padding: 0, font: "inherit", color: "inherit" }}
                    onClick={() => setExpanded(expanded === aud.adSetId ? null : aud.adSetId)}
                  >
                    <b>{aud.label}</b>
                    <span className="muted" style={{ fontSize: "0.85rem" }}>
                      {shekels(aud.spendAgorot)} · {aud.leads} {D.leadsCol} · {aud.cplAgorot === null ? L.none : shekels(aud.cplAgorot)}
                    </span>
                  </button>
                  {expanded === aud.adSetId && aud.creatives.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      {aud.creatives.map((c) => (
                        <div key={c.metaObjectId} className="summary-row" style={{ fontSize: "0.85rem" }}>
                          <span className="k">{c.creativeName ?? c.metaObjectId}</span>
                          <b>{shekels(c.spendAgorot)} · {c.leads} {D.leadsCol}</b>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
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
