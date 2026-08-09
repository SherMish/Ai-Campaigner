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

// The one deliberate role gate (AIC-47): only a full_admin may manage other
// operators. Every other admin route stays gated on requireAdmin alone — this
// is not a general per-route RBAC system. Mount AFTER requireAdmin on a route
// (adminRouter.use(requireAdmin) already ran), so req.userId is set; the
// break-glass token path has no user, so it never qualifies as full_admin.
export function buildRequireFullAdmin(deps: {
  isFullAdmin: (userId: string) => Promise<boolean>;
}) {
  return async function requireFullAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
    const userId = (req as AuthedRequest).userId;
    if (!userId || !(await deps.isFullAdmin(userId))) {
      res.status(403).json({ error: "requires full admin" });
      return;
    }
    next();
  };
}

export const requireFullAdmin = buildRequireFullAdmin({
  isFullAdmin: async (userId) => {
    const u = await store.findById(userId);
    return u?.isAdmin === true && u.adminRole === "full_admin";
  },
});
