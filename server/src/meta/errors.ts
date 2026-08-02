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
//  - anything else (5xx, network, unknown) → `needs_reconnect`: treat as an
//    unclassified loss, surface the reconnect CTA, and re-check next tick.
//
// The single mapping so on-read and scheduled health checks agree.
export function classifyGraphError(
  status: number,
  body: GraphErrorBody | undefined,
): { health: Exclude<AccessHealth, "ok">; detail: string } {
  const code = body?.error?.code;
  const subcode = body?.error?.error_subcode;
  const message = body?.error?.message ?? `HTTP ${status}`;

  if (code === 190) {
    return {
      health: "invalid",
      detail: `token invalid/expired (code 190, subcode ${subcode ?? "n/a"}): ${message}`,
    };
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
