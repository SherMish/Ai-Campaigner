import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Guard for the internal ops/admin API. Security posture:
//   - ADMIN_TOKEN set  → require a matching `Authorization: Bearer <token>`.
//   - ADMIN_TOKEN unset + production → **deny all** (fail closed): an unauth'd
//     admin surface on a public URL is exactly the PIS-26 hole; never open by
//     omission in prod.
//   - ADMIN_TOKEN unset + non-production → allow (local dev convenience).
// The admin web console sends the token as a bearer (see web AdminGate).
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_TOKEN;
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (expected) {
    if (token && safeEqual(token, expected)) {
      next();
      return;
    }
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  if (process.env.NODE_ENV === "production") {
    res.status(503).json({ error: "admin auth not configured" });
    return;
  }
  next();
}
