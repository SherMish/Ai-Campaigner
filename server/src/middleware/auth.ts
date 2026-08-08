import type { Request, Response, NextFunction } from "express";
import { verifyAuthToken } from "../auth/tokens.js";

export interface AuthedRequest extends Request {
  userId?: string;
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
  (req as AuthedRequest).userId = result.userId;
  next();
}
