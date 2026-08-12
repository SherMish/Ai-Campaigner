import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { strings } from "../strings";
import {
  postLeadQuality,
  getCampaignAudiences,
  getPendingLaunch,
  approveLaunch,
  shekels,
  type CustomerOverview,
  type HomeState,
  type CampaignAudiences,
  type LaunchSummary,
} from "../api";
import { StatusPill } from "./components";
import { useSharedOverview, invalidateOverview } from "./overview-store";

const a = strings.he.app;
const h = a.home;
const L = h.live;
const D = h.details;

// AIC-64: distinct, honest copy for WHY there's no recommendation, keyed by the
// engine's reason. `delivery_blocked` is deliberately absent — a delivery
// problem already routes homeState to "attention" before this card ever
// renders (see deriveHomeState), so it would never reach here.
function noRecCard(reason: string | null): { title: string; body: string; cta?: { to: string; label: string } } {
  switch (reason) {
    case "collecting":
      return h.noRec.collecting;
    case "budget_below_threshold":
      return { ...h.noRec.budgetBelowThreshold, cta: { to: "/app/settings", label: h.noRec.budgetBelowThreshold.cta } };
    case "single_ad_set":
      return h.noRec.singleAdSet;
    case "stable":
      return h.noRec.stable;
    default:
      // Engine hasn't classified a reason yet (e.g. before its first tick).
      return { title: h.noActionTitle, body: h.noAction };
  }
}

const PILL: Record<HomeState, "ok" | "info" | "neutral" | "attn"> = {
  ok: "ok", collecting: "neutral", paused: "neutral", attention: "attn", no_campaign: "neutral", ready_to_launch: "info",
};

