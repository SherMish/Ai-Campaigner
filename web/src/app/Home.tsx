import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { strings } from "../strings";
import {
  postLeadQuality,
  getCampaignAudiences,
  getPendingLaunch,
  approveLaunch,
  getControlState,
  setObjectPaused,
  type ControlState,
  shekels,
  type CustomerOverview,
  type HomeState,
  type CampaignAudiences,
  type LaunchSummary,
  type LeadQualityStatus,
} from "../api";
import { StatusPill } from "./components";
import { useSharedOverview, invalidateOverview } from "./overview-store";

const a = strings.he.app;
const h = a.home;
const L = h.live;
const D = h.details;
const CT = h.controls;

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
  ok: "ok", collecting: "neutral", paused: "neutral", attention: "attn", no_campaign: "neutral", ready_to_launch: "info", stopped: "neutral",
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
    case "stopped":
      return { badge: h.states.stopped.badge, title: h.states.stopped.title, body: h.states.stopped.body };
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
  // AIC-71: `deliveringAdCount` is the engine's live per-tick count of ads
  // that are actually deliverable right now (real ad/ad-set status) — the
  // honest number. Before the engine's first tick for this campaign it's
  // null, so fall back to the historical-spend count (deduplicated by
  // creative NAME, AIC-37: the same creative can run under multiple audiences
  // as distinct Meta ad objects, but the customer thinks of it as one).
  const activeAds =
    ov.campaign?.deliveringAdCount ??
    new Set((r?.perCreative ?? []).map((c) => c.creativeName ?? c.metaObjectId)).size;
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
          {ov.campaign && <AudienceDetails activeAds={activeAds} />}

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
          {ov.leadQuality && <LeadQualityCard leadQuality={ov.leadQuality} />}

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
// The customer's own pause/resume (AIC-66). Pausing your own ad IS the
// authorization — no approval step, unlike an engine recommendation. There is
// deliberately no delete here; destructive actions are operator-only.
function PauseToggle({
  kind, metaObjectId, paused, busy, onToggle,
}: {
  kind: "ad" | "ad_set";
  metaObjectId: string;
  paused: boolean;
  busy: boolean;
  onToggle: (kind: "ad" | "ad_set", id: string, pause: boolean) => void;
}) {
  const label = kind === "ad_set"
    ? (paused ? CT.resumeAdSet : CT.pauseAdSet)
    : (paused ? CT.resumeAd : CT.pauseAd);
  return (
    <button
      className="btn btn-outline btn-sm"
      disabled={busy}
      title={kind === "ad_set" && !paused ? CT.adSetNote : paused ? CT.resumeNote : undefined}
      onClick={(e) => { e.stopPropagation(); onToggle(kind, metaObjectId, !paused); }}
    >
      {busy ? CT.working : label}
    </button>
  );
}

// A labeled number — the details panel's core honesty fix (AIC-73): every
// value shown carries its own label directly above it, so "9.5₪ · 1 · 9.5₪"
// never again reads like a rendering bug.
function Metric({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <span className="stack" style={{ gap: 2 }}>
      <span className="muted" style={{ fontSize: small ? "0.66rem" : "0.72rem" }}>{label}</span>
      <b style={{ fontSize: small ? "0.85rem" : "0.92rem" }}>{value}</b>
    </span>
  );
}

