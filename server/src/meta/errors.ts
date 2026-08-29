import type { AccessHealth } from "@aic/shared";

// Shape of a Graph API error body: { error: { code, error_subcode, message, ... } }
export interface GraphErrorBody {
  error?: {
    code?: number;
    error_subcode?: number;
    message?: string;
    type?: string;
  };
}

// Classify a Graph API failure into an access-health value.
//
//  - code 190 → the token itself is dead/expired/revoked → `invalid`
//    (our fix is to rotate the System User token; see docs/META_SETUP.md).
//  - permission errors (100/200/10/3/298) → the asset grant was removed or
//    downgraded → `revoked` (the customer must re-grant partner access).
//  - 5xx, or a rate-limit code → `unknown`: Meta being broken or throttling us
//    is not a statement about our grant (AIC-150). Nothing is written and no
//    alarm fires; we re-ask next tick.
//  - any other 4xx → `needs_reconnect`: an unclassified access failure that
//    Meta DID answer, so it is a real (if vague) verdict.
//
// The single mapping so on-read and scheduled health checks agree.
export function classifyGraphError(
  status: number,
  body: GraphErrorBody | undefined,
): { health: Exclude<AccessHealth, "ok"> | "unknown"; detail: string } {
  const code = body?.error?.code;
  const subcode = body?.error?.error_subcode;
  const message = body?.error?.message ?? `HTTP ${status}`;

  if (code === 190) {
    return {
      health: "invalid",
      detail: `token invalid/expired (code 190, subcode ${subcode ?? "n/a"}): ${message}`,
    };
  }

  // Throttling. Says we asked too often — nothing whatsoever about access.
  // Classifying this as a lost connection was a live false-alarm source.
  const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
  if (status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) {
    return { health: "unknown", detail: `rate limited (status ${status}, code ${code ?? "n/a"}): ${message}` };
  }

  // Meta's own failure. Our grant is not in question.
  if (status >= 500) {
    return { health: "unknown", detail: `Meta server error (status ${status}): ${message}` };
  }

  const PERMISSION_CODES = new Set([100, 200, 10, 3, 298, 294]);
  if (code !== undefined && PERMISSION_CODES.has(code)) {
    return {
      health: "revoked",
      detail: `asset permission removed/downgraded (code ${code}): ${message}`,
    };
  }

  return {
    health: "needs_reconnect",
    detail: `unclassified access failure (status ${status}, code ${code ?? "n/a"}): ${message}`,
  };
}
