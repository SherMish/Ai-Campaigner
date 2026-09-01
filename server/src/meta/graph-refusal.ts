import type { Response } from "express";
import { GraphWriteError } from "./campaign-adapter.js";

// AIC-174 — Meta's own refusal, shown to the customer instead of swallowed.
//
// Reported live: adding an ad set failed with "לא הצלחנו להוסיף קבוצת מודעות",
// and the actual cause was sitting in the log, already written for a person:
//
//   Page With WhatsApp Business Account Required
//   The WhatsApp number linked to your Page is a personal account. You must
//   connect a WhatsApp Business account to drive traffic to WhatsApp.
//
// Precise, actionable, and fixable in about a minute — and the customer saw
// none of it. This is AIC-168's shape one step further out: that ticket
// rescued ONE refusal (the throttle) from the generic catch; every other thing
// Meta declines still lands as "something went wrong".
//
// The distinction that matters is `userMessage`. Meta populates
// `error_user_msg` only when it believes the error is a person's to fix —
// configuration, permissions, policy. That is exactly the set worth
// surfacing, and it excludes our own bad payloads, which have no
// `error_user_msg` and correctly stay a 502 nobody but us should read.
//
// 400, not 502: the request was well-formed and Meta understood it. It said
// no, and it said why. A 502 claims the upstream broke, which is a different
// and less useful thing to put in a log.

/**
 * Refusals we have Hebrew copy for. The `reason` is the discriminant the web
 * layer switches on; everything without one still shows Meta's own sentence
 * rather than nothing, which is the whole point — an unmapped refusal must
 * degrade to English truth, never to a generic failure.
 */
export type MetaRefusalReason = "whatsapp_business_required";

const REASON_BY_SUBCODE: Record<number, MetaRefusalReason> = {
  // Live, 2026-09-01, on Byliam nails: a click-to-WhatsApp ad set points at a
  // Page, and Meta reads the WhatsApp number linked to THAT Page. A personal
  // WhatsApp is refused. Note the Page had an ad set running on this same
  // shape since 2026-08-09 — so this is enforced at create time against the
  // Page's CURRENT linkage, not something the campaign carries.
  2446885: "whatsapp_business_required",
};

export interface MetaRefusal {
  reason: MetaRefusalReason | null;
  title: string | null;
  message: string;
}

export function metaRefusal(e: unknown): MetaRefusal | null {
  if (!(e instanceof GraphWriteError)) return null;
  // No customer-facing sentence from Meta means this is not a customer-facing
  // problem. Falling back to `e.message` here would put our raw Graph call and
  // an fbtrace_id on a customer's screen.
  if (!e.userMessage) return null;
  return {
    reason: (e.subcode !== null && REASON_BY_SUBCODE[e.subcode]) || null,
    title: e.userTitle,
    message: e.userMessage,
  };
}

/**
 * Answers the request if Meta refused it with a reason, and reports whether it
 * did — same shape as `respondIfMetaThrottled`, and consulted directly after
 * it:
 *
 *     } catch (e) {
 *       if (respondIfMetaThrottled(res, e)) return;
 *       if (respondIfMetaRefused(res, e)) return;
 *       …its own handling…
 *     }
 *
 * Order matters: a throttle is transient and has its own copy and its own
 * status code, so it must not be absorbed into the generic refusal path.
 */
export function respondIfMetaRefused(res: Response, e: unknown): boolean {
  const refusal = metaRefusal(e);
  if (!refusal) return false;
  res.status(400).json({
    error: refusal.message,
    title: refusal.title,
    reason: refusal.reason,
    code: "meta_refused",
  });
  return true;
}
