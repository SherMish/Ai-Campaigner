import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { strings } from "../strings";
import { clearAuthToken, getMe } from "../api";

// Cached once per session so navigating between app screens doesn't refetch the
// signed-in name. The header uses it when a screen doesn't pass userName.
let cachedName: string | null = null;

const a = strings.he.app;
/*
 * The one WhatsApp contact for the whole signed-in app — 13 links across
 * onboarding, connect, checkout, recommendations, settings, review,
 * add-content and auth all read this.
 *
 * It was `972500000000` behind a TODO: a fictional number, shipped, on every
 * "talk to us" link a customer could press. The support channel this product
 * leans on (manual onboarding, human help when the engine defers) was dead the
 * whole time, and silently — a wa.me link to an unused number opens WhatsApp
 * and simply goes nowhere.
 *
 * Must stay identical to the landing page's number (landing/index.html, six
 * occurrences). The landing page is static HTML and cannot import this, so the
 * duplication is unavoidable; changing one without the other splits the
 * company's contact number in half.
 */
export const WA_NUMBER = "972526964069";
export const WA = `https://wa.me/${WA_NUMBER}`;

export function Brand({ className = "brand" }: { className?: string }) {
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <img src="/favicon.png" alt="" className="brand-icon" />
      {strings.he.appName}
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

// The builder's "מומלץ" (recommended) badge — only ever on a step with a
// real, editable control (AIC-52's honesty pass); a fixed step shows no
// badge at all. Shared between Builder.tsx and AudienceFields.tsx.
export function Recommended() {
  return <StatusPill variant="ok">✓ {strings.he.builder.recommended}</StatusPill>;
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

  // When the screen doesn't pass a name, fetch it once (cached) so the real name
  // shows everywhere — a loader, never the mock, until it resolves.
  const [fetched, setFetched] = useState<string | null>(cachedName);
  useEffect(() => {
    if (userName?.trim() || cachedName !== null) return;
    getMe().then((u) => { cachedName = u.name ?? ""; setFetched(cachedName); }).catch(() => {});
  }, [userName]);

  const name = (userName?.trim() || fetched?.trim()) ?? "";
  const ready = name.length > 0;
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
            {ready ? (
              <>
                <span className="av">{initialsOf(name)}</span>
                {name}
              </>
            ) : (
              <>
                <span className="av sk" />
                <span className="sk sk-line" />
              </>
            )}
          </span>
          <button className="btn btn-outline btn-sm" onClick={logout}>{a.logout}</button>
        </div>
      </div>
    </header>
  );
}

// Auth split layout: form on one side, dark reassurance panel on the other.
// AIC-125: a single centered column. This used to be a 1fr/1fr grid with a dark
// marketing aside — "what happens after signup" plus a mock dashboard reading
// 18 leads / ₪41 CPL / ₪734 spend. Those were invented numbers rendered in the
// product's own dashboard styling, on the page where someone decides whether to
// trust the product's numbers; the rest of this session was spent making real
// figures say what they mean, and this was the one screen asserting figures
// that never existed.
//
// The aside was ALREADY hidden below the mobile breakpoint, so the centered
// single column was a shipped, known-good layout — this makes it the only one.
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <div className="form-box">
        <Brand />
        {children}
      </div>
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
// On a narrow viewport (see ui.css) this scrolls horizontally instead of
// clipping later steps — auto-scrolling the current node into view is what
// makes that discoverable rather than just technically possible.
export function Stepper({ steps, currentIndex }: { steps: readonly string[]; currentIndex: number }) {
  const nowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    nowRef.current?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [currentIndex]);

  return (
    <div className="stepper">
      {steps.map((name, i) => {
        const state = i < currentIndex ? "done" : i === currentIndex ? "now" : "todo";
        const sub = state === "done" ? a.onboarding.done : state === "now" ? a.onboarding.now : a.onboarding.later;
        return (
          <Fragment key={i}>
            {i > 0 && <div className="bar" />}
            <div className={`node ${state}`} ref={state === "now" ? nowRef : undefined}>
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
