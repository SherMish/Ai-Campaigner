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
        <Route path="/checkout" element={<Checkout />} />

        {/* onboarding + setup */}
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/connect" element={<Connect />} />
        <Route path="/review" element={<Review />} />

        {/* the app */}
        <Route path="/app" element={<Home />} />
        <Route path="/app/recommendations" element={<Recommendations />} />
        <Route path="/app/recommendations/:id" element={<RecommendationDetail />} />
        <Route path="/app/settings" element={<Settings />} />

        {/* internal admin (token-gated) */}
        <Route path="/admin/readout" element={<AdminGate><AdminReadout /></AdminGate>} />
        <Route path="/admin/ops" element={<AdminGate><OpsConsole /></AdminGate>} />

        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
