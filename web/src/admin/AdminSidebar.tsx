import { NavLink } from "react-router-dom";
import { LayoutGrid, Users, Database, Sparkles, ShieldCheck, LogOut } from "lucide-react";
import { strings } from "../strings";
import { clearAuthToken } from "../api";

const n = strings.he.adminShell;

// Right-side nav for the internal admin console (AIC-43). Overview / Customers /
// Meta explorer (AIC-45) / Recommendations oversight (AIC-46) are live;
// Operators is the destination AIC-47 builds — shown as a disabled "coming
// soon" row until then, same pattern Pisga uses for unbuilt sections.
export function AdminSidebar() {
  const cls = ({ isActive }: { isActive: boolean }) => "ap-nav-item" + (isActive ? " active" : "");
  const logout = () => { clearAuthToken(); window.location.assign("/login"); };

  return (
    <aside className="ap-side">
      <div className="ap-brand">{n.brand}<span className="d">.</span></div>

      <div className="ap-nav-section">
        <div className="ap-nav-label">{n.brandSub}</div>
        <NavLink end to="/admin" className={cls}>
          <span className="ic"><LayoutGrid size={18} /></span><span>{n.navOverview}</span>
        </NavLink>
        <NavLink to="/admin/customers" className={cls}>
          <span className="ic"><Users size={18} /></span><span>{n.navCustomers}</span>
        </NavLink>
        <NavLink to="/admin/meta" className={cls}>
          <span className="ic"><Database size={18} /></span><span>{n.navMeta}</span>
        </NavLink>
        <NavLink to="/admin/recommendations" className={cls}>
          <span className="ic"><Sparkles size={18} /></span><span>{n.navRecs}</span>
        </NavLink>
        <div className="ap-nav-item disabled" aria-disabled="true">
          <span className="ic"><ShieldCheck size={18} /></span><span>{n.navOperators}</span>
          <span className="ap-nav-badge">{n.comingSoon}</span>
        </div>
      </div>

      <div className="ap-spacer" />

      <div className="ap-user-wrap">
        <button className="ap-user" style={{ width: "100%", border: "none", cursor: "pointer" }} onClick={logout}>
          <span className="ic" style={{ color: "rgba(247,242,234,0.7)" }}><LogOut size={16} /></span>
          <span className="nm"><b>{n.logout}</b></span>
        </button>
      </div>
    </aside>
  );
}
