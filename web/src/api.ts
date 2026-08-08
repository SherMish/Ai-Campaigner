// Every request goes through the /api prefix. In dev the Vite proxy forwards it
// to the API server; in single-origin prod the Express server owns both the
// static SPA and /api on one origin, so the prefix lines up end-to-end.
//
// Admin routes (/admin/*) require a bearer token (server requireAdmin). The ops
// console stores it in localStorage via the AdminGate; we attach it here.
const ADMIN_TOKEN_KEY = "aic_admin_token";
const AUTH_TOKEN_KEY = "aic_auth_token";

function ls(key: string): string {
  try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
}
function setLs(key: string, v: string): void {
  try { localStorage.setItem(key, v); } catch { /* ignore */ }
}
function delLs(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export const getAdminToken = () => ls(ADMIN_TOKEN_KEY);
export const setAdminToken = (t: string) => setLs(ADMIN_TOKEN_KEY, t);
export const clearAdminToken = () => delLs(ADMIN_TOKEN_KEY);

// Customer session (AIC-21). The JWT from /auth/login|signup.
export const getAuthToken = () => ls(AUTH_TOKEN_KEY);
export const setAuthToken = (t: string) => setLs(AUTH_TOKEN_KEY, t);
export const clearAuthToken = () => delLs(AUTH_TOKEN_KEY);

// Thrown so callers can show the server's message (e.g. "email already registered").
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  // /admin/* uses the ops-console token; everything else uses the customer JWT.
  const token = path.startsWith("/admin") ? getAdminToken() : getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, { ...init, headers });
  if (!res.ok) {
    let msg = `API ${path} failed: ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch { /* non-JSON */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}
