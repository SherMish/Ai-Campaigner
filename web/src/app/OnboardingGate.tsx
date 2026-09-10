import { useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { getOverview } from "../api";
import { dashboardIsOpen } from "./onboarding-step";
import { strings } from "../strings";

// AIC-188 — an unfinished account cannot sit in the dashboard.
//
// A customer who has not given their business details, or not connected Meta,
// has no campaigns, no spend and no ads. The dashboard renders that as a page
// of empty state, which reads as "your account is broken" rather than "you have
// one thing left to do" — and gives them nowhere to go.
//
// The rule comes from `dashboardIsOpen`, the same function that decides which
// onboarding step to show. Two implementations of it would drift, and the drift
// is a customer bounced between two screens forever.
export function OnboardingGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "open" | "closed">("checking");

  useEffect(() => {
    let live = true;
    getOverview()
      .then((data) => {
        if (live) setState(dashboardIsOpen({ customer: data.customer, connection: data.connection }) ? "open" : "closed");
      })
      // A failed read is not evidence of an unfinished account. Bouncing someone
      // to onboarding because one request timed out would take a working
      // customer's dashboard away over a blip — the same "I could not ask is not
      // the answer is no" rule the connection health check learned the hard way.
      .catch(() => { if (live) setState("open"); });
    return () => { live = false; };
  }, []);

  if (state === "checking") return <p className="muted" style={{ padding: 24 }}>{strings.he.app.loading}</p>;
  if (state === "closed") return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}
