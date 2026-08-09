import type { ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { getAuthToken } from "./api";
import { AdminShell } from "./admin/AdminShell";
import { AdminOverview } from "./admin/AdminOverview";
import { AdminCustomers } from "./admin/AdminCustomers";
import { AdminGate } from "./admin/AdminGate";
import { AppShell } from "./app/AppShell";
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

        {/* the app (signed-in) — one shell (right-side sidebar) wraps every screen */}
        <Route element={<AuthGate><AppShell /></AuthGate>}>
          <Route path="/app" element={<Home />} />
          <Route path="/app/recommendations" element={<Recommendations />} />
          <Route path="/app/recommendations/:id" element={<RecommendationDetail />} />
          <Route path="/app/settings" element={<Settings />} />
        </Route>

        {/* the internal admin console (per-user admin role, AIC-43 nav shell) */}
        <Route element={<AdminGate><AdminShell /></AdminGate>}>
          <Route path="/admin" element={<AdminOverview />} />
          <Route path="/admin/customers" element={<AdminCustomers />} />
        </Route>
        {/* back-compat: the old single-page dashboard routes fold into /admin/customers */}
        <Route path="/admin/ops" element={<Navigate to="/admin/customers" replace />} />
        <Route path="/admin/readout" element={<Navigate to="/admin/customers" replace />} />

        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
