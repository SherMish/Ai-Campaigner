import { Fragment, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { strings } from "../strings";
import { clearAuthToken } from "../api";

const a = strings.he.app;
const WA = "https://wa.me/972500000000"; // TODO: real WhatsApp number

export function Brand({ className = "brand" }: { className?: string }) {
  return (
    <span className={className}>
      AdPilot<span className="d">.</span>
    </span>
  );
}

export function Field({
  label,
  type = "text",
  value,
  onChange,
  placeholder,
}: {
  label: string;
  type?: string;
  value?: string;
  onChange?: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange?.(e.target.value)}
      />
    </div>
  );
}

export function StatusPill({
  variant,
  children,
}: {
  variant: "ok" | "warn" | "attn" | "info" | "neutral";
  children: ReactNode;
}) {
  return (
    <span className={`pill ${variant}`}>
      <span className="dot" />
      {children}
    </span>
  );
}

// Logged-in app header.
// Initials from a full name (first letters of the first two words).
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((p) => p[0]).join("") || a.mock.userInitials;
}

export function AppHeader({ recCount = 0, userName }: { recCount?: number; userName?: string }) {
  const { pathname } = useLocation();
  const nav = useNavigate();
  const active = (p: string) => (pathname === p || pathname.startsWith(p + "/") ? "active" : "");
  const logout = () => { clearAuthToken(); nav("/login"); };
  const name = userName?.trim() || a.mock.userName;
  const initials = userName?.trim() ? initialsOf(userName) : a.mock.userInitials;
  return (
    <header className="appbar">
      <div className="wrap inner">
        <div className="row gap24">
          <Link to="/app"><Brand /></Link>
          <nav className="appnav">
            <Link className={active("/app")} to="/app">{a.home.navHome}</Link>
            <Link className={active("/app/recommendations")} to="/app/recommendations">
              {a.home.navRecs}
              {recCount > 0 && <span className="navbadge">{recCount}</span>}
            </Link>
            <Link className={active("/app/settings")} to="/app/settings">{a.home.navSettings}</Link>
          </nav>
        </div>
        <div className="row gap16">
          <a className="link" href={WA}>{a.talk}</a>
          <span className="userpill">
            <span className="av">{initials}</span>
            {name}
          </span>
          <button className="btn btn-outline btn-sm" onClick={logout}>{a.logout}</button>
        </div>
      </div>
    </header>
  );
}

// Auth split layout: form on one side, dark reassurance panel on the other.
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <div className="form-side">
        <div className="form-box">
          <Brand />
          {children}
        </div>
      </div>
      <aside className="aside">
        <div className="eyebrow" style={{ color: "var(--orange)" }}>{a.auth.afterSignup}</div>
        <div className="stack gap16">
          {a.auth.steps.map((s, i) => (
            <div className="step-line" key={i}>
              <span className="num">{String(i + 1).padStart(2, "0")}</span>
              <span style={{ fontWeight: 600 }}>{s}</span>
            </div>
          ))}
        </div>
        <div className="mini-dash">
          <div className="row between" style={{ marginBottom: 10 }}>
            <b>{strings.he.app.home.summaryTitle}</b>
            <StatusPill variant="ok">{a.home.states.ok.badge}</StatusPill>
          </div>
          <div className="row-k"><span className="muted">{a.home.kpiLeads}</span><b>18</b></div>
          <div className="row-k"><span className="muted">{a.home.kpiCpl}</span><b>₪41</b></div>
          <div className="row-k"><span className="muted">{a.home.kpiSpend}</span><b>₪734</b></div>
        </div>
        <p style={{ color: "rgba(247,242,234,0.7)", fontSize: "0.9rem" }}>{a.auth.previewNote}</p>
      </aside>
    </div>
  );
}

// Reusable "need help" support card.
export function SupportCard({ dark = false }: { dark?: boolean }) {
  return (
    <div className={`card ${dark ? "card-dark" : ""}`}>
      <h3 style={{ fontSize: "1.2rem" }}>{a.settings.supportTitle}</h3>
      <p className="muted" style={{ margin: "8px 0 18px", color: dark ? "rgba(247,242,234,0.7)" : undefined }}>
        {a.settings.support}
      </p>
      <div className="row gap12" style={{ flexWrap: "wrap" }}>
        <a className="btn btn-wa" href={WA}>{a.talkWa}</a>
        <a className="btn btn-outline" href={WA}>{a.settings.bookCall}</a>
      </div>
    </div>
  );
}

// Onboarding progress stepper. steps in display order; currentIndex is the "now".
export function Stepper({ steps, currentIndex }: { steps: readonly string[]; currentIndex: number }) {
  return (
    <div className="stepper">
      {steps.map((name, i) => {
        const state = i < currentIndex ? "done" : i === currentIndex ? "now" : "todo";
        const sub = state === "done" ? a.onboarding.done : state === "now" ? a.onboarding.now : a.onboarding.later;
        return (
          <Fragment key={i}>
            {i > 0 && <div className="bar" />}
            <div className={`node ${state}`}>
              <div className="circle">{state === "done" ? "✓" : i + 1}</div>
              <div className="name">{name}</div>
              <div className="sub">{sub}</div>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

export { WA };
