import type { Request, Response, NextFunction } from "express";
import { verifyAuthToken } from "../auth/tokens.js";

export interface AuthedRequest extends Request {
  userId?: string;
  /** AIC-189: the admin viewing as this user, or undefined for a real session. */
  impersonatedBy?: string;
}

// Requires a valid customer JWT (Authorization: Bearer <token>). Sets req.userId.
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const result = token ? verifyAuthToken(token) : null;
  if (!result) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  // AIC-189 — an impersonated session cannot write. Anything.
  //
  // The button is a VIEWER. A write made through it would spend a real
  // customer's budget, or create ads in their account, and would be recorded as
  // the customer's own action — because the session claims to be them. That is
  // the live-account safety boundary exactly: an admin action wearing the
  // customer's name is neither the customer acting nor an admin acting openly.
  //
  // Enforced here rather than route by route, because the guarantee has to hold
  // for the NEXT route somebody adds, not only for today's.
  if (result.impersonatedBy && req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    res.status(403).json({ error: "read_only_session", reason: "impersonation" });
    return;
  }

  const authed = req as AuthedRequest;
  authed.userId = result.userId;
  if (result.impersonatedBy) authed.impersonatedBy = result.impersonatedBy;
  next();
}
