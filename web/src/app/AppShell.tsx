import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Menu } from "lucide-react";
import { strings } from "../strings";
import { Sidebar } from "./Sidebar";

// The signed-in app shell (AIC-40): a right-side sidebar + the routed screen in
// the main column. On mobile the sidebar becomes an off-canvas drawer opened by
// the floating menu button. Used as a React Router layout route (renders
// <Outlet/>), so every /app* screen shares one chrome.
export function AppShell() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]); // close the drawer on navigation

  return (
    <div className={`ap-shell${open ? " open" : ""}`} dir="rtl">
      <Sidebar />
      <div className="ap-overlay" onClick={() => setOpen(false)} aria-hidden="true" />
      <div className="ap-main">
        <button type="button" className="ap-fab" aria-label={strings.he.app.nav.menu} onClick={() => setOpen(true)}>
          <Menu size={20} />
        </button>
        <div className="ap-content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