// Which status-hero copy + optional CTA each real state shows. A `launch: true`
// hero opens the launch-approval modal instead of navigating (the only in-place
// action); the rest either link to a real screen or carry no button.
function hero(state: HomeState, attentionKind: CustomerOverview["attentionKind"], readyToBuild: boolean): { badge: string; title: string; body: string; cta?: { to: string; label: string }; launch?: { label: string } } {
  switch (state) {
    case "attention":
      // A delivery problem (AIC-39) reads differently from a lost connection.
      if (attentionKind === "delivery")
        return { badge: h.states.delivery.badge, title: h.states.delivery.title, body: h.states.delivery.body };
      return { ...h.states.attention, cta: { to: "/connect", label: h.states.attention.cta } };
    case "ready_to_launch":
      return { badge: h.states.readyToLaunch.badge, title: h.states.readyToLaunch.title, body: h.states.readyToLaunch.body, launch: { label: h.states.readyToLaunch.cta } };
    case "paused":
      return { badge: h.states.paused.badge, title: h.states.paused.title, body: h.states.paused.body };
    case "collecting":
      return h.states.collecting;
    case "no_campaign":
      // Connected + ready → the guided builder (AIC-52); still onboarding/
      // connecting → the existing setup-status copy, unchanged.
      if (readyToBuild) return { ...h.states.createCampaign, cta: { to: "/app/builder", label: h.states.createCampaign.cta } };
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
  const { data: ov, loading, error: err, reload } = useSharedOverview(); // shared with Sidebar/Settings (AIC-42)
  const [launchOpen, setLaunchOpen] = useState(false);

  if (loading && !ov)
    return <div className="wrap page"><p className="muted">{a.loading}</p></div>;

  if (err || !ov)
    return (
      <div className="wrap page">
        <div className="card">
          <p className="muted" style={{ marginBottom: 12 }}>{a.loadError}</p>
          <button className="btn btn-outline btn-sm" onClick={reload}>{a.retry}</button>
        </div>
      </div>
    );

  const state = ov.homeState;
  const readyToBuild = ov.connection?.accessHealth === "ok" && !!ov.connection.adAccount && !!ov.connection.pageId;
  const hd = hero(state, ov.attentionKind, readyToBuild);
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
              {hd.launch && <button className="btn btn-primary btn-sm" onClick={() => setLaunchOpen(true)}>{hd.launch.label}</button>}
            </div>
          </div>

          {launchOpen && <LaunchModal onClose={() => setLaunchOpen(false)} />}

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
            (() => {
              const nr = noRecCard(ov.campaign?.noRecReason ?? null);
              return (
                <div className="card">
                  <StatusPill variant="ok">{nr.title}</StatusPill>
                  <p className="muted" style={{ marginTop: 12 }}>{nr.body}</p>
                  {nr.cta && <Link className="btn btn-outline btn-sm" style={{ marginTop: 12 }} to={nr.cta.to}>{nr.cta.label}</Link>}
                </div>
              );
            })()
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
              <div className="summary-row"><span className="k">{h.sBudget}</span><b>{ov.campaign ? `${shekels(ov.campaign.liveBudgetAgorot ?? ov.campaign.agreedBudgetAgorot)} ${period}` : L.none}</b></div>
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

// The launch-approval modal (AIC-53): the customer sees exactly what will run —
// budget, estimated monthly max spend, ad count, WhatsApp destination — and an
// explicit approve. Approving is what actually flips the campaign to spending;
// nothing here activates without this click.
const LN = a.launch;
function LaunchModal({ onClose }: { onClose: () => void }) {
  const [summary, setSummary] = useState<LaunchSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    getPendingLaunch()
      .then((r) => setSummary(r.launch))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  function approve() {
    setApproving(true);
    setError(false);
    approveLaunch()
      .then((r) => {
        if (r.outcome === "activated" || r.outcome === "already_launched") {
          setDone(true);
          invalidateOverview(); // Home re-fetches → the hero leaves the launch state
        } else {
          setError(true);
        }
      })
      .catch(() => setError(true))
      .finally(() => setApproving(false));
  }

  const maxMonthly = summary && summary.budgetPeriod === "daily" ? summary.dailyBudgetAgorot * 30 : summary?.dailyBudgetAgorot ?? 0;

  return (
    <div className="op-modal-backdrop" onClick={onClose}>
      <div className="op-modal" onClick={(e) => e.stopPropagation()}>
        {done ? (
          <div>
            <StatusPill variant="ok">✓</StatusPill>
            <h3 style={{ fontSize: "1.3rem", margin: "12px 0 10px" }}>{LN.successTitle}</h3>
            <p className="muted" style={{ marginBottom: 20 }}>{LN.successBody}</p>
            <button className="btn btn-primary" onClick={onClose}>{h.states.ok.badge}</button>
          </div>
        ) : loading ? (
          <p className="muted">{a.loading}</p>
        ) : !summary ? (
          <div><p className="muted" style={{ marginBottom: 16 }}>{a.loadError}</p><button className="btn btn-outline btn-sm" onClick={onClose}>{LN.cancel}</button></div>
        ) : (
          <div>
            <h3 style={{ fontSize: "1.3rem", marginBottom: 10 }}>{LN.title}</h3>
            <p className="muted" style={{ marginBottom: 18 }}>{LN.intro}</p>
            <div className="summary-row"><span className="k">{LN.nameLine}</span><b>{summary.name}</b></div>
            <div className="summary-row"><span className="k">{LN.budgetLine}</span><b>{shekels(summary.dailyBudgetAgorot)} {L.perDay}</b></div>
            <div className="summary-row"><span className="k">{LN.maxSpendLine}</span><b>{shekels(maxMonthly)} {LN.perMonth}</b></div>
            <div className="summary-row"><span className="k">{LN.adsLine}</span><b>{summary.adCount}</b></div>
            <div className="summary-row"><span className="k">{LN.whatsappLine}</span><b>{summary.whatsappDestination}</b></div>
            {error && <p className="muted" style={{ marginTop: 14, color: "var(--orange)" }}>{LN.failed}</p>}
            <div className="row gap12" style={{ marginTop: 22 }}>
              <button className="btn btn-primary" onClick={approve} disabled={approving}>{approving ? LN.approving : LN.approveCta}</button>
              <button className="btn btn-outline" onClick={onClose} disabled={approving}>{LN.cancel}</button>
            </div>
          </div>
        )}
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
