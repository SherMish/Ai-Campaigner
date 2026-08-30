import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Menu } from "lucide-react";
import { strings } from "../strings";
import { getConfig } from "../api";
import { identifyCustomer, initAnalytics, initClickTracking, trackPage } from "../analytics";
import { useSharedOverview } from "./overview-store";
import { Sidebar } from "./Sidebar";

// AIC-28: the route PATTERN, never the resolved path — `/app/recommendations/
// 9f3c…` would put a customer-owned object id into an event property.
function routePattern(pathname: string): string {
  return pathname.replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "/:id");
}

// The signed-in app shell (AIC-40): a right-side sidebar + the routed screen in
// the main column. On mobile the sidebar becomes an off-canvas drawer opened by
// the floating menu button. Used as a React Router layout route (renders
// <Outlet/>), so every /app* screen shares one chrome.
export function AppShell() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]); // close the drawer on navigation

  // AIC-28. Boot analytics once from the server-served token (null in any
  // environment where MIXPANEL_TOKEN is unset, which makes every call a
  // no-op), then tie the session to the CUSTOMER — the same distinct_id the
  // server uses, so browser and server events land on one profile instead of
  // two halves of a funnel that never join.
  const { data: overview } = useSharedOverview();
  useEffect(() => {
    getConfig().then((c) => initAnalytics(c.mixpanelToken)).catch(() => {});
  }, []);
  useEffect(() => {
    identifyCustomer(overview?.customer?.id ?? null);
  }, [overview?.customer?.id]);
  useEffect(() => {
    trackPage(routePattern(pathname));
  }, [pathname]);
  // A ref, not the value: the listener is attached once, and a stale closure
  // would label every click with the route the app booted on.
  const routeRef = useRef(pathname);
  routeRef.current = pathname;
  useEffect(() => {
    initClickTracking(() => routePattern(routeRef.current));
  }, []);

  // Escape closes the mobile drawer (AIC-42 a11y pass).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

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
