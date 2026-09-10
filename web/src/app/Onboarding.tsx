import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { strings } from "../strings";
import { getOverview, startMetaOauth, type CustomerOverview } from "../api";
import { Brand, Stepper, SupportCard, StatusPill, WA } from "./components";

const a = strings.he.app;
const o = a.onboarding;

// The onboarding_status values (DB) → which design card + stepper index to show.
type S = "A" | "C" | "D" | "F";
const STATUS_STATE: Record<string, S> = {
  call_scheduled: "A",
  meta_connection_required: "C",
  campaign_under_review: "D",
  ready: "F",
};
const STEP_INDEX: Record<S, number> = { A: 1, C: 2, D: 3, F: 4 };

export function Onboarding() {
  const nav = useNavigate();
  const [ov, setOv] = useState<CustomerOverview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getOverview()
      .then((o) => {
        // A customer who has finished onboarding has no reason to sit here.
        if (o.customer?.onboardingStatus === "ready") { nav("/app", { replace: true }); return; }
        setOv(o);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [nav]);

  const s: S = STATUS_STATE[ov?.customer?.onboardingStatus ?? ""] ?? "A";
  const name = ov?.account.name?.trim();

  return (
    <div>
      <header className="appbar">
        <div className="wrap inner">
          <span className="userpill">
            {name ? <><span className="av">{name.split(/\s+/).slice(0, 2).map((p) => p[0]).join("")}</span>{name}</>
                  : <><span className="av sk" /><span className="sk sk-line" /></>}
          </span>
          <div className="row gap24">
            <a className="link" href={WA}>{a.help}</a>
            <Link to="/app"><Brand /></Link>
          </div>
        </div>
      </header>

      <div className="wrap page">
        <div style={{ textAlign: "start", marginBottom: 24 }}>
          <div className="eyebrow">{o.eyebrow}</div>
          <h1 style={{ marginTop: 10 }}>{name ? `${o.greetingHi} ${name}` : o.greeting}</h1>
        </div>

        {loading ? (
          <p className="muted">{a.loading}</p>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 24 }}>
              <Stepper steps={o.steps} currentIndex={STEP_INDEX[s]} />
            </div>
            <div className="grid-2">
              <div>{card(s, nav)}</div>
              <SupportCard />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// AIC-186 — the connect step, now with the one-click path first.
//
// Both routes stay: OAuth needs Meta App Review, and until that clears it works
// only for people holding a role on our app. The manual partner-share link
// below it is what every other customer still uses, so it is a visible
// alternative rather than a fallback nobody can find.
function ConnectCard({ nav }: { nav: ReturnType<typeof useNavigate> }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // The callback redirects back here with ?meta=…; a fresh page load is the
  // only channel it has, so the outcome is read from the URL.
  const outcome = new URLSearchParams(window.location.search).get("meta");
  const reason = new URLSearchParams(window.location.search).get("reason");
  const notice =
    outcome === "connected" ? o.oauthDone
    : outcome === "refused" ? o.oauthRefused
    : outcome === "failed" ? (reason === "link_expired" ? o.oauthExpired : o.oauthFailed)
    : null;

  async function go() {
    setBusy(true);
    setFailed(null);
    try {
      // Assign rather than push: leaving our SPA for Meta is a navigation, and
      // the customer coming Back should land on the step, not mid-redirect.
      window.location.assign(await startMetaOauth());
    } catch {
      // Never leave the button spinning on a failure the customer cannot see.
      setBusy(false);
      setFailed(o.oauthFailed);
    }
  }

  return (
    <div className="card">
      <h3 style={{ fontSize: "1.4rem" }}>{o.connectTitle}</h3>
      <p className="muted" style={{ margin: "12px 0 22px" }}>{o.oauthSub}</p>
      {notice && (
        <p className="muted" style={{ marginBottom: 16 }} role="status">{notice}</p>
      )}
      {failed && (
        <p className="muted" style={{ marginBottom: 16 }} role="alert">{failed}</p>
      )}
      <button className="btn btn-primary" onClick={go} disabled={busy}>
        {busy ? o.oauthStarting : o.oauthCta}
      </button>
      <p className="muted" style={{ marginTop: 16, fontSize: "0.9rem" }}>
        <button className="link" onClick={() => nav("/connect")}>{o.oauthManual}</button>
        {" · "}{o.connectHelp}
      </p>
    </div>
  );
}

function card(s: S, nav: ReturnType<typeof useNavigate>) {
  if (s === "A")
    return (
      <div className="card">
        <h3 style={{ fontSize: "1.4rem" }}>{o.callTitle}</h3>
        <p className="muted" style={{ margin: "12px 0 22px" }}>{o.callSub}</p>
        <div className="row gap12" style={{ flexWrap: "wrap" }}>
          <a className="btn btn-wa" href={WA}>{a.talkWa}</a>
        </div>
      </div>
    );
  if (s === "C") return <ConnectCard nav={nav} />;
  if (s === "D")
    return (
      <div className="card">
        <StatusPill variant="info">{o.reviewBadge}</StatusPill>
        <h3 style={{ fontSize: "1.4rem", margin: "14px 0 12px" }}>{o.reviewTitle}</h3>
        <p className="muted" style={{ marginBottom: 20 }}>{o.reviewSub}</p>
        <div className="summary-row"><span>✓ {o.metaConnected}</span></div>
        <div className="summary-row"><span>✓ {o.campaignFound}</span><StatusPill variant="neutral">{o.inReview}</StatusPill></div>
        <p className="muted" style={{ marginTop: 16 }}>{o.nothingToDo}</p>
      </div>
    );
  return (
    <div className="card">
      <StatusPill variant="ok">✓</StatusPill>
      <h3 style={{ fontSize: "1.4rem", margin: "14px 0 12px" }}>{o.readyTitle}</h3>
      <p className="muted" style={{ marginBottom: 20 }}>{o.readySub}</p>
      <button className="btn btn-primary" onClick={() => nav("/app")}>{o.goToAccount}</button>
    </div>
  );
}
