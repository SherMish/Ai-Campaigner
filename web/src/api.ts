// Every request goes through the /api prefix. In dev the Vite proxy forwards it
// to the API server; in single-origin prod the Express server owns both the
// static SPA and /api on one origin, so the prefix lines up end-to-end.
//
// Admin routes (/admin/*) require a bearer token (server requireAdmin). The ops
// console stores it in localStorage via the AdminGate; we attach it here.
const ADMIN_TOKEN_KEY = "aic_admin_token";

export function getAdminToken(): string {
  try {
    return localStorage.getItem(ADMIN_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setAdminToken(token: string): void {
  try {
    localStorage.setItem(ADMIN_TOKEN_KEY, token);
  } catch {
    /* ignore */
  }
}

export function clearAdminToken(): void {
  try {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (path.startsWith("/admin")) {
    const token = getAdminToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (!res.ok) {
    throw new Error(`API ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}
