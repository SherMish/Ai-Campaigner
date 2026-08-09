import type pg from "pg";
import type { AdminRole } from "../auth/user-store.js";
import { logAdminAction, type Actor } from "./admin-audit.js";

// Operator accounts management (AIC-47): who can access the console. Builds
// on AIC-35's per-user admin role — this adds the management surface on top.
// P0 has no invite-by-email flow (no email sender yet, same limitation noted
// for password reset, AIC-33), so granting access requires the person to
// already have a signed-up account; addOperator promotes an existing one.

export interface OperatorRow {
  id: string;
  email: string;
  name: string;
  adminRole: AdminRole;
  createdAt: string;
}

export async function listOperators(pool: pg.Pool): Promise<OperatorRow[]> {
  const { rows } = await pool.query<{ id: string; email: string; name: string; admin_role: AdminRole; created_at: Date }>(
    `SELECT id, email, name, admin_role, created_at FROM app_users WHERE is_admin = true ORDER BY created_at`,
  );
  return rows.map((r) => ({
    id: r.id, email: r.email, name: r.name, adminRole: r.admin_role,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export type OperatorResult = { ok: true } | { ok: false; error: string };

export async function addOperator(pool: pg.Pool, actor: Actor, email: string, role: AdminRole): Promise<OperatorResult> {
  const { rows } = await pool.query<{ id: string; email: string; is_admin: boolean }>(
    `SELECT id, email, is_admin FROM app_users WHERE lower(email) = lower($1)`,
    [email.trim()],
  );
  const user = rows[0];
  if (!user) return { ok: false, error: "no account with that email yet — they need to sign up first" };
  if (user.is_admin) return { ok: false, error: "already an operator" };

  await pool.query(`UPDATE app_users SET is_admin = true, admin_role = $2 WHERE id = $1`, [user.id, role]);
  await logAdminAction(pool, {
    actorUserId: actor.userId, actorLabel: actor.label,
    action: "operator.add", entityType: "operator", entityId: user.id, entityLabel: user.email,
    afterState: { role }, detail: `Granted console access as ${role}`,
  });
  return { ok: true };
}

async function remainingFullAdmins(pool: pg.Pool, excludingUserId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app_users WHERE is_admin = true AND admin_role = 'full_admin' AND id <> $1`,
    [excludingUserId],
  );
  return rows[0].n;
}

export async function setOperatorRole(pool: pg.Pool, actor: Actor, userId: string, role: AdminRole): Promise<OperatorResult> {
  const { rows } = await pool.query<{ email: string; admin_role: AdminRole; is_admin: boolean }>(
    `SELECT email, admin_role, is_admin FROM app_users WHERE id = $1`,
    [userId],
  );
  const user = rows[0];
  if (!user || !user.is_admin) return { ok: false, error: "operator not found" };
  if (user.admin_role === role) return { ok: true };

  // Never leave the console with zero full_admins — nobody could manage
  // operators again (including undoing this very demotion).
  if (user.admin_role === "full_admin" && role === "operator") {
    if ((await remainingFullAdmins(pool, userId)) === 0) {
      return { ok: false, error: "can't demote the last full admin" };
    }
  }

  await pool.query(`UPDATE app_users SET admin_role = $2 WHERE id = $1`, [userId, role]);
  await logAdminAction(pool, {
    actorUserId: actor.userId, actorLabel: actor.label,
    action: "operator.role_change", entityType: "operator", entityId: userId, entityLabel: user.email,
    beforeState: { role: user.admin_role }, afterState: { role },
    detail: `Role changed from ${user.admin_role} to ${role}`,
  });
  return { ok: true };
}

export async function removeOperator(pool: pg.Pool, actor: Actor, userId: string): Promise<OperatorResult> {
  const { rows } = await pool.query<{ email: string; admin_role: AdminRole; is_admin: boolean }>(
    `SELECT email, admin_role, is_admin FROM app_users WHERE id = $1`,
    [userId],
  );
  const user = rows[0];
  if (!user || !user.is_admin) return { ok: false, error: "operator not found" };

  if (user.admin_role === "full_admin" && (await remainingFullAdmins(pool, userId)) === 0) {
    return { ok: false, error: "can't remove the last full admin" };
  }

  // Revoke console access; the login itself survives (never delete an
  // account here — same convention as customer hard-delete not touching a
  // linked app_user, AIC-44).
  await pool.query(`UPDATE app_users SET is_admin = false, admin_role = 'operator' WHERE id = $1`, [userId]);
  await logAdminAction(pool, {
    actorUserId: actor.userId, actorLabel: actor.label,
    action: "operator.remove", entityType: "operator", entityId: userId, entityLabel: user.email,
    beforeState: { role: user.admin_role }, detail: "Revoked console access",
  });
  return { ok: true };
}
