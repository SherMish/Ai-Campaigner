import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { strings } from "../strings";
import {
  postLeadQuality,
  getCampaignAudiences,
  getPendingLaunch,
  approveLaunch,
  getControlState,
  getAdMedia,
  setObjectPaused,
  setAdRemoved,
  getAdDetail,
  type AdDetail,
  ApiError,
  type ControlState,
  type AdMedia,
  type AudienceCreativeRow,
  shekels,
  type CustomerOverview,
  type HomeState,
  type CampaignAudiences,
  type LaunchSummary,
  type LeadQualityStatus,
  type DailyPoint,
  type RangeKey,
  type AdditionUnavailableReason,
  type AttentionKind,
  type NoActionReason,
  RANGE_KEYS,
} from "../api";
import { assertNever } from "@aic/shared";
import { ATTENTION_COPY, HERO_TONE, HOME_STATE_BADGE, noRecCopy, STATUS_TOOLTIP_COPY, statusTooltipKey, thresholdLine } from "./state-copy";
import { AD_DELIVERY_BADGE, AD_DELIVERY_TONE, deliveryStatus } from "./delivery-status";
import { InfoTip } from "./InfoTip";
import { StatusPill } from "./components";
import { useSharedOverview, invalidateOverview } from "./overview-store";

const a = strings.he.app;
const h = a.home;
const L = h.live;
const D = h.details;
const CT = h.controls;
const ST = h.statusTooltip;

// AIC-98: the reason -> copy binding now lives in state-copy.ts as an
// exhaustive Record, so a new engine reason is a compile error instead of
// silently falling through to the generic "we're watching the campaign"
// message. This wrapper only keeps the call sites below unchanged.
const noRecCard = noRecCopy;

// AIC-97: the compact "מצב" badge (rail) shows a bare pill with no
// explanation — three of the seven HomeState values share צריך טיפול with
// different causes, and none say whether budget is being spent right now or
// who needs to act, both real facts a customer paying for ads actually has.
// Every tooltip answers the same three questions in the same order (design
// constraint from the ticket) so it's scannable rather than a bespoke
// paragraph per state.
//
// A `position: fixed` popover, positioned in JS off the button's own
// bounding rect rather than pure CSS: the compact-clip-avoidance
// requirement (must not clip at viewport edges) needs the actual button
// position and viewport size, which CSS alone can't clamp against reliably.
// Opens on hover, tap (click), AND keyboard focus — hover-only is
// unusable on the phones customers actually check campaigns on.
function StatusInfo({ tooltipKey }: { tooltipKey: ReturnType<typeof statusTooltipKey> }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 280 });
  const copy = STATUS_TOOLTIP_COPY[tooltipKey];
  const popId = "status-info-popover";

  useEffect(() => {
    if (!open) return;
    function reposition() {
      const btn = btnRef.current;
      if (!btn) return;
      const margin = 8;
      const width = Math.min(280, window.innerWidth - margin * 2);
      const r = btn.getBoundingClientRect();
      let left = r.left + r.width / 2 - width / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
      const estHeight = popRef.current?.offsetHeight ?? 150;
      let top = r.bottom + 8;
      if (top + estHeight > window.innerHeight - margin) top = Math.max(margin, r.top - estHeight - 8);
      setPos({ top, left, width });
    }
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    // Hover on the wrapper (not just the button) so moving the pointer from
    // the "i" into the popover itself doesn't close it before it's read.
    <span
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={btnRef}
        type="button"
        className="info-affordance"
        aria-label={ST.infoLabel}
        aria-expanded={open}
        aria-describedby={open ? popId : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <span className="info-affordance-dot">i</span>
      </button>
      {open && (
        <div
          id={popId}
          role="tooltip"
          ref={popRef}
          className="info-popover"
          style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width }}
        >
          <p style={{ margin: 0, fontSize: "0.85rem" }}>{copy.meaning}</p>
          <div className="row between" style={{ marginTop: 8, fontSize: "0.78rem" }}>
            <span className="muted">{ST.spendQuestion}</span>
            <b>{copy.spend}</b>
          </div>
          <div className="row between" style={{ marginTop: 4, fontSize: "0.78rem" }}>
            <span className="muted">{ST.whoActsQuestion}</span>
            <b>{copy.whoActs}</b>
          </div>
        </div>
      )}
    </span>
  );
}

const PILL: Record<HomeState, "ok" | "info" | "neutral" | "attn"> = {
  ok: "ok", collecting: "neutral", paused: "neutral", attention: "attn", no_campaign: "neutral", ready_to_launch: "info", stopped: "neutral",
};

// Which status-hero copy + optional CTA each real state shows. A `launch: true`
// hero opens the launch-approval modal instead of navigating (the only in-place
// action); the rest either link to a real screen or carry no button.
//
// Bug fix, 2026-08-14: "ok"/"collecting" used to carry their own fixed copy
// ("הכל עובד כרגיל") completely independent of the engine's actual reasoning —
// so a campaign with a real pending recommendation could show a hero claiming
// nothing needed attention, directly above a card saying otherwise. Both
// states now read through the SAME noRecCard() reasoning the pending-rec
// teaser already used, so the hero and the "why (not)" card can never again
// say different things about the same campaign.
function hero(state: HomeState, attentionKind: AttentionKind | null, readyToBuild: boolean, noRecReason: NoActionReason | null, wasBuiltHere: boolean, noRecDetail?: Record<string, unknown> | null, visibleLeads?: number | null): { badge: string; title: string; body: string; cta?: { to: string; label: string }; launch?: { label: string } } {
  switch (state) {
    case "attention": {
      // AIC-98: the three causes come from ATTENTION_COPY, an exhaustive
      // Record — a fourth cause can't ship reusing one of these messages.
      // Only `connection` carries a CTA: the other two are ours to fix, and
      // a button the customer can't act on is worse than no button.
      const kind = attentionKind ?? "connection";
      const copy = ATTENTION_COPY[kind];
      return kind === "connection"
        ? { ...copy, cta: { to: "/connect", label: h.states.attention.cta } }
        : copy;
    }
    case "ready_to_launch":
      // Bug fix, 2026-08-14: "we built it, it passed review" is false for a
      // campaign connected from outside the app — confirmed live. Same
      // badge/CTA either way; only the claim about who built it changes.
      return wasBuiltHere
        ? { badge: HOME_STATE_BADGE.ready_to_launch, title: h.states.readyToLaunch.title, body: h.states.readyToLaunch.body, launch: { label: h.states.readyToLaunch.cta } }
        : { badge: HOME_STATE_BADGE.ready_to_launch, title: h.states.readyToLaunchConnected.title, body: h.states.readyToLaunchConnected.body, launch: { label: h.states.readyToLaunch.cta } };
    case "paused":
      return { badge: HOME_STATE_BADGE.paused, title: h.states.paused.title, body: h.states.paused.body };
    case "stopped":
      return { badge: HOME_STATE_BADGE.stopped, title: h.states.stopped.title, body: h.states.stopped.body };
    case "no_campaign":
      // Connected + ready → the guided builder (AIC-52); still onboarding/
      // connecting → the existing setup-status copy, unchanged.
      if (readyToBuild) return { ...h.states.createCampaign, cta: { to: "/app/builder", label: h.states.createCampaign.cta } };
      return { ...h.states.setup, cta: { to: "/onboarding", label: h.states.setup.cta } };
    case "collecting":
    case "ok": {
      const nr = noRecCard(noRecReason, noRecDetail, visibleLeads);
      return { badge: HOME_STATE_BADGE[state], title: nr.title, body: nr.body, cta: nr.cta };
    }
    default:
      // AIC-98: no catch-all. A new HomeState without a branch fails tsc here
      // rather than silently rendering the "ok" hero, which is how a state
      // meaning "something is wrong" could ship looking like "all good".
      return assertNever(state, "HomeState");
  }
}

