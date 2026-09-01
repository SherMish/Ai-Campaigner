import type { Response } from "express";
import { GraphWriteError, META_RATE_LIMIT_CODE } from "./campaign-adapter.js";

// AIC-168 — Meta's per-ad-account throttle, answered the same way everywhere.
//
// AIC-160 fixed this at ONE call site: the admin campaign picker learned to
// answer 429 with honest copy instead of a flat 502. Every other route kept
// folding code 17 into its own generic failure, so a customer clicking
// "הפעלת המודעה" during a throttle got "לא הצלחנו לבצע את השינוי. נסו שוב." —
// no reason, no sense of how long, and the reasonable conclusion that the
// product is broken. It is not: the account is briefly throttled, and waiting
// is the whole fix.
//
// The information was never missing. `GraphWriteError` has carried the code
// and Meta's own operator-facing sentence all along; what was missing is that
// each route decided for itself whether to look, so "we handle the throttle"
// was true only where someone remembered. One function, consulted before every
// generic catch, is the difference between a rule and a habit.
//
// 429 rather than 502 on purpose: a throttle is not "Meta is broken", and the
// status code is the first thing anyone reads in a log.

export function isMetaThrottled(e: unknown): boolean {
  return e instanceof GraphWriteError && e.code === META_RATE_LIMIT_CODE;
}

/**
 * Answers the request if this was a throttle, and reports whether it did — so
 * a caller reads as:
 *
 *     } catch (e) {
 *       if (respondIfMetaThrottled(res, e)) return;
 *       …its own handling…
 *     }
 *
 * `code` lets the client pick localized copy; `error` carries Meta's own
 * sentence for the logs and for any surface without copy of its own.
 */
export function respondIfMetaThrottled(res: Response, e: unknown): boolean {
  if (!isMetaThrottled(e)) return false;
  const err = e as GraphWriteError;
  res.status(429).json({ error: err.userMessage ?? err.message, code: "meta_rate_limited" });
  return true;
}
