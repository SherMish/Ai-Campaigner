// AIC-174 — reading the server's Meta-refusal body, in one tested place.
//
// The server answers a refused Meta write with 400 and
// `{ code: "meta_refused", reason, error }` (server/src/meta/graph-refusal.ts).
// `reason` is set only for refusals we have Hebrew copy for; `error` is always
// Meta's own sentence.
//
// Pure and separate from the component for the reason builder-gates.ts is:
// web tests run in `environment: "node"`, so anything living inside a React
// component is unreachable by every test in this repo — which is exactly how
// AIC-173 shipped.

export type MetaRefusalReason = "whatsapp_business_required";

export interface MetaRefusalView {
  /** null when Meta refused for something we have no Hebrew copy for. */
  reason: MetaRefusalReason | null;
  /** Meta's own sentence. Always present — the fallback when reason is null. */
  message: string;
}

const KNOWN: readonly MetaRefusalReason[] = ["whatsapp_business_required"];

/**
 * The refusal carried by a failed request, or null if this was any other
 * failure (a throttle, a 502, a network drop) and the caller should fall
 * through to its own copy.
 *
 * Reads the parsed body rather than the message so an unknown `reason` is
 * distinguishable from a missing one — a reason string we do not recognize is
 * treated as null and degrades to Meta's sentence, instead of selecting copy
 * that does not exist and rendering blank.
 */
export function metaRefusalOf(e: unknown): MetaRefusalView | null {
  const body = (e as { body?: unknown } | null)?.body as
    | { code?: unknown; reason?: unknown; error?: unknown }
    | undefined;
  if (!body || body.code !== "meta_refused") return null;
  const message = typeof body.error === "string" && body.error.trim() ? body.error : "";
  if (!message) return null;
  const reason = KNOWN.find((r) => r === body.reason) ?? null;
  return { reason, message };
}

// AIC-177 — OUR OWN refusals, distinct from Meta's.
//
// A placement the server rejects is not a Meta failure and must not read as
// one: `placement_no_instagram` means the customer's Instagram is gone since
// the page loaded, and `bad_placement` means this tab is older than the
// server. Both have a fix; neither is "something went wrong".
export type LocalRefusalReason = "placement_no_instagram" | "bad_placement";

const LOCAL: readonly LocalRefusalReason[] = ["placement_no_instagram", "bad_placement"];

export function localRefusalOf(e: unknown): LocalRefusalReason | null {
  const body = (e as { body?: unknown } | null)?.body as { code?: unknown } | undefined;
  const code = body?.code;
  return LOCAL.find((c) => c === code) ?? null;
}
