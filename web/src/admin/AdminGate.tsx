import { useState, type ReactNode } from "react";
import { getAdminToken, setAdminToken, clearAdminToken } from "../api";

// Minimal auth gate for the internal admin console. Requires an admin token
// (matched server-side by requireAdmin against ADMIN_TOKEN). Stored in
// localStorage and attached as a bearer on every /admin request. This is the
// operator-console gate, not customer auth.
export function AdminGate({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState(() => !!getAdminToken());
  const [value, setValue] = useState("");

  if (ok) {
    return (
      <div>
        <div style={{ position: "fixed", insetInlineEnd: 16, top: 12, zIndex: 100 }}>
          <button
            className="btn btn-outline btn-sm"
            onClick={() => { clearAdminToken(); setOk(false); }}
          >
            נעילת הקונסולה
          </button>
        </div>
        {children}
      </div>
    );
  }

  return (
    <main dir="rtl" style={{ minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: "system-ui, sans-serif" }}>
      <form
        onSubmit={(e) => { e.preventDefault(); if (value.trim()) { setAdminToken(value.trim()); setOk(true); } }}
        style={{ width: 340, maxWidth: "90vw" }}
      >
        <h1 style={{ fontSize: "1.4rem", fontWeight: 800, marginBottom: 8 }}>קונסולת תפעול</h1>
        <p className="muted" style={{ marginBottom: 18 }}>הזינו את מפתח הגישה (ADMIN_TOKEN).</p>
        <div className="field">
          <label>מפתח גישה</label>
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        </div>
        <button className="btn btn-primary block" type="submit" style={{ marginTop: 16 }}>כניסה</button>
      </form>
    </main>
  );
}
