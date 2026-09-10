import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { strings } from "../strings";
import { getOverview, startMetaOauth, saveBusinessDetails, ApiError, type CustomerOverview } from "../api";
import { Brand, Stepper, SupportCard, StatusPill, WA } from "./components";
import { onboardingStep, STEP_INDEX, type OnboardingStep } from "./onboarding-step";

const a = strings.he.app;
const o = a.onboarding;

// Which card to show lives in onboarding-step.ts — a pure module, because the
// interesting case (a just-registered user with no customer row) was wrong here
// and no test could reach it inside a component.
type S = OnboardingStep;

export function Onboarding() {
  const nav = useNavigate();
  const [ov, setOv] = useState<CustomerOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const [tick, setTick] = useState(0);

  useEffect(() => {
    getOverview()
      .then((data) => {
        // Finished onboarding? Nothing to do here. The same rule the app shell
        // applies from the other side (see AuthGate), from one function.
        if (onboardingStep({ customer: data.customer, connection: data.connection }) === "F") {
          nav("/app", { replace: true });
          return;
        }
        setOv(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [nav, tick]);

  const s: S = onboardingStep({ customer: ov?.customer, connection: ov?.connection });
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
              <div>{card(s, () => setTick((n) => n + 1))}</div>
              <SupportCard />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// AIC-188 — step 2. This is the step that CREATES the customer row.
//
// It exists because the first real OAuth run produced a customer named
// "2181076988590009" — the ad account's own name. That value feeds ad copy
// generation, so asking here is not a formality: it is the difference between a
// campaign written for a business and one written for a number.
function BusinessCard({ done }: { done: () => void }) {
  const [businessName, setName] = useState("");
  const [websiteUrl, setSite] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await saveBusinessDetails({ businessName, websiteUrl });
      done();
    } catch (ex) {
      // The server names WHICH field is wrong; showing "failed" instead would
      // leave the person guessing between two inputs.
      const reason = ex instanceof ApiError
        ? (ex.body as { reason?: string } | undefined)?.reason
        : undefined;
      setErr((reason && o.bizErr[reason as keyof typeof o.bizErr]) || o.bizErr.failed);
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h3 style={{ fontSize: "1.4rem" }}>{o.bizTitle}</h3>
      <p className="muted" style={{ margin: "12px 0 22px" }}>{o.bizSub}</p>
      <form onSubmit={submit}>
        {/* `.field` styles a <label> child, not an arbitrary span — matching the
            shape every other form in the app uses (see Settings.tsx). */}
        <div className="field">
          <label htmlFor="biz-name">{o.bizNameLabel}</label>
          <input
            id="biz-name" value={businessName} onChange={(e) => setName(e.target.value)}
            placeholder={o.bizNamePlaceholder} autoFocus maxLength={80} required
          />
        </div>
        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor="biz-site">
            {o.bizSiteLabel} <span className="muted">· {o.bizSiteOptional}</span>
          </label>
          <input
            id="biz-site" value={websiteUrl} onChange={(e) => setSite(e.target.value)}
            placeholder={o.bizSitePlaceholder} inputMode="url" maxLength={300}
          />
        </div>
        {err && <p className="muted" style={{ marginTop: 14 }} role="alert">{err}</p>}
        <button className="btn btn-primary" style={{ marginTop: 22 }} disabled={busy} type="submit">
          {busy ? o.bizSaving : o.bizSave}
        </button>
      </form>
    </div>
  );
}

// AIC-186 — the connect step, now with the one-click path first.
//
// Both routes stay: OAuth needs Meta App Review, and until that clears it works
// only for people holding a role on our app. The manual partner-share link
// below it is what every other customer still uses, so it is a visible
// alternative rather than a fallback nobody can find.
function ConnectCard() {
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
        {/* A Link, not a button: `.link` styles anchors, so a <button className="link">
            renders with the browser's default 2px outset chrome — a grey box in the
            middle of a sentence. Caught in browser testing. */}
        <Link className="link" to="/connect">{o.oauthManual}</Link>
        {" · "}{o.connectHelp}
      </p>
    </div>
  );
}

function card(s: S, done: () => void) {
  if (s === "B") return <BusinessCard done={done} />;
  return <ConnectCard />;
}
