import type { Request, Response, NextFunction } from "express";

// Minimal admin guard for the internal ops surfaces. When ADMIN_TOKEN is set, a
// matching `Authorization: Bearer <token>` is required; when it's unset (local
// dev), requests pass. A fuller operator auth arrives with the ops console
// (P0.4) — this keeps the readout from being wide open in a deployed env.
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    next();
    return;
  }
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token && token === expected) {
    next();
    return;
  }
  res.status(401).json({ error: "unauthorized" });
}