// The pending-recommendation teaser — its own eyebrow/title/CTA layout,
// shared between the merged hero (state ok/collecting) and the rare fallback
// case (a pending rec surviving alongside a more urgent state).
function RecTeaser({ ov }: { ov: CustomerOverview }) {
  return (
    <div className="rec">
      <div className="k">{h.recWaitingTitle}</div>
      <h3>{(ov.pendingRecommendationType && a.recDetail.titles[ov.pendingRecommendationType]) || h.recWaitingTitle}</h3>
      <div className="actions">
        <Link className="btn btn-primary btn-sm" to="/app/recommendations">{h.view}</Link>
      </div>
    </div>
  );
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("he-IL", { day: "numeric", month: "short" });

// The day/week/month/all-time switcher. Design reference: a pill row where the
// selected item is a white chip on the cream track. Makes the window an
// explicit choice instead of an unstated assumption — the previous screen
// showed a "today" card next to 7-day KPIs and the two read as contradictory.
function RangeSwitcher({ value, onChange }: { value: RangeKey; onChange: (r: RangeKey) => void }) {
  return (
    <div className="range-switch" role="tablist" aria-label={h.graphTitle}>
      {RANGE_KEYS.map((k) => (
        <button
          key={k}
          role="tab"
          aria-selected={value === k}
          className={`range-opt${value === k ? " on" : ""}`}
          onClick={() => onChange(k)}
        >
          {h.ranges[k]}
        </button>
      ))}
    </div>
  );
}

// Leads per week — the rail's "is this trending anywhere" glance. Built from
// the disjoint per-day series (never the overlapping rolling windows), bucketed
// into trailing 7-day blocks, oldest first.
function LeadsGraph({ daily, isEngagement = false }: { daily: DailyPoint[]; isEngagement?: boolean }) {
  const weeks: Array<{ label: string; leads: number }> = [];
  if (daily.length > 0) {
    const last = daily[daily.length - 1].date;
    const end = new Date(last + "T00:00:00Z").getTime();
    for (let w = 3; w >= 0; w--) {
      const hi = end - w * 7 * 86400000;
      const lo = hi - 6 * 86400000;
      const isoLo = new Date(lo).toISOString().slice(0, 10);
      const isoHi = new Date(hi).toISOString().slice(0, 10);
      weeks.push({
        label: fmtDate(isoLo),
        leads: daily.filter((p) => p.date >= isoLo && p.date <= isoHi).reduce((s, p) => s + p.leads, 0),
      });
    }
  }
  const max = Math.max(1, ...weeks.map((w) => w.leads));
  const total = weeks.reduce((s, w) => s + w.leads, 0);
  const hasAny = total > 0;

  return (
    <div className="card">
      <div className="row between" style={{ flexWrap: "wrap", alignItems: "baseline", gap: 10 }}>
        <b style={{ fontSize: "0.98rem" }}>{isEngagement ? h.graphTitleEngagement : h.graphTitle}</b>
        {hasAny && <span className="bars-total">{total} {h.graphTotalSuffix}</span>}
      </div>
      {!hasAny ? (
        <p className="muted" style={{ marginTop: 10, fontSize: "0.88rem" }}>{h.graphEmpty}</p>
      ) : (
        <div className="bars">
          {weeks.map((w, i) => (
            <div key={i} className="col">
              <div
                className="bar"
                title={`${h.graphWeekPrefix} ${w.label}: ${w.leads}`}
                style={{
                  // min-height in CSS keeps an empty week a visible sliver, so
                  // "no leads" reads as zero rather than a missing bar.
                  height: `${Math.round((w.leads / max) * 100)}%`,
                  background: w.leads > 0 ? "var(--orange)" : "rgba(23,23,23,.12)",
                }}
              />
              <span className="lbl">{w.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
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
  const [range, setRange] = useState<RangeKey>("week");

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
  const hd = hero(
    state, ov.attentionKind, readyToBuild,
    ov.campaign?.noRecReason ?? null, ov.campaign?.wasBuiltHere ?? false,
    // AIC-145: the engine already recorded WHICH evidence gate is unmet and by
    // how much; the hero says it instead of "a bit more activity".
    ov.campaign?.noRecDetail,
    // The same 7-day figure the KPI card shows, so the hero can never claim
    // the customer has fewer leads than the screen beside it displays.
    ov.readout?.ranges.week.leads ?? null,
  );
  const tooltipKey = statusTooltipKey(state, ov.attentionKind, readyToBuild);
  // A pending recommendation (including the AIC-86 advisory type, which fires
  // before any evidence gate) outranks the "nothing to report" hero — it IS
  // the current status. Scoped to ok/collecting: attention/paused/stopped
  // already say something more urgent, so a pending rec there is supplementary
  // rather than contradictory, and stays in its own small fallback card below.
  const hasPendingHero = (state === "ok" || state === "collecting") && ov.pendingRecommendations > 0;
  const r = ov.readout;
  // One explicit window, chosen by the customer — replaces the old
  // "today card + separate 7-day KPIs" split, which showed two sets of
  // numbers for the same campaign and read as a contradiction.
  const agg = r?.ranges[range] ?? r?.current;
  // AIC-107: which RESULT this campaign counts. `objective` is written from
  // the destination at build time (campaign-create.ts), so it is the same
  // single source of truth the engine uses — not a second guess from copy.
  const isEngagementCampaign = ov.campaign?.objective === "engagement";
  // AIC-130: no rows in this window means we have NOT measured zero — we have
  // measured nothing. Rendering "₪0 · 0 פניות" under a panel that says "אין
  // נתונים לתקופה שנבחרה" was the product contradicting itself on one screen,
  // and the zero is the half that isn't true. Same rule the per-ad rows
  // already follow with hasData.
  const hasRangeData = r?.rangeHasData?.[range] ?? true;
  // The comparison line belongs to the SELECTED window. It used to be one
  // fixed 7-day figure shown under every range — so היום rendered "—" for the
  // number with "▲20% מהתקופה הקודמת" beneath it, and חודש put a month's
  // total above a week's movement. Null means we have no honest comparison
  // and the line simply doesn't render.
  const rd = r?.rangeDeltas?.[range] ?? null;
  const leads = agg?.leads ?? 0;
  const cpl = agg?.cplAgorot ?? null;
  const spend = agg?.spendAgorot ?? 0;
  // AIC-71: `deliveringAdCount` is the engine's live per-tick count of ads
  // that are actually deliverable right now (real ad/ad-set status) — the
  // honest number. Before the engine's first tick for this campaign it's
  // null, so fall back to the historical-spend count (deduplicated by
  // creative NAME, AIC-37: the same creative can run under multiple audiences
  // as distinct Meta ad objects, but the customer thinks of it as one).
  const activeAds =
    ov.campaign?.deliveringAdCount ??
    new Set((r?.perCreative ?? []).map((c) => c.creativeName ?? c.metaObjectId)).size;
  // AIC-143, second pass. A full-size card is a claim on the customer's
  // attention, and most no-recommendation states have no claim to make.
  // "Nothing should change right now" is a real engine conclusion and should
  // read as calm judgement — not as a product waiting for a counter to reach
  // five. Only a problem, or something they must do, earns the card.
  const quietHero =
    (state === "ok" || state === "collecting") &&
    HERO_TONE[ov.campaign?.noRecReason ?? "stable"] === "quiet";
  const threshold = thresholdLine(ov.campaign?.noRecReason ?? null, ov.campaign?.noRecDetail, shekels);
  const period = ov.campaign?.budgetPeriod === "monthly" ? L.perMonth : L.perDay;

  return (
    <div className="wrap page dash">
      {/* Design reference: the range switcher sits inline with the page
          title, not stacked below the hero. */}
      <div className="dash-head">
        <h1 className="dash-title">{h.title}</h1>
        <RangeSwitcher value={range} onChange={setRange} />
      </div>

      <div className="dash-grid">
        {/* MAIN column */}
        <div className="dash-main">
          {/* status hero — a pending recommendation (ok/collecting states
              only) replaces the "nothing to report" copy entirely, rather
              than sitting in a second card that could say the opposite. */}
          {hasPendingHero ? (
            <RecTeaser ov={ov} />
          ) : quietHero ? (
            /* One line, no card. The evidence that produced this verdict lives
               behind the "i" — a customer who wants to know why can ask, and
               nobody else is made to read our internal thresholds. */
            <div className="row" style={{ gap: 8, alignItems: "center", padding: "4px 2px 8px", flexWrap: "wrap" }}>
              <span style={{ fontWeight: 600 }}>{h.quiet.title}</span>
              <span className="muted">{h.quiet.body}</span>
              <InfoTip label={h.quiet.why}>
                <b style={{ display: "block", marginBottom: 6 }}>{hd.title}</b>
                <p style={{ margin: 0 }}>{hd.body}</p>
                {threshold && <p style={{ margin: "8px 0 0" }}>{threshold}</p>}
              </InfoTip>
            </div>
          ) : (
            <div className="card">
              <div className="row between" style={{ flexWrap: "wrap", gap: 14 }}>
                <div>
                  <StatusPill variant={PILL[state]}>{hd.badge}</StatusPill>
                  {/* AIC-143: no facts line here. It restated the KPI cards
                      immediately below it — same window, same figures — so the
                      hero said everything twice. The cards ARE the facts; this
                      card's job is only the gap and the threshold. */}
                  <h2 style={{ fontSize: "1.35rem", margin: "12px 0 8px" }}>{hd.title}</h2>
                  <p className="muted" style={{ maxWidth: "42em" }}>{hd.body}</p>
                  {/* AIC-143: the threshold, with its number — a commitment
                      rather than "עוד מוקדם". Null wherever no numeric gate
                      exists, or where the body already carries it. */}
                  {threshold && (
                    <p style={{ marginTop: 8, maxWidth: "42em", fontSize: "0.9rem" }}>{threshold}</p>
                  )}
                </div>
                {hd.cta && <Link className="btn btn-primary btn-sm" to={hd.cta.to}>{hd.cta.label}</Link>}
                {hd.launch && <button className="btn btn-primary btn-sm" onClick={() => setLaunchOpen(true)}>{hd.launch.label}</button>}
              </div>
            </div>
          )}

          {launchOpen && <LaunchModal onClose={() => setLaunchOpen(false)} />}

          <div className="grid-3">
            <div className="kpi">
              <b>{cpl === null ? L.none : shekels(cpl)}</b>
              <div className="lbl">{isEngagementCampaign ? h.kpiCplEngagement : h.kpiCpl}</div>
              <Delta pct={rd?.cplPct ?? null} goodDown />
            </div>
            <div className="kpi">
              <b>{hasRangeData ? leads : L.none}</b>
              <div className="lbl">{isEngagementCampaign ? h.kpiLeadsEngagement : h.kpiLeads}</div>
              <Delta pct={rd?.leadsPct ?? null} />
            </div>
            <div className="kpi">
              <b>{hasRangeData ? shekels(spend) : L.none}</b>
              <div className="lbl">{h.kpiSpend}</div>
              <Delta pct={rd?.spendPct ?? null} />
            </div>
          </div>

          {/* Only "today" is a still-updating partial window. */}
          {range === "day" && (
            <p className="muted" style={{ fontSize: "0.8rem", paddingInline: 20 }}>{h.provisional}</p>
          )}

          {/* opt-in per-audience / per-creative details (AIC-37) — collapsed by default */}
          {ov.campaign && <AudienceDetails activeAds={activeAds} range={range} />}

          {/* Bug fix, 2026-08-14: a pending recommendation while state is ok/
              collecting is now folded straight into the hero above (see
              hasPendingHero) — the old design showed it a SECOND time here,
              stacked directly under a hero that said "nothing needs your
              attention", which read as the product contradicting itself.
              This fallback only fires for the rare case a rec is pending
              while a MORE urgent state (attention/paused/stopped) already
              owns the hero — there it's supplementary, not contradictory. */}
          {!hasPendingHero && state !== "ok" && state !== "collecting" && ov.pendingRecommendations > 0 && (
            <RecTeaser ov={ov} />
          )}

          {/* weekly feedback — AIC-107: "how many were relevant?" has no
              subject for an engagement campaign, so it is replaced by what
              the engine actually does for this type, not left blank. */}
          {isEngagementCampaign ? (
            <div className="card">
              <b>{h.engagementScopeTitle}</b>
              <p className="muted" style={{ marginTop: 10 }}>{h.engagementScopeBody}</p>
            </div>
          ) : (
            ov.leadQuality && <LeadQualityCard leadQuality={ov.leadQuality} />
          )}

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
                    <span>{it.summary} · <span className="muted">{it.actor === "automated" ? L.automated : it.actor === "customer" ? L.byYou : L.byUs}</span></span>
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
              {/* Bug fix, 2026-08-16 (reverted same day): first tried
                  overriding this row's justify-content to cluster the label
                  and the pill together — wrong call, reported live: every
                  other summary row keeps label-right/value-left (RTL), and
                  this one should match it, not be the odd one out. The
                  actual problem was the `i` circle reading too large/heavy
                  next to a short two-letter label — fixed at the source in
                  `.info-affordance` (ui.css) instead of fighting the shared
                  row layout. */}
              <div className="summary-row">
                <span className="k" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{h.sMode}<StatusInfo tooltipKey={tooltipKey} /></span>
                <StatusPill variant={PILL[state]}>{hd.badge}</StatusPill>
              </div>
              <div className="summary-row"><span className="k">{h.sBudget}</span><b>{ov.campaign ? `${shekels(ov.campaign.liveBudgetAgorot ?? ov.campaign.agreedBudgetAgorot)} ${period}` : L.none}</b></div>
              <div className="summary-row"><span className="k">{h.sAds}</span><b>{activeAds > 0 ? `${activeAds} ${L.adsActive}` : L.none}</b></div>
              <div className="summary-row"><span className="k">{h.sLeads}</span><b>{leads}</b></div>
            </div>
          </div>
          {r && <LeadsGraph isEngagement={isEngagementCampaign} daily={r.daily} />}
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
// no META delete here; a real archive/delete stays operator-only. AIC-128 adds
// a second action on a PAUSED ad — remove from view — which writes nothing to
// Meta and is reversible.
//
// AIC-73 round 2: DEMOTED from a large outline pill to a quiet text link. It's
// a secondary, mildly destructive action and was previously the most prominent
// element in the row after the title. Reading order should be
// "what is this → how is it doing → (quietly) what can I do".
function PauseLink({
  kind, metaObjectId, paused, busy, justSucceeded, onToggle, onRemove, alreadyNotDelivering,
}: {
  kind: "ad" | "ad_set";
  metaObjectId: string;
  paused: boolean;
  busy: boolean;
  // AIC-70: this row's action just completed successfully — show a brief
  // confirmation instead of silence (which read as "did my click work?").
  justSucceeded: boolean;
  onToggle: (kind: "ad" | "ad_set", id: string, pause: boolean) => void;
  // AIC-128: offered ONLY on a paused ad, which is the user-visible half of a
  // rule the server enforces anyway. A running ad removed from view would be
  // invisible and still spending — the one expensive mistake this surface
  // could otherwise allow.
  onRemove?: (id: string) => void;
  // AIC-100: the ad's own switch is on, but it isn't actually showing (a
  // parent is paused) — offering "השהיית המודעה" here isn't a no-op (it sets
  // the ad's own intent so it stays paused once the parent resumes), but
  // nothing said so, reading as an action with no effect.
  alreadyNotDelivering?: boolean;
}) {
  const label = kind === "ad_set"
    ? (paused ? CT.resumeAdSet : CT.pauseAdSet)
    : (paused ? CT.resumeAd : CT.pauseAd);
  const title = kind === "ad_set" && !paused
    ? CT.adSetNote
    : paused
      ? CT.resumeNote
      : alreadyNotDelivering
        ? CT.pauseBlockedNote
        : undefined;
  return (
    <span className="row gap8" style={{ alignItems: "center" }}>
      {justSucceeded && !busy && (
        <span className="muted" style={{ fontSize: "0.78rem", color: "var(--green)" }}>
          {paused ? CT.pausedNow : CT.resumedNow}
        </span>
      )}
      <button
        className="link"
        disabled={busy}
        style={{ background: "none", border: "none", padding: "6px 2px", fontSize: "0.82rem", cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
        title={title}
        onClick={(e) => { e.stopPropagation(); onToggle(kind, metaObjectId, !paused); }}
      >
        {busy ? CT.working : label}
      </button>
      {/* The paused row's second action. Quiet, not red: this is reversible
          and touches nothing on Meta, so dressing it as a destructive control
          would overstate what it does. */}
      {onRemove && paused && (
        <button
          className="link"
          disabled={busy}
          style={{ background: "none", border: "none", padding: "6px 2px", fontSize: "0.82rem", cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
          onClick={(e) => { e.stopPropagation(); onRemove(metaObjectId); }}
        >
          {CT.removeAd}
        </button>
      )}
    </span>
  );
}

// Per-row state (AIC-73 round 2) — arguably the most useful single fact in a
// detail row, and previously absent: you could only infer "is this running?"
// from which way the action button pointed. Uses AIC-71's state vocabulary:
// a customer's own pause is distinct from a problem.
function RowStatus({ label, tone }: { label: string; tone: "ok" | "warn" | "neutral" }) {
  return (
    <span className={`pill ${tone}`} style={{ padding: "2px 10px", fontSize: "0.72rem", whiteSpace: "nowrap" }}>
      <span className="dot" />
      {label}
    </span>
  );
}

// A real chevron, not a text triangle: renders consistently as SVG at small
// sizes instead of depending on font metrics, and rotates to communicate
// current state (AIC-73 round 2 — the old ▾ was ~10px, low-contrast, and
// didn't read as interactive).
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform .18s ease", flexShrink: 0 }}
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
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

// AIC-73 round 2: the nested disclosure is GONE. One click on "פירוט" reveals
// audiences AND their ads. Progressive disclosure solved a volume problem that
// doesn't exist here (a typical customer has 1–2 audiences × 1–5 ads, and the
// P0 builder always creates exactly one ad set), it hid the very thing the
// customer just asked for, and it corrupted AIC-37's measurement — low
// engagement conflated "doesn't want detail" with "never found the second
// toggle". Hierarchy now comes from layout, not from interaction.
//
// Adaptive guard: above ADAPTIVE_COLLAPSE_ABOVE audiences the per-audience
// collapse comes BACK, so disclosure is earned by real volume rather than
// applied preemptively to the ~95% who have one audience.
const ADAPTIVE_COLLAPSE_ABOVE = 3;

function AudienceDetails({ activeAds, range }: { activeAds: number; range: RangeKey }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<CampaignAudiences | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Live statuses + creative media, fetched alongside the details (the readout
  // itself is DB-only — a cached status would render a button that lies, and
  // it carries no image data at all).
  const [ctl, setCtl] = useState<ControlState | null>(null);
  const [media, setMedia] = useState<Map<string, AdMedia>>(new Map());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [ctlFailed, setCtlFailed] = useState(false);
  // Bug fix, 2026-08-15: /state and /media 409 with a specific reason
  // (missing_page/connection_issue/not_launched) when the connection can't
  // support these reads — set from whichever of the two calls below fails
  // first with a real reason, so pause buttons / creative images degrade to
  // an honest note instead of silently vanishing.
  const [readUnavailable, setReadUnavailable] = useState<AdditionUnavailableReason | null>(null);
  // AIC-70: which row just succeeded, so the confirmation renders right where
  // the change happened. Cleared as soon as another action starts.
  const [successId, setSuccessId] = useState<string | null>(null);
  // AIC-128: which ad sets have their removed-ads list expanded, the ad
  // awaiting confirmation, and the server's refusal if it comes.
  // AIC-139: which ad's details modal is open, and what we loaded for it.
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdDetail | null>(null);
  const [detailError, setDetailError] = useState(false);
  const [removedOpen, setRemovedOpen] = useState<Set<string>>(new Set());
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  function fetchAudiences(r: RangeKey) {
    setLoading(true);
    getCampaignAudiences(r)
      .then((d) => {
        setData(d);
        // Only collapse when there's genuinely enough volume to manage.
        if (d.audiences.length > ADAPTIVE_COLLAPSE_ABOVE) {
          setCollapsed(new Set(d.audiences.map((x) => x.adSetId)));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  // Captures the reason on a 409 (missing_page/connection_issue/not_launched)
  // so the panel can say why pause/thumbnails are unavailable instead of
  // just not showing them. Any other failure (network blip, 502) stays
  // silent — degrade quietly, same as before — since there's nothing
  // specific to tell the customer about a transient error.
  function noteIfKnownReason(e: unknown) {
    if (e instanceof ApiError && e.status === 409) {
      const reason = (e.body as { reason?: AdditionUnavailableReason } | undefined)?.reason;
      if (reason) setReadUnavailable(reason);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !data) fetchAudiences(range);
    if (next && !ctl) getControlState().then(setCtl).catch(noteIfKnownReason);
    if (next && media.size === 0) {
      getAdMedia()
        .then((r) => setMedia(new Map(r.ads.map((m) => [m.adId, m]))))
        .catch(noteIfKnownReason); // degrade to names, but say why if we know
    }
  }

  // AIC-95: the panel now follows the switcher, so a range change while it's
  // already open must refetch — not just the first-open fetch above. Skipped
  // while closed (AIC-37's opt-in principle: nothing about audiences is
  // fetched until the customer actually opens the panel), and skipped on the
  // very first render (that's `toggle`'s job, guarded by `!data`).
  const isFirstRangeEffect = useRef(true);
  useEffect(() => {
    if (isFirstRangeEffect.current) { isFirstRangeEffect.current = false; return; }
    if (open) fetchAudiences(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  const isPaused = (kind: "ad" | "ad_set", id: string) =>
    (kind === "ad" ? ctl?.adStatuses[id] : ctl?.adSetStatuses[id]) === "paused";

  async function onToggle(kind: "ad" | "ad_set", id: string, pause: boolean) {
    setBusyId(id);
    setCtlFailed(false);
    setSuccessId(null);
    try {
      const result = await setObjectPaused(kind, id, pause);
      // AIC-70: write straight from the verified result instead of re-reading
      // `/state` — that read hits Meta's `effective_status`, which lags a
      // just-applied write. We already know the true new status (setObjectPaused
      // read-back-verified it server-side); trusting it here is what makes the
      // row update immediately instead of occasionally showing the pre-write
      // state until a manual refresh.
      setCtl((prev) => {
        const base = prev ?? { adStatuses: {}, adSetStatuses: {}, campaignStatus: "active" as const };
        const key = kind === "ad" ? "adStatuses" : "adSetStatuses";
        return { ...base, [key]: { ...base[key], [id]: result.status === "ACTIVE" ? "active" : "paused" } };
      });
      setSuccessId(id);
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

  // AIC-128. Both directions refetch rather than patching local state: a
  // removal moves a row between two lists AND changes the reconciliation line
  // under the ad set, so guessing the new shape client-side would be a second
  // implementation of the server's rules, free to drift from it.
  // Fetched on OPEN, never with the panel: this is a live Meta read per ad,
  // and pulling every ad's copy up front would pay for text nobody asked to
  // see. Cleared first so a slow second open never shows the previous ad's
  // copy under the new ad's title.
  function openDetail(adId: string) {
    setDetailFor(adId);
    setDetail(null);
    setDetailError(false);
    getAdDetail(adId).then(setDetail).catch(() => setDetailError(true));
  }

  async function onRemoveToggle(adId: string, remove: boolean) {
    setBusyId(adId);
    setRemoveError(null);
    setSuccessId(null);
    try {
      await setAdRemoved(adId, remove);
      setConfirmRemove(null);
      fetchAudiences(range);
      setSuccessId(adId);
    } catch (e) {
      // The server refuses to remove an ad that is still ACTIVE (409). The
      // button isn't offered in that state, so this means our view of the
      // status was stale — say so plainly rather than failing silently.
      setRemoveError(e instanceof ApiError && e.status === 409 ? CT.removeNeedsPause : CT.failed);
      setConfirmRemove(null);
    } finally {
      setBusyId(null);
    }
  }

  const adaptive = (data?.audiences.length ?? 0) > ADAPTIVE_COLLAPSE_ABOVE;

  return (
    <div className="card">
      {/* Whole row is the hit target at ≥44px (the accessibility floor) — the
          old ~10px text triangle was near-impossible to hit on a phone and
          didn't read as interactive. */}
      <button
        className="row gap8"
        style={{ width: "100%", minHeight: 44, background: "none", border: "none", cursor: "pointer", padding: 0, font: "inherit", color: "inherit", textAlign: "start" }}
        onClick={toggle}
        aria-expanded={open}
      >
        <Chevron open={open} />
        <b>{open ? D.hide : D.show}</b>
        {!open && activeAds > 0 && (
          <span className="muted" style={{ fontSize: "0.85rem" }}>· {activeAds} {D.previewAds}</span>
        )}
      </button>

      {open && (
        <div style={{ marginTop: 10 }}>
          {/* Same provisional-today note the KPI cards show for "היום" —
              AIC-95 reuses it here rather than inventing a second one, since
              this panel now reads the exact same still-updating window. */}
          {range === "day" && <p className="muted" style={{ fontSize: "0.8rem", marginBottom: 10 }}>{h.provisional}</p>}
          {ctlFailed && <p className="muted" style={{ color: "var(--orange)", marginBottom: 10 }}>{CT.failed}</p>}
          {removeError && <p className="muted" style={{ color: "var(--orange)", marginBottom: 10 }}>{removeError}</p>}
          {readUnavailable && (
            <p className="muted" style={{ marginBottom: 10 }}>
              {CT.readUnavailable} <Link className="link" to="/app/settings">{CT.goToSettings}</Link>
            </p>
          )}
          {loading ? (
            <p className="muted">{a.loading}</p>
          ) : !data ? (
            <p className="muted">{D.empty}</p>
          ) : data.empty?.reason === "started_today" ? (
            <p className="muted">{D.emptyStartedToday}</p>
          ) : data.empty?.reason === "no_data_in_range" ? (
            <p className="muted">
              {D.emptyNoDataInRange}
              {data.empty.mostRecentDataDate ? fmtDate(data.empty.mostRecentDataDate) : ""}
            </p>
          ) : data.audiences.length === 0 ? (
            // data.empty?.reason === "no_data_yet", or the defensive fallback
            // for a response with neither rows nor a reason.
            <p className="muted">{D.empty}</p>
          ) : (
            <div className="stack gap8">
              {data.audiences.map((aud) => {
                const audPaused = isPaused("ad_set", aud.adSetId);
                // AIC-130: an ad set switched ON delivers nothing if every ad
                // under it is off. Only asserted when we actually have live
                // statuses AND rows to judge — with no creatives in the window
                // this view knows nothing about what's running, and guessing
                // would replace one false badge with another.
                const noLiveAds =
                  !audPaused &&
                  // Every ad we can see is paused...
                  ((!!ctl && aud.creatives.length > 0 &&
                    aud.creatives.every((c) => isPaused("ad", c.metaObjectId))) ||
                   // ...or every ad this audience has was removed, so there is
                   // nothing left to run at all. Without this second case an ad
                   // set whose last ad was deleted reads מפרסם forever — an
                   // ACTIVE switch with nothing behind it. Requires at least
                   // one removed ad as evidence: an empty `creatives` on its
                   // own only means "no data in this window", which says
                   // nothing about what is running.
                   (aud.creatives.length === 0 && aud.removedCreatives.length > 0));
                const shown = !collapsed.has(aud.adSetId);
                return (
                  <div key={aud.adSetId} className="soft" style={{ borderRadius: 14, padding: 14 }}>
                    {/* Audience = a section HEADER, not a toggle: status +
                        label, then its metrics immediately underneath. The
                        metrics used to float opposite the title with a large
                        gap between them and a lone button — the whitespace
                        read as "something failed to load". */}
                    <div className="row between" style={{ gap: 10, alignItems: "flex-start" }}>
                      <div className="row gap8" style={{ flexWrap: "wrap", alignItems: "center" }}>
                        {adaptive && (
                          <button
                            className="row"
                            style={{ minHeight: 44, background: "none", border: "none", cursor: "pointer", padding: 0, color: "inherit" }}
                            onClick={() => setCollapsed((prev) => {
                              const next = new Set(prev);
                              if (next.has(aud.adSetId)) next.delete(aud.adSetId); else next.add(aud.adSetId);
                              return next;
                            })}
                            aria-expanded={shown}
                          >
                            <Chevron open={shown} />
                          </button>
                        )}
                        <RowStatus
                          label={audPaused ? D.statusPausedByYou : noLiveAds ? D.statusNoLiveAds : D.statusRunning}
                          tone={audPaused || noLiveAds ? "neutral" : "ok"}
                        />
                        <b><bdi>{aud.label}</bdi></b>
                      </div>
                      {ctl && (
                        <PauseLink
                          kind="ad_set" metaObjectId={aud.adSetId}
                          paused={audPaused} busy={busyId === aud.adSetId}
                          justSucceeded={successId === aud.adSetId} onToggle={onToggle}
                        />
                      )}
                    </div>
                    <div className="row gap16" style={{ flexWrap: "wrap", marginTop: 6 }}>
                      <Metric label={D.spendCol} value={shekels(aud.spendAgorot)} />
                      <Metric label={D.leadsCol} value={String(aud.leads)} />
                      <Metric label={D.cplCol} value={aud.cplAgorot === null ? L.none : shekels(aud.cplAgorot)} />
                    </div>
                    {aud.moreCreativesCount > 0 && (
                      <p className="muted" style={{ fontSize: "0.8rem", marginTop: 4 }}>
                        {aud.moreCreativesCount === 1
                          ? D.moreCreativesOne
                          : `${D.moreCreativesManyPrefix} ${aud.moreCreativesCount} ${D.moreCreativesManySuffix}`}
                      </p>
                    )}

                    {/* Its ads, nested by LAYOUT (indent + rule), not behind a
                        second click. */}
                    {shown && (
                      <div style={{ marginTop: 12, borderInlineStart: "2px solid var(--line)", paddingInlineStart: 12 }}>
                        {aud.creatives.length === 0 ? (
                          <p className="muted" style={{ fontSize: "0.85rem" }}>{D.noCreatives}</p>
                        ) : (
                          <div className="stack gap12">
                            {aud.creatives.map((c) => {
                              const adPaused = isPaused("ad", c.metaObjectId);
                              // AIC-100: resolved delivery, not the ad's own
                              // status alone — an ad set can carry this
                              // "active" while its ad set (or the campaign)
                              // is paused, and nothing then actually shows.
                              const adDelivery = deliveryStatus(
                                adPaused ? "paused" : "active",
                                isPaused("ad_set", aud.adSetId) ? "paused" : "active",
                                ctl?.campaignStatus ?? "active",
                              );
                              const m = media.get(c.metaObjectId);
                              return (
                                <div key={c.metaObjectId}>
                                  <div className="row between" style={{ gap: 10, alignItems: "flex-start" }}>
                                    <div className="row gap8" style={{ flexWrap: "wrap", alignItems: "center" }}>
                                      {/* An ad with no data yet carries its OWN
                                          state — in review, or rejected. The
                                          normal delivery badge would call a
                                          just-created ad "running", which it
                                          is not yet, and would call a rejected
                                          one "running" forever. */}
                                      {c.adState === "in_review" ? (
                                        <RowStatus label={D.adInReview} tone="neutral" />
                                      ) : c.adState === "rejected" ? (
                                        <RowStatus label={D.adRejected} tone="warn" />
                                      ) : (
                                        <RowStatus label={AD_DELIVERY_BADGE[adDelivery]} tone={AD_DELIVERY_TONE[adDelivery]} />
                                      )}
                                      {/* Honest count: what Meta actually
                                          reports for this creative, never
                                          inferred from the ad's name. */}
                                      {/* AIC-139: the row's own title is the
                                          affordance. A separate "details" link
                                          would add a third control to a row
                                          that already carries pause and
                                          remove. */}
                                      <button
                                        className="link"
                                        style={{ background: "none", border: "none", padding: 0, font: "inherit", fontWeight: 700, fontSize: "0.85rem", cursor: "pointer", textAlign: "start" }}
                                        title={D.adDetailOpen}
                                        onClick={(e) => { e.stopPropagation(); openDetail(c.metaObjectId); }}
                                      >
                                        {m && m.assetCount > 1 ? `${m.assetCount} ${D.adCreativesSuffix}` : D.adOne}
                                      </button>
                                    </div>
                                    {ctl && (
                                      <PauseLink
                                        kind="ad" metaObjectId={c.metaObjectId}
                                        paused={adPaused} busy={busyId === c.metaObjectId}
                                        justSucceeded={successId === c.metaObjectId} onToggle={onToggle}
                                        onRemove={(id) => { setRemoveError(null); setConfirmRemove(id); }}
                                        alreadyNotDelivering={adDelivery === "blocked_by_adset" || adDelivery === "blocked_by_campaign"}
                                      />
                                    )}
                                  </div>

                                  {/* The ads ARE pictures — a comma-separated
                                      English name string was the weakest
                                      possible representation of them. Falls
                                      back to the name when Meta gives us no
                                      usable image. */}
                                  {m && m.thumbnails.length > 0 ? (
                                    <div className="row gap8" style={{ flexWrap: "wrap", marginTop: 6 }}>
                                      {m.thumbnails.map((src, i) => (
                                        <img
                                          key={i} src={src} alt="" loading="lazy"
                                          style={{ width: 44, height: 44, borderRadius: 8, objectFit: "cover", background: "var(--cream-2)" }}
                                        />
                                      ))}
                                    </div>
                                  ) : (
                                    <div className="muted" style={{ fontSize: "0.8rem", marginTop: 4 }}>
                                      <bdi>{c.creativeName ?? c.metaObjectId}</bdi>
                                    </div>
                                  )}

                                  {/* Same metric set as the audience row —
                                      previously the ad row silently dropped
                                      עלות לפנייה. */}
                                  {/* hasData:false means "no results YET",
                                      which is a different claim from "₪0, 0
                                      leads" — that would report zero RESULTS
                                      for an ad that has not had the chance to
                                      produce any. Say which one is true. */}
                                  {c.hasData ? (
                                    <div className="row gap12" style={{ flexWrap: "wrap", marginTop: 6 }}>
                                      <Metric label={D.spendCol} value={shekels(c.spendAgorot)} small />
                                      <Metric label={D.leadsCol} value={String(c.leads)} small />
                                      <Metric label={D.cplCol} value={c.cplAgorot === null ? L.none : shekels(c.cplAgorot)} small />
                                    </div>
                                  ) : (
                                    <p className="muted" style={{ fontSize: "0.8rem", marginTop: 6 }}>
                                      {c.adState === "rejected" ? D.adRejectedBody : D.adInReviewBody}
                                    </p>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* AIC-128: removed ads, behind a toggle rather than on
                            a separate screen — they belong next to the total
                            they still count toward. Two ways in, one bucket:
                            the customer removed it here, or an operator
                            archived/deleted it at Meta. */}
                        {aud.removedCreativesCount > 0 && (
                          <div style={{ marginTop: 12 }}>
                            <button
                              className="link"
                              style={{ background: "none", border: "none", padding: "6px 0", fontSize: "0.82rem", cursor: "pointer" }}
                              aria-expanded={removedOpen.has(aud.adSetId)}
                              onClick={() => setRemovedOpen((prev) => {
                                const next = new Set(prev);
                                if (next.has(aud.adSetId)) next.delete(aud.adSetId); else next.add(aud.adSetId);
                                return next;
                              })}
                            >
                              {removedOpen.has(aud.adSetId) ? D.removedHide : D.removedShow} ({aud.removedCreativesCount})
                            </button>
                            {/* THE LINE THAT KEEPS THE PANEL HONEST. A removed
                                ad keeps every insight row it produced, so its
                                spend and leads are still inside the audience
                                total above — without saying so, the visible
                                rows simply fail to add up and it reads as
                                money going missing. Only shown when there IS
                                money to explain. */}
                            {aud.removedSpendAgorot > 0 && (
                              <p className="muted" style={{ fontSize: "0.78rem", margin: "2px 0 0" }}>
                                {D.removedAccountsFor} {shekels(aud.removedSpendAgorot)} · {aud.removedLeads} {D.leadsCol}
                              </p>
                            )}
                            {removedOpen.has(aud.adSetId) && (
                              <div className="stack gap8" style={{ marginTop: 8, opacity: 0.75 }}>
                                {aud.removedCreatives.map((c) => (
                                  <RemovedAdRow
                                    key={c.metaObjectId} c={c}
                                    busy={busyId === c.metaObjectId}
                                    justRestored={successId === c.metaObjectId}
                                    onRestore={() => onRemoveToggle(c.metaObjectId, false)}
                                  />
                                ))}
                              </div>
                            )}
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

      {/* AIC-139: the ad's full creative. Read-only, because Meta's own
          reference lists `name` and `status` as the ONLY editable fields on a
          creative — the copy and the image are frozen at creation. The card at
          the bottom says exactly that and points at the flow that does work,
          rather than offering an edit control that would silently rebuild the
          ad and restart its learning. */}
      {detailFor && (
        <div className="op-modal-backdrop" onClick={() => setDetailFor(null)}>
          <div className="op-modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
            <b style={{ fontSize: "1.05rem" }}>{D.adDetailTitle}</b>
            {detailError ? (
              <p className="muted" style={{ marginTop: 12, color: "var(--orange)" }}>{D.adDetailError}</p>
            ) : !detail ? (
              <p className="muted" style={{ marginTop: 12 }}>{D.adDetailLoading}</p>
            ) : (
              <div style={{ marginTop: 12 }}>
                {detail.imageUrl && (
                  <img
                    src={detail.imageUrl}
                    alt=""
                    // Capped, and `contain` so a portrait creative is not
                    // cropped. Uncapped, a tall ad image filled the whole
                    // modal and pushed the copy, the CTA and both buttons
                    // below the fold — measured at 1030px in a 720px viewport.
                    // This modal exists to show the DETAILS; the picture is
                    // context, not the subject.
                    style={{
                      width: "100%", maxHeight: 220, objectFit: "contain",
                      borderRadius: 12, marginBottom: 12, background: "var(--page)",
                    }}
                  />
                )}
                {detail.fromExistingPost ? (
                  <p className="muted" style={{ fontSize: "0.85rem" }}>{D.adDetailFromPost}</p>
                ) : (
                  <>
                    <DetailRow label={D.adDetailHeadline} value={detail.headline} />
                    <DetailRow label={D.adDetailPrimary} value={detail.primaryText} />
                  </>
                )}
                <DetailRow
                  label={D.adDetailCta}
                  value={detail.ctaType ? (D.ctaLabels[detail.ctaType] ?? detail.ctaType) : null}
                />
                <DetailRow label={D.adDetailDestination} value={detail.whatsappNumber ?? detail.link} />

                <div className="soft" style={{ borderRadius: 12, padding: 12, marginTop: 14 }}>
                  <b style={{ fontSize: "0.9rem", display: "block", marginBottom: 4 }}>{D.adDetailEditTitle}</b>
                  <p className="muted" style={{ fontSize: "0.82rem", margin: "0 0 10px" }}>{D.adDetailEditBody}</p>
                  <Link className="btn btn-primary btn-sm" to="/app/add-content">{D.adDetailEditCta}</Link>
                </div>
              </div>
            )}
            <div style={{ marginTop: 14 }}>
              <button className="btn btn-outline btn-sm" onClick={() => setDetailFor(null)}>{D.adDetailClose}</button>
            </div>
          </div>
        </div>
      )}

      {/* A light confirm, deliberately NOT the confirm-to-type the admin
          console demands for a real Meta archive/delete. This is reversible and
          Meta never sees it, so that bar would be theatre — but the body copy
          still has to say plainly what does and doesn't happen, because the
          button says "מחיקה" and the ad is not being deleted. */}
      {confirmRemove && (
        <div className="op-modal-backdrop" onClick={() => setConfirmRemove(null)}>
          <div className="op-modal" onClick={(e) => e.stopPropagation()}>
            <b style={{ fontSize: "1.05rem" }}>{CT.removeConfirm}</b>
            <p className="muted" style={{ margin: "10px 0" }}>{CT.removeConfirmBody}</p>
            <div className="row gap12" style={{ marginTop: 12 }}>
              <button
                className="btn btn-primary btn-sm"
                disabled={busyId === confirmRemove}
                onClick={() => onRemoveToggle(confirmRemove, true)}
              >
                {busyId === confirmRemove ? CT.working : CT.removeConfirmCta}
              </button>
              <button className="btn btn-outline btn-sm" onClick={() => setConfirmRemove(null)}>{CT.removeCancel}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// AIC-139: one labelled line in the ad-details modal. Renders an em dash for a
// missing value rather than collapsing the row — a field that is absent is
// itself information, and a silently missing line reads as a rendering bug.
function DetailRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="muted" style={{ fontSize: "0.75rem" }}>{label}</div>
      <div style={{ fontSize: "0.88rem", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {value?.trim() ? value : D.adDetailEmpty}
      </div>
    </div>
  );
}

// AIC-128. One removed ad. The restore button appears only for by_customer —
// gone_at_meta means the object no longer exists in the ad account, and Meta
// has no un-archive through any API, so a restore button there would be a
// button that cannot work. It gets a plain explanation instead.
function RemovedAdRow({ c, busy, justRestored, onRestore }: {
  c: AudienceCreativeRow;
  busy: boolean;
  justRestored: boolean;
  onRestore: () => void;
}) {
  const restorable = c.removed === "by_customer";
  return (
    <div>
      <div className="row between" style={{ gap: 10, alignItems: "flex-start" }}>
        <div className="row gap8" style={{ flexWrap: "wrap", alignItems: "center" }}>
          <RowStatus label={restorable ? D.removedByYou : D.removedAtMeta} tone="neutral" />
          <b style={{ fontSize: "0.85rem" }}><bdi>{c.creativeName ?? c.metaObjectId}</bdi></b>
        </div>
        {restorable && (
          <span className="row gap8" style={{ alignItems: "center" }}>
            {justRestored && !busy && (
              <span className="muted" style={{ fontSize: "0.78rem", color: "var(--green)" }}>{CT.restoredNow}</span>
            )}
            <button
              className="link" disabled={busy}
              style={{ background: "none", border: "none", padding: "6px 2px", fontSize: "0.82rem", cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
              onClick={onRestore}
            >
              {busy ? CT.working : CT.restoreAd}
            </button>
          </span>
        )}
      </div>
      {!restorable && (
        <p className="muted" style={{ fontSize: "0.78rem", marginTop: 2 }}>{D.removedAtMetaNote}</p>
      )}
      {/* Its numbers stay visible: they are still inside the audience total, so
          hiding them here would make the reconciliation line unverifiable. */}
      {c.hasData && (
        <div className="row gap12" style={{ flexWrap: "wrap", marginTop: 4 }}>
          <Metric label={D.spendCol} value={shekels(c.spendAgorot)} small />
          <Metric label={D.leadsCol} value={String(c.leads)} small />
          <Metric label={D.cplCol} value={c.cplAgorot === null ? L.none : shekels(c.cplAgorot)} small />
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
  // Why approval isn't offered. Server-computed and server-enforced — this
  // only decides what the button looks like and what we tell the customer.
  const blockers = summary?.blockers ?? [];

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
            {/* Every row states a fact we actually have. A row whose value is
                unknown is omitted rather than rendered blank — on a consent
                screen a confident label beside an empty value asserts
                something untrue. The missing fact becomes a blocker below. */}
            {summary.adCount !== null && (
              <div className="summary-row"><span className="k">{LN.adsLine}</span><b>{summary.adCount}</b></div>
            )}
            {summary.destination.kind === "whatsapp" && (
              <div className="summary-row">
                <span className="k">{LN.whatsappLine}</span>
                <b>{summary.destination.whatsappNumber}</b>
              </div>
            )}
            {summary.destination.kind === "website" && (
              <div className="summary-row">
                <span className="k">{LN.websiteLine}</span>
                <b>
                  {LN.leadEvent[summary.destination.eventKey] ?? summary.destination.eventKey}
                  {summary.destination.domain ? ` — ${summary.destination.domain}` : ""}
                </b>
              </div>
            )}
            {blockers.length > 0 && (
              <div style={{ marginTop: 16 }}>
                {blockers.map((b) => (
                  <p key={b} className="muted" style={{ color: "var(--orange)", marginBottom: 6 }}>
                    {LN.blocked[b] ?? b}
                  </p>
                ))}
              </div>
            )}
            {error && <p className="muted" style={{ marginTop: 14, color: "var(--orange)" }}>{LN.failed}</p>}
            <div className="row gap12" style={{ marginTop: 22 }}>
              {/* Disabled on a real precondition, with the reason stated above
                  — never a silently dead button. The server re-checks. */}
              <button className="btn btn-primary" onClick={approve} disabled={approving || blockers.length > 0}>{approving ? LN.approving : LN.approveCta}</button>
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

  // Only the ASK is the loud ink+orange card (design reference) — it's the one
  // thing on the page that wants the customer to do something. Caught-up and
  // thank-you states stay quiet white cards.
  const asking = !saved && pending > 0;

  return (
    <div className={`card${asking ? " lq-card" : ""}`}>
      <div className="row between">
        {asking ? <div className="lq-eyebrow">{h.weeklyTitle}</div> : <b>{h.weeklyTitle}</b>}
        {!saved && !asking && (
          <span className="pill ok" style={{ fontSize: "0.75rem" }}>{h.caughtUpBadge}</span>
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
          <div style={{ fontSize: "1.25rem", fontWeight: 700, marginTop: 10 }}>{h.pendingQuestion}</div>
          <p className="muted" style={{ margin: "8px 0 16px" }}>{h.pendingPrefix} {pending} {h.pendingSuffix}</p>
          <div className="row gap16" style={{ flexWrap: "wrap" }}>
            <div className="stepper-inline">
              <button onClick={() => setRelevant((c) => Math.max(0, c - 1))}>−</button>
              <span className="v">{relevant}</span>
              <button onClick={() => setRelevant((c) => Math.min(pending, c + 1))}>+</button>
            </div>
            <button className="btn btn-primary" onClick={submit} disabled={saving}>{a.save}</button>
          </div>
          {error && <p className="muted" style={{ marginTop: 10 }}>{a.loadError}</p>}
        </>
      )}
    </div>
  );
}
