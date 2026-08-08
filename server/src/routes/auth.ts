import { Router } from "express";
import { pool } from "../db/pool.js";
import { PgUserStore } from "../auth/user-store.js";
import { AuthService, EmailTakenError, InvalidCredentialsError } from "../auth/auth-service.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";

// Customer auth (AIC-21): email + password → our own JWT session.
export const authRouter = Router();

const store = new PgUserStore(pool);
const service = new AuthService(store);

const MIN_PASSWORD = 8;

authRouter.post("/signup", async (req, res) => {
  try {
    const { email, password, name } = req.body ?? {};
    if (!email || typeof email !== "string" || !/.+@.+\..+/.test(email)) {
      res.status(400).json({ error: "a valid email is required" });
      return;
    }
    if (!password || typeof password !== "string" || password.length < MIN_PASSWORD) {
      res.status(400).json({ error: `password must be at least ${MIN_PASSWORD} characters` });
      return;
    }
    const result = await service.signup({ email, password, name });
    res.json(result);
  } catch (e) {
    if (e instanceof EmailTakenError) {
      res.status(409).json({ error: "email already registered" });
      return;
    }
    console.error("[auth] signup failed", e);
    res.status(500).json({ error: "signup failed" });
  }
});

authRouter.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      res.status(400).json({ error: "email and password required" });
      return;
    }
    const result = await service.login({ email, password });
    res.json(result);
  } catch (e) {
    if (e instanceof InvalidCredentialsError) {
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    console.error("[auth] login failed", e);
    res.status(500).json({ error: "login failed" });
  }
});

authRouter.post("/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!currentPassword || typeof currentPassword !== "string") {
      res.status(400).json({ error: "current password required" });
      return;
    }
    if (!newPassword || typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD) {
      res.status(400).json({ error: `new password must be at least ${MIN_PASSWORD} characters` });
      return;
    }
    await service.changePassword((req as AuthedRequest).userId!, currentPassword, newPassword);
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof InvalidCredentialsError) {
      res.status(401).json({ error: "current password is incorrect" });
      return;
    }
    console.error("[auth] change-password failed", e);
    res.status(500).json({ error: "failed to change password" });
  }
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await store.findById((req as AuthedRequest).userId!);
  if (!user) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  res.json({ user });
});
