import type pg from "pg";
import { decryptToken, TokenCryptoError } from "./token-crypto.js";

// AIC-187 — whose credential is this Graph call made with?
//
// Before OAuth there was one answer for the whole process: the System User
// token in the environment. Now there are two kinds of connection and they
// cannot share a credential:
//
//   connected_via = 'manual'  the customer shared assets into OUR portfolio and
//                             we operate them as our own System User → env token
//   connected_via = 'oauth'   the customer granted US access to THEIR assets and
//                             Meta issued a token for it → that token
//
// Answering this in one place, rather than at seventeen call sites, is the
// whole point: a site that forgot to ask would fall back to the env token and
// mostly work — succeeding for manual customers and failing only for OAuth
// ones, which is the failure shape that reaches production.

export type TokenSource = "oauth" | "shared";

export interface ResolvedToken {
  token: string;
  source: TokenSource;
}

/** The environment token. Operator tools that act on OUR account use this directly. */
export function sharedToken(): string | null {
  return process.env.META_SYSTEM_USER_TOKEN || null;
}

interface ConnRow {
  connected_via: string;
  access_token_encrypted: string | null;
}

function resolveRow(row: ConnRow | undefined, who: string): ResolvedToken | null {
  if (row?.connected_via === "oauth") {
    // The schema already refuses an 'oauth' row without a token
    // (meta_connections_oauth_needs_token_check), so a null here means the
    // constraint was dropped, not that a fallback is appropriate.
    if (!row.access_token_encrypted) {
      console.error(`[token-resolver] ${who}: oauth connection with no token — refusing to fall back`);
      return null;
    }
    try {
      return { token: decryptToken(row.access_token_encrypted), source: "oauth" };
    } catch (e) {
      // Falling back to the shared token here would be actively wrong: it would
      // operate an OAuth customer's account with OUR credential, which either
      // fails on permissions or — worse, if we happen to have partner access —
      // succeeds and hides that the key is broken.
      console.error(
        `[token-resolver] ${who}: could not decrypt the stored token`,
        e instanceof TokenCryptoError ? e.message : e,
      );
      return null;
    }
  }
  // 'manual', or no connection row at all. Both mean the shared System User is
  // the only credential we have.
  const shared = sharedToken();
  return shared ? { token: shared, source: "shared" } : null;
}

export async function tokenForCustomer(pool: pg.Pool, customerId: string): Promise<ResolvedToken | null> {
  const { rows } = await pool.query<ConnRow>(
    `SELECT connected_via, access_token_encrypted
       FROM meta_connections
      WHERE customer_id = $1
      ORDER BY connected_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [customerId],
  );
  return resolveRow(rows[0], `customer ${customerId}`);
}

// Campaign-scoped, for the paths that hold a campaign and not its customer —
// the ingestion tick, the recommendation engine. The join is what makes this
// safe to call inside a loop over campaigns belonging to different customers.
export async function tokenForCampaign(pool: pg.Pool, campaignId: string): Promise<ResolvedToken | null> {
  const { rows } = await pool.query<ConnRow>(
    `SELECT c.connected_via, c.access_token_encrypted
       FROM managed_campaigns mc
       JOIN meta_connections c ON c.customer_id = mc.customer_id
      WHERE mc.id = $1
      ORDER BY c.connected_at DESC NULLS LAST, c.created_at DESC
      LIMIT 1`,
    [campaignId],
  );
  return resolveRow(rows[0], `campaign ${campaignId}`);
}

// User-scoped, for routes that hold a session and never look up the customer —
// the launch gate. One query rather than making each route do its own
// app_users → customers hop, which is the kind of duplication that drifts.
export async function tokenForUser(pool: pg.Pool, userId: string): Promise<ResolvedToken | null> {
  const { rows } = await pool.query<ConnRow>(
    `SELECT c.connected_via, c.access_token_encrypted
       FROM app_users u
       JOIN meta_connections c ON c.customer_id = u.customer_id
      WHERE u.id = $1
      ORDER BY c.connected_at DESC NULLS LAST, c.created_at DESC
      LIMIT 1`,
    [userId],
  );
  return resolveRow(rows[0], `user ${userId}`);
}

// Ad-account-scoped, for the creative reaper — which already groups its work by
// ad account and so has that id and not a customer.
export async function tokenForAdAccount(pool: pg.Pool, metaAdAccountId: string): Promise<ResolvedToken | null> {
  const { rows } = await pool.query<ConnRow>(
    `SELECT c.connected_via, c.access_token_encrypted
       FROM ad_accounts a
       JOIN meta_connections c ON c.id = a.connection_id
      WHERE a.meta_ad_account_id = $1
      ORDER BY c.connected_at DESC NULLS LAST, c.created_at DESC
      LIMIT 1`,
    [metaAdAccountId],
  );
  return resolveRow(rows[0], `ad account ${metaAdAccountId}`);
}
