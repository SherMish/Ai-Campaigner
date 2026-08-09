import { useEffect, useState, type ReactNode } from "react";
import { getAuthToken, clearAuthToken, getMe } from "../api";

// Gate for the internal ops console. Admin is a per-user role (server checks
// app_users.is_admin): the operator signs in as a normal customer account, and
// only an admin account may open the console. No shared token to hand around.
type State = "checking" | "ok" | "denied" | "unauth";

export function AdminGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>("checking");

  useEffect(() => {
    if (!getAuthToken()) { setState("unauth"); return; }
    getMe()
      .then((u) => setState(u.isAdmin ? "ok" : "denied"))
      .catch(() => setState("unauth"));
  }, []);

  if (state === "ok") {
    return (
      <div>
        <div style={{ position: "fixed", insetInlineEnd: 16, top: 12, zIndex: 100 }}>
          <button
            className="btn btn-outline btn-sm"
            onClick={() => { clearAuthToken(); window.location.href = "/login"; }}
          >
            יציאה
          </button>
        </div>
        {children}
      </div>
    );
  }

  return (
    <main dir="rtl" style={{ minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ width: 340, maxWidth: "90vw", textAlign: "center" }}>
        <h1 style={{ fontSize: "1.4rem", fontWeight: 800, marginBottom: 8 }}>קונסולת תפעול</h1>
        {state === "checking" && <p className="muted">בודקים הרשאה…</p>}
        {state === "unauth" && (
          <>
            <p className="muted" style={{ marginBottom: 16 }}>צריך להתחבר עם חשבון מנהל.</p>
            <a className="btn btn-primary block" href="/login">כניסה</a>
          </>
        )}
        {state === "denied" && (
          <p className="muted">החשבון הזה אינו מורשה לקונסולת התפעול.</p>
        )}
      </div>
    </main>
  );
}
