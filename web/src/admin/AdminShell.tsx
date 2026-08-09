import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Menu } from "lucide-react";
import { strings } from "../strings";
import { AdminSidebar } from "./AdminSidebar";

// The internal admin app shell (AIC-43): the frame the ops-console-v2 sections
// (Overview / Customers / Meta explorer / Recommendations / Operators) hang off
// of. Reuses the customer app's shell CSS (.ap-*, AIC-40) for one consistent
// design system — right-side sidebar, off-canvas drawer on mobile.
export function AdminShell() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className={`ap-shell${open ? " open" : ""}`} dir="rtl">
      <AdminSidebar />
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
