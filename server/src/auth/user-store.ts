import { randomUUID } from "node:crypto";
import type pg from "pg";

// Operator role (AIC-47): meaningful only when isAdmin is true. full_admin can
// manage other operators; operator has the same console access otherwise —
// this is the one deliberate role gate, not a general RBAC system.
export type AdminRole = "full_admin" | "operator";

export interface AppUser {
  id: string;
  email: string;
  name: string;
  customerId: string | null;
  isAdmin: boolean;
  adminRole: AdminRole;
  createdAt: Date;
}
export interface AppUserWithHash extends AppUser {
  passwordHash: string;
}

export interface CreateUserInput {
  email: string; // already normalized (lowercased/trimmed)
  passwordHash: string;
  name: string;
}

// Thrown when a create races another insert on the same email.
export class DuplicateEmailError extends Error {
  constructor() {
    super("email already registered");
    this.name = "DuplicateEmailError";
  }
}

export interface UserStore {
  findByEmail(email: string): Promise<AppUserWithHash | null>;
  findById(id: string): Promise<AppUser | null>;
  findByIdWithHash(id: string): Promise<AppUserWithHash | null>;
  create(input: CreateUserInput): Promise<AppUser>;
  updatePassword(id: string, passwordHash: string): Promise<void>;
}

function rowToUser(r: Record<string, unknown>): AppUser {
  return {
    id: r.id as string,
    email: r.email as string,
    name: (r.name as string) ?? "",
    customerId: (r.customer_id as string) ?? null,
    isAdmin: (r.is_admin as boolean) ?? false,
    adminRole: ((r.admin_role as AdminRole) ?? "operator"),
    createdAt: r.created_at as Date,
  };
}

export class PgUserStore implements UserStore {
  constructor(private readonly pool: pg.Pool) {}

  async findByEmail(email: string): Promise<AppUserWithHash | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM app_users WHERE lower(email) = lower($1) LIMIT 1`,
      [email],
    );
    return rows[0] ? { ...rowToUser(rows[0]), passwordHash: rows[0].password_hash } : null;
  }

  async findById(id: string): Promise<AppUser | null> {
    const { rows } = await this.pool.query(`SELECT * FROM app_users WHERE id = $1`, [id]);
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async findByIdWithHash(id: string): Promise<AppUserWithHash | null> {
    const { rows } = await this.pool.query(`SELECT * FROM app_users WHERE id = $1`, [id]);
    return rows[0] ? { ...rowToUser(rows[0]), passwordHash: rows[0].password_hash } : null;
  }

  async create(input: CreateUserInput): Promise<AppUser> {
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO app_users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING *`,
        [input.email, input.passwordHash, input.name],
      );
      return rowToUser(rows[0]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new DuplicateEmailError();
      throw e;
    }
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.pool.query(`UPDATE app_users SET password_hash = $2 WHERE id = $1`, [id, passwordHash]);
  }
}

export class InMemoryUserStore implements UserStore {
  public users: AppUserWithHash[] = [];
  async findByEmail(email: string): Promise<AppUserWithHash | null> {
    return this.users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null;
  }
  async findById(id: string): Promise<AppUser | null> {
    const u = this.users.find((x) => x.id === id);
    return u ? { ...u } : null;
  }
  async findByIdWithHash(id: string): Promise<AppUserWithHash | null> {
    return this.users.find((x) => x.id === id) ?? null;
  }
  async create(input: CreateUserInput): Promise<AppUser> {
    if (await this.findByEmail(input.email)) throw new DuplicateEmailError();
    const user: AppUserWithHash = {
      id: randomUUID(), email: input.email, name: input.name, customerId: null,
      isAdmin: false, adminRole: "operator", createdAt: new Date(), passwordHash: input.passwordHash,
    };
    this.users.push(user);
    const { passwordHash, ...pub } = user;
    void passwordHash;
    return pub;
  }
  async updatePassword(id: string, passwordHash: string): Promise<void> {
    const u = this.users.find((x) => x.id === id);
    if (u) u.passwordHash = passwordHash;
  }
}
