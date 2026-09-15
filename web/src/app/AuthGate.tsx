import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { customerToken, impersonationExpired, clearImpersonationToken } from "../api";

// Gates the signed-in customer screens. No JWT → bounce to login. (The token is
// verified server-side on every /api call; this is just the client-side guard.)
export function AuthGate({ children }: { children: ReactNode }) {
  // AIC-189 — a viewing session that has expired ends here, visibly. Falling
  // back to the admin's own session would render the ADMIN's dashboard in the
  // tab that was showing a customer's, with no red bar — exactly the confusion
  // the bar exists to prevent.
  if (impersonationExpired()) {
    clearImpersonationToken();
    return <Navigate to="/admin/users" replace />;
  }
  return customerToken() ? <>{children}</> : <Navigate to="/login" replace />;
}
