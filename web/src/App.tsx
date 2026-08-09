import type { ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { getAuthToken } from "./api";
import { AdminDashboard } from "./admin/AdminDashboard";
import { AdminGate } from "./admin/AdminGate";
import { Signup, Login, Forgot, Reset } from "./app/Auth";
import { Checkout } from "./app/Checkout";
import { Onboarding } from "./app/Onboarding";
import { Connect } from "./app/Connect";
import { Review } from "./app/Review";
import { Home } from "./app/Home";
import { Recommendations, RecommendationDetail } from "./app/Recommendations";
import { Settings } from "./app/Settings";
import { AuthGate } from "./app/AuthGate";

// An already-signed-in visitor has no business on the entry screens (login /
// register / forgot) — send them to their dashboard (/app).
function RedirectIfAuthed({ children }: { children: ReactNode }) {
  return getAuthToken() ? <Navigate to="/app" replace /> : <>{children}</>;
}

// The React SPA. The marketing landing is the static landing/ page served at "/"
// (single-origin); everything below is the app + the internal admin dashboard.
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* auth (signed-in visitors bounce to the app) */}
        <Route path="/login" element={<RedirectIfAuthed><Login /></RedirectIfAuthed>} />
        <Route path="/signup" element={<RedirectIfAuthed><Signup /></RedirectIfAuthed>} />
        <Route path="/register" element={<RedirectIfAuthed><Signup /></RedirectIfAuthed>} />
        <Route path="/forgot" element={<RedirectIfAuthed><Forgot /></RedirectIfAuthed>} />
        <Route path="/reset" element={<RedirectIfAuthed><Reset /></RedirectIfAuthed>} />
        <Route path="/checkout" element={<AuthGate><Checkout /></AuthGate>} />

        {/* onboarding + setup (signed-in). Onboarding self-redirects to /app once ready. */}
        <Route path="/onboarding" element={<AuthGate><Onboarding /></AuthGate>} />
        <Route path="/connect" element={<AuthGate><Connect /></AuthGate>} />
        <Route path="/review" element={<AuthGate><Review /></AuthGate>} />

        {/* the app (signed-in) */}
        <Route path="/app" element={<AuthGate><Home /></AuthGate>} />
        <Route path="/app/recommendations" element={<AuthGate><Recommendations /></AuthGate>} />
        <Route path="/app/recommendations/:id" element={<AuthGate><RecommendationDetail /></AuthGate>} />
        <Route path="/app/settings" element={<AuthGate><Settings /></AuthGate>} />

        {/* the single internal admin dashboard (per-user admin role) */}
        <Route path="/admin" element={<AdminGate><AdminDashboard /></AdminGate>} />
        {/* back-compat: the old split routes now fold into /admin */}
        <Route path="/admin/ops" element={<Navigate to="/admin" replace />} />
        <Route path="/admin/readout" element={<Navigate to="/admin" replace />} />

        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
