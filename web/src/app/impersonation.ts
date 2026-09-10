// AIC-189 — is the session on screen an admin viewing a customer?
//
// Read from the token the browser is actually sending, not from a flag passed
// down through props: the bar must appear for anyone holding an impersonation
// token, on any screen, including one added later that forgot about this.
//
// The JWT payload is base64url and readable by design — a JWT is signed, not
// encrypted. Reading it here is for DISPLAY only. Every guarantee that matters
// (no writes, no admin API) is enforced server-side against the signature; if
// this parser were wrong in either direction, nothing would become permitted.
export interface Impersonation {
  userId: string;
  adminId: string;
}

export function readImpersonation(token: string | null | undefined): Impersonation | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      decodeURIComponent(
        atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
          .split("")
          .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
          .join(""),
      ),
    ) as { sub?: unknown; imp?: unknown; exp?: unknown };

    if (typeof payload.sub !== "string" || typeof payload.imp !== "string" || !payload.imp) return null;
    // An expired token is not a session. Showing the bar for one would be a
    // warning about something that is not happening.
    if (typeof payload.exp === "number" && payload.exp * 1000 <= Date.now()) return null;
    return { userId: payload.sub, adminId: payload.imp };
  } catch {
    // Unreadable is not impersonated. The server decides what the token can do;
    // the worst outcome here is a missing warning on a session that cannot
    // write anyway — never a granted permission.
    return null;
  }
}
