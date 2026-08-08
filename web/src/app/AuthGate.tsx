import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { getAuthToken } from "../api";

// Gates the signed-in customer screens. No JWT → bounce to login. (The token is
// verified server-side on every /api call; this is just the client-side guard.)
export function AuthGate({ children }: { children: ReactNode }) {
  return getAuthToken() ? <>{children}</> : <Navigate to="/login" replace />;
}
