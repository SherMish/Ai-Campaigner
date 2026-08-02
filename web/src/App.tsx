import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import { strings } from "./strings";
import { AdminReadout } from "./admin/Readout";

// SPA shell. Real customer surfaces (onboarding, connect Meta, home dashboard,
// recommendation, settings) land in AIC-21 onward. The internal admin dogfood
// readout (AIC-7) lives at /admin/readout.
export function App() {
  const t = strings.he;
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/admin/readout" element={<AdminReadout />} />
        <Route
          path="*"
          element={
            <main
              dir="rtl"
              style={{ fontFamily: "system-ui, sans-serif", padding: 24, lineHeight: 1.6 }}
            >
              <h1>{t.appName}</h1>
              <p>{t.tagline}</p>
              <p>
                <Link to="/admin/readout">← {t.admin.readoutTitle}</Link>
              </p>
            </main>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
