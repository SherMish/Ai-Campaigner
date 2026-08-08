import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AdminReadout } from "./admin/Readout";
import { OpsConsole } from "./admin/OpsConsole";
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

// The React SPA. The marketing landing is the static landing/ page served at "/"
// (single-origin); everything below is the app + internal admin. Screens are
// frontend-only on mock data — backend wiring lands per Linear ticket (AIC-21…24).
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* auth */}
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot" element={<Forgot />} />
        <Route path="/reset" element={<Reset />} />
        <Route path="/checkout" element={<AuthGate><Checkout /></AuthGate>} />

        {/* onboarding + setup (signed-in) */}
        <Route path="/onboarding" element={<AuthGate><Onboarding /></AuthGate>} />
        <Route path="/connect" element={<AuthGate><Connect /></AuthGate>} />
        <Route path="/review" element={<AuthGate><Review /></AuthGate>} />

        {/* the app (signed-in) */}
        <Route path="/app" element={<AuthGate><Home /></AuthGate>} />
        <Route path="/app/recommendations" element={<AuthGate><Recommendations /></AuthGate>} />
        <Route path="/app/recommendations/:id" element={<AuthGate><RecommendationDetail /></AuthGate>} />
        <Route path="/app/settings" element={<AuthGate><Settings /></AuthGate>} />

        {/* internal admin (token-gated) */}
        <Route path="/admin/readout" element={<AdminGate><AdminReadout /></AdminGate>} />
        <Route path="/admin/ops" element={<AdminGate><OpsConsole /></AdminGate>} />

        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
