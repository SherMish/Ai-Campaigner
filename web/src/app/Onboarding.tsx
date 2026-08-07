import { useSearchParams, Link, useNavigate } from "react-router-dom";
import { strings } from "../strings";
import { Brand, Stepper, SupportCard, StatusPill, WA } from "./components";

const a = strings.he.app;
const o = a.onboarding;

// The 6 onboarding states from the design (A call → F ready). Frontend-only:
// select via ?s=A..F; a small switcher previews each.
type S = "A" | "B" | "C" | "D" | "E" | "F";
const STEP_INDEX: Record<S, number> = { A: 1, B: 1, C: 2, D: 3, E: 3, F: 4 };

export function Onboarding() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const s = (params.get("s") as S) || "D";

  return (
    <div>
      <header className="appbar">
        <div className="wrap inner">
          <span className="userpill"><span className="av">{a.mock.userInitials}</span>{a.mock.userName}</span>
          <div className="row gap24">
            <a className="link" href={WA}>{a.help}</a>
            <Link to="/app"><Brand /></Link>
          </div>
        </div>
      </header>

      <div className="wrap page">
        <div style={{ textAlign: "start", marginBottom: 24 }}>
          <div className="eyebrow">{o.eyebrow}</div>
          <h1 style={{ marginTop: 10 }}>{o.greeting}</h1>
        </div>

        <div className="card" style={{ marginBottom: 24 }}>
          <Stepper steps={o.steps} currentIndex={STEP_INDEX[s]} />
        </div>

        <div className="grid-2">
          <div>{card(s, nav)}</div>
          <SupportCard />
        </div>

        {/* dev-only state preview switcher */}
        <div className="row gap8" style={{ marginTop: 30, flexWrap: "wrap" }}>
          {(["A", "B", "C", "D", "E", "F"] as S[]).map((k) => (
            <button key={k} className={`btn btn-sm ${k === s ? "btn-dark" : "btn-outline"}`}
              onClick={() => setParams({ s: k })}>{k}</button>
          ))}
        </div>
      </div>
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
          <button className="btn btn-primary" onClick={() => nav("/onboarding?s=B")}>{o.bookCall}</button>
          <a className="btn btn-wa" href={WA}>{a.talkWa}</a>
        </div>
      </div>
    );
  if (s === "B")
    return (
      <div className="card">
        <StatusPill variant="info">{o.bookedBadge}</StatusPill>
        <h3 style={{ fontSize: "1.4rem", margin: "14px 0 18px" }}>{o.bookedTitle}</h3>
        <div className="summary-row"><span className="k">{o.date}</span><b>יום שלישי, 11.8</b></div>
        <div className="summary-row"><span className="k">{o.time}</span><b>10:30</b></div>
        <div className="summary-row"><span className="k">{o.length}</span><b>30 דקות</b></div>
        <div className="summary-row"><span className="k">{o.how}</span><b>שיחת וידאו</b></div>
        <p className="muted" style={{ margin: "16px 0" }}>{o.bookedNote}</p>
        <button className="btn btn-outline btn-sm">{o.reschedule}</button>
      </div>
    );
  if (s === "C")
    return (
      <div className="card">
        <h3 style={{ fontSize: "1.4rem" }}>{o.connectTitle}</h3>
        <p className="muted" style={{ margin: "12px 0 22px" }}>{o.connectSub}</p>
        <button className="btn btn-primary" onClick={() => nav("/connect")}>{o.connectCta}</button>
        <p className="muted" style={{ marginTop: 16, fontSize: "0.9rem" }}>{o.connectHelp}</p>
      </div>
    );
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
  if (s === "E")
    return (
      <div className="card">
        <StatusPill variant="warn">{o.approveBadge}</StatusPill>
        <h3 style={{ fontSize: "1.4rem", margin: "14px 0 12px" }}>{o.approveTitle}</h3>
        <p className="muted" style={{ marginBottom: 20 }}>{o.approveSub}</p>
        <div className="row gap12" style={{ flexWrap: "wrap" }}>
          <button className="btn btn-primary" onClick={() => nav("/review")}>{o.viewChange}</button>
          <a className="btn btn-outline" href={WA}>{o.wantToTalk}</a>
        </div>
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
