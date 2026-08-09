import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { verifyAuthToken } from "../auth/tokens.js";
import { PgUserStore } from "../auth/user-store.js";
import { pool } from "../db/pool.js";
import type { AuthedRequest } from "./auth.js";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Guard for the internal ops/admin API. Admin is a per-USER role, not a shared
// secret: a valid customer JWT whose app_user has is_admin = true passes. Fail
// closed — no admin credential → denied, always (never open by omission, in any
// environment). An optional ADMIN_TOKEN remains as a break-glass for machine/curl
// access; it's unset by default, so only admin users get in.
export function buildRequireAdmin(deps: {
  isAdminUser: (userId: string) => Promise<boolean>;
}) {
  return async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";

    // 1) User-based: an admin app_user's session token.
    const auth = token ? verifyAuthToken(token) : null;
    if (auth) {
      try {
        if (await deps.isAdminUser(auth.userId)) {
          (req as AuthedRequest).userId = auth.userId;
          next();
          return;
        }
      } catch {
        /* fall through to deny */
      }
      res.status(403).json({ error: "forbidden" });
      return;
    }

    // 2) Break-glass static token (optional; unset by default).
    const expected = process.env.ADMIN_TOKEN;
    if (expected && token && safeEqual(token, expected)) {
      next();
      return;
    }

    res.status(401).json({ error: "unauthorized" });
  };
}

const store = new PgUserStore(pool);

export const requireAdmin = buildRequireAdmin({
  isAdminUser: async (userId) => (await store.findById(userId))?.isAdmin === true,
});
