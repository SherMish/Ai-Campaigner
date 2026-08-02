import { strings } from "./strings";

// SPA shell. Real customer surfaces (onboarding status, connect Meta, home
// dashboard, recommendation, settings) land in AIC-21 onward.
export function App() {
  const t = strings.he;
  return (
    <main
      dir="rtl"
      style={{ fontFamily: "system-ui, sans-serif", padding: 24, lineHeight: 1.6 }}
    >
      <h1>{t.appName}</h1>
      <p>{t.tagline}</p>
    </main>
  );
}
