import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { LayoutGrid, Sparkles, LifeBuoy, Settings, LogOut } from "lucide-react";
import { strings } from "../strings";
import { getOverview, clearAuthToken } from "../api";

const a = strings.he.app;

// Right-side app sidebar (AIC-40): brand → nav sections → spacer → user card
// with an account menu (settings + logout). Mirrors Pisga's studentApp Sidebar,
// restyled in AdPilot's palette (ink sidebar, orange accent).
export function Sidebar() {
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [badge, setBadge] = useState(0);
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getOverview()
      .then((o) => { setName(o.account.name ?? ""); setEmail(o.account.email ?? ""); setBadge(o.pendingRecommendations); })
      .catch(() => {});
  }, []);

  // Close the account menu on outside-click / Escape.
  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [menu]);

  const logout = () => { clearAuthToken(); window.location.assign("/login"); };
  const initials = name.trim() ? name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("") : "";
  const cls = ({ isActive }: { isActive: boolean }) => "ap-nav-item" + (isActive ? " active" : "");

  return (
    <aside className="ap-side">
      <div className="ap-brand">AdPilot<span className="d">.</span></div>

      <div className="ap-nav-section">
        <div className="ap-nav-label">{a.nav.sectionManage}</div>
        <NavLink end to="/app" className={cls}>
          <span className="ic"><LayoutGrid size={18} /></span><span>{a.home.navHome}</span>
        </NavLink>
        <NavLink to="/app/recommendations" className={cls}>
          <span className="ic"><Sparkles size={18} /></span><span>{a.home.navRecs}</span>
          {badge > 0 && <span className="ap-nav-badge">{badge}</span>}
        </NavLink>
      </div>

      <div className="ap-nav-section">
        <div className="ap-nav-label">{a.nav.sectionHelp}</div>
        <NavLink to="/app/settings" className={cls}>
          <span className="ic"><LifeBuoy size={18} /></span><span>{a.home.navSettings}</span>
        </NavLink>
      </div>

      <div className="ap-spacer" />

      <div className="ap-user-wrap" ref={ref}>
        {menu && (
          <div className="ap-acct" role="menu">
            <button role="menuitem" onClick={() => { setMenu(false); nav("/app/settings"); }}>
              <Settings size={16} /><span>{a.settings.title}</span>
            </button>
            <div className="div" />
            <button className="danger" role="menuitem" onClick={logout}>
              <LogOut size={16} /><span>{a.logout}</span>
            </button>
          </div>
        )}
        <div className={`ap-user${menu ? " open" : ""}`}>
          <span className="av">{initials || "—"}</span>
          <span className="nm"><b>{name || a.loading}</b><small>{email}</small></span>
          <button className="ap-cog" aria-haspopup="menu" aria-expanded={menu} title={a.settings.title} onClick={() => setMenu((v) => !v)}>
            <Settings size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}