function AudienceDetails({ activeAds }: { activeAds: number }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<CampaignAudiences | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Live statuses, fetched alongside the details (the readout itself is
  // DB-only — a cached status would render a button that lies).
  const [ctl, setCtl] = useState<ControlState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [ctlFailed, setCtlFailed] = useState(false);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !data) {
      setLoading(true);
      getCampaignAudiences().then(setData).catch(() => {}).finally(() => setLoading(false));
    }
    if (next && !ctl) getControlState().then(setCtl).catch(() => {});
  }

  const isPaused = (kind: "ad" | "ad_set", id: string) =>
    (kind === "ad" ? ctl?.adStatuses[id] : ctl?.adSetStatuses[id]) === "paused";

  async function onToggle(kind: "ad" | "ad_set", id: string, pause: boolean) {
    setBusyId(id);
    setCtlFailed(false);
    try {
      await setObjectPaused(kind, id, pause);
      setCtl(await getControlState()); // re-read Meta's truth, don't assume
      // The server already recomputes homeState/delivering synchronously on
      // this write (AIC-71 follow-up) — invalidate the shared overview so the
      // headline "מצב" and מודעות פעילות count pick it up now, not on the
      // next navigation/reload. Per-row badges above are already live via ctl.
      invalidateOverview();
    } catch {
      setCtlFailed(true);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="card">
      {/* AIC-73: caret sits directly beside the label, and — while collapsed —
          a preview of what's inside, built from the count Home already has
          (no prefetch; audiences are still only fetched once opened). */}
      <button
        className="row gap8"
        style={{ background: "none", border: "none", cursor: "pointer", padding: 0, font: "inherit", color: "inherit" }}
        onClick={toggle}
        aria-expanded={open}
      >
        <span style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform .15s", fontSize: "0.8rem" }}>▾</span>
        <b>{open ? D.hide : D.show}</b>
        {!open && activeAds > 0 && (
          <span className="muted" style={{ fontSize: "0.85rem" }}>· {activeAds} {D.previewAds}</span>
        )}
      </button>

      {open && (
        <div style={{ marginTop: 14 }}>
          {ctlFailed && <p className="muted" style={{ color: "var(--orange)", marginBottom: 10 }}>{CT.failed}</p>}
          {loading ? (
            <p className="muted">{a.loading}</p>
          ) : !data || data.audiences.length === 0 ? (
            <p className="muted">{D.empty}</p>
          ) : (
            <div className="stack gap8">
              {data.audiences.map((aud) => {
                const isExpanded = expanded === aud.adSetId;
                return (
                  <div key={aud.adSetId} className="soft" style={{ borderRadius: 14, padding: 14 }}>
                    {/* Audience row: label + human targeting on one side, its
                        labeled metrics on the other — bidi-isolated so a
                        mixed Hebrew/English label never renders reversed. */}
                    <div className="row between" style={{ flexWrap: "wrap", gap: 10 }}>
                      <button
                        className="row gap8"
                        style={{ background: "none", border: "none", cursor: "pointer", padding: 0, font: "inherit", color: "inherit" }}
                        onClick={() => setExpanded(isExpanded ? null : aud.adSetId)}
                        aria-expanded={isExpanded}
                      >
                        <span style={{ transform: isExpanded ? "rotate(180deg)" : undefined, transition: "transform .15s", fontSize: "0.75rem" }}>▾</span>
                        <b><bdi>{aud.label}</bdi></b>
                        {isPaused("ad_set", aud.adSetId) && (
                          <span className="pill neutral" style={{ padding: "2px 8px", fontSize: "0.7rem" }}>{CT.pausedBadge}</span>
                        )}
                      </button>
                      <span className="row gap16" style={{ flexWrap: "wrap" }}>
                        <Metric label={D.spendCol} value={shekels(aud.spendAgorot)} />
                        <Metric label={D.leadsCol} value={String(aud.leads)} />
                        <Metric label={D.cplCol} value={aud.cplAgorot === null ? L.none : shekels(aud.cplAgorot)} />
                      </span>
                    </div>

                    {/* Consistent action placement (AIC-73): the audience's own
                        pause control always sits here, same position on every
                        card — never sharing a row with the expand toggle. */}
                    {ctl && (
                      <div style={{ marginTop: 10 }}>
                        <PauseToggle
                          kind="ad_set" metaObjectId={aud.adSetId}
                          paused={isPaused("ad_set", aud.adSetId)}
                          busy={busyId === aud.adSetId} onToggle={onToggle}
                        />
                      </div>
                    )}

                    {/* Its ads, visually nested under the audience (AIC-73) —
                        an explicit rule + indent, not near-equal weight. */}
                    {isExpanded && (
                      <div style={{ marginTop: 12, borderInlineStart: "2px solid var(--line)", paddingInlineStart: 12 }}>
                        <div className="muted" style={{ fontSize: "0.78rem", marginBottom: 8, fontWeight: 600 }}>{D.creativesHeading}</div>
                        {aud.creatives.length === 0 ? (
                          <p className="muted" style={{ fontSize: "0.85rem" }}>{D.noCreatives}</p>
                        ) : (
                          <div className="stack gap8">
                            {/* Single-child case: the one ad's numbers ARE the
                                audience's numbers — say so instead of letting
                                identical values look duplicated/broken. */}
                            {aud.creatives.length === 1 && (
                              <p className="muted" style={{ fontSize: "0.78rem" }}>{D.onlyChild}</p>
                            )}
                            {aud.creatives.map((c) => (
                              <div key={c.metaObjectId} className="row between" style={{ flexWrap: "wrap", gap: 8, paddingBottom: 8, borderBottom: "1px solid var(--line)" }}>
                                <span className="row gap8">
                                  <bdi style={{ fontSize: "0.88rem" }}>{c.creativeName ?? c.metaObjectId}</bdi>
                                  {isPaused("ad", c.metaObjectId) && (
                                    <span className="pill neutral" style={{ padding: "1px 7px", fontSize: "0.68rem" }}>{CT.pausedBadge}</span>
                                  )}
                                </span>
                                <span className="row gap12" style={{ flexWrap: "wrap", alignItems: "center" }}>
                                  <Metric label={D.spendCol} value={shekels(c.spendAgorot)} small />
                                  <Metric label={D.leadsCol} value={String(c.leads)} small />
                                  {ctl && (
                                    <PauseToggle
                                      kind="ad" metaObjectId={c.metaObjectId}
                                      paused={isPaused("ad", c.metaObjectId)}
                                      busy={busyId === c.metaObjectId} onToggle={onToggle}
                                    />
                                  )}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
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

// AIC-67: incremental delta review. Only ever asks about NEW leads since the
// last review — `pending` is server-computed from the watermark
// (customer-overview.ts), never a client-tracked total, so there's no
// "did I already count these?" mental math and double-counting is
// structurally impossible: the watermark can only ever advance.
function LeadQualityCard({ leadQuality }: { leadQuality: LeadQualityStatus }) {
  const { pending, reviewedSoFar, leadsThisWeek, relevantThisWeek } = leadQuality;
  // Defaults to "assume all relevant" — the customer adjusts down, same
  // low-friction convention the old cumulative field used.
  const [relevant, setRelevant] = useState(pending);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  // A fresh batch of pending leads arrived (or the watermark just advanced)
  // — keep the stepper's default in step, but only while the customer hasn't
  // started answering yet.
  useEffect(() => {
    if (!saving && !saved) setRelevant(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  if (reviewedSoFar === 0 && pending === 0)
    return <div className="card"><b>{h.weeklyTitle}</b><p className="muted" style={{ marginTop: 10 }}>{h.weeklyNoLeads}</p></div>;

  function submit() {
    setSaving(true);
    setError(false);
    postLeadQuality(relevant)
      .then(() => {
        setSaved(true);
        invalidateOverview(); // the watermark/status just advanced — refetch
      })
      .catch(() => setError(true))
      .finally(() => setSaving(false));
  }

  return (
    <div className="card">
      <div className="row between">
        <b>{h.weeklyTitle}</b>
        {!saved && (
          <span className={`pill ${pending > 0 ? "warn" : "ok"}`} style={{ fontSize: "0.75rem" }}>
            {pending > 0 ? `${pending} ${h.toReviewBadge}` : h.caughtUpBadge}
          </span>
        )}
      </div>

      {saved ? (
        <div style={{ marginTop: 12 }}><StatusPill variant="ok">✓ {h.weeklyThanksTitle}</StatusPill><p className="muted" style={{ marginTop: 10 }}>{h.weeklyThanks}</p></div>
      ) : pending === 0 ? (
        <>
          <p className="muted" style={{ marginTop: 10 }}>{h.caughtUpBody}</p>
          {leadsThisWeek > 0 && (
            <p style={{ marginTop: 8 }}>
              <span className="muted">{h.weeklyRunningLabel}: </span>
              <b>{relevantThisWeek} {h.relevantOfLeads} {leadsThisWeek}</b>
            </p>
          )}
        </>
      ) : (
        <>
          <p className="muted" style={{ margin: "8px 0 4px" }}>{h.pendingPrefix} {pending} {h.pendingSuffix}</p>
          <p style={{ margin: "4px 0 16px", fontWeight: 500 }}>{h.pendingQuestion}</p>
          <div className="row gap16" style={{ flexWrap: "wrap" }}>
            <div className="stepper-inline">
              <button onClick={() => setRelevant((c) => Math.max(0, c - 1))}>−</button>
              <span className="v">{relevant}</span>
              <button onClick={() => setRelevant((c) => Math.min(pending, c + 1))}>+</button>
            </div>
            <button className="btn btn-dark" onClick={submit} disabled={saving}>{a.save}</button>
          </div>
          {error && <p className="muted" style={{ marginTop: 10 }}>{a.loadError}</p>}
        </>
      )}
    </div>
  );
}
