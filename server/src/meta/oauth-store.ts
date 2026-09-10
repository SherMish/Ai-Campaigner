import type pg from "pg";
import { encryptToken } from "./token-crypto.js";
import type { ExchangeResult } from "./oauth-exchange.js";

// AIC-186 — persistence for the OAuth flow.
//
// Two responsibilities that both have to be transactional, for different
// reasons: spending a nonce (a race here is a replayable callback) and landing
// a connection plus its campaigns (a half-written connection is a customer who
// appears connected and is not).

export interface AdoptedCampaign {
  metaCampaignId: string;
  name: string;
  objective: string;
  dailyBudgetAgorot: number | null;
}

export class NonceError extends Error {}

export async function rememberState(
  pool: pg.Pool,
  nonce: string,
  userId: string,
  expiresAt: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO meta_oauth_states (nonce, user_id, expires_at) VALUES ($1, $2, $3)`,
    [nonce, userId, expiresAt],
  );
}

// Spends the nonce, or refuses.
//
// The UPDATE is the guard: `spent_at IS NULL AND expires_at > now()` is
// evaluated by Postgres while the row is locked, so two callbacks arriving at
// once cannot both see an unspent nonce. Doing this as SELECT-then-UPDATE is
// the same code with a race in it, which is why it is one statement.
export async function spendState(pool: pg.Pool, nonce: string, userId: string): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE meta_oauth_states
        SET spent_at = now()
      WHERE nonce = $1
        AND user_id = $2
        AND spent_at IS NULL
        AND expires_at > now()`,
    [nonce, userId],
  );
  if (!rowCount) {
    // Deliberately one message for "never existed", "already used" and
    // "expired". Distinguishing them tells an attacker which nonces are real.
    throw new NonceError("this connection link is no longer valid — please try connecting again");
  }
}

export async function sweepExpiredStates(pool: pg.Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM meta_oauth_states WHERE expires_at < now() - INTERVAL '1 day'`,
  );
  return rowCount ?? 0;
}

// Lands the whole connection in one transaction.
//
// Campaign adoption is the part that must not half-apply: a connection with
// three of a customer's five campaigns is worse than none, because the customer
// sees a switcher that silently omits their work.
export async function saveOauthConnection(
  pool: pg.Pool,
  args: {
    userId: string;
    result: ExchangeResult;
    adAccountId: string;
    pageId: string;
    instagramId: string | null;
    accountName: string;
    currency: string;
    timezone: string;
    campaigns: AdoptedCampaign[];
  },
): Promise<{ connectionId: string; customerId: string; adopted: number }> {
  // Encrypt BEFORE opening the transaction: a missing key must fail without
  // leaving an open transaction holding locks.
  const encrypted = encryptToken(args.result.accessToken);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Signup creates an app_user with customer_id = NULL; the customer row has
    // always been an operator's job. Connecting is the moment the customer
    // becomes real, so it is created here if it does not exist — otherwise the
    // "connect right after registering" flow has nothing to attach to.
    //
    // FOR UPDATE because a double-submitted callback must not create two
    // customers for one user.
    const { rows: userRows } = await client.query<{ customer_id: string | null; name: string | null; email: string }>(
      `SELECT customer_id, name, email FROM app_users WHERE id = $1 FOR UPDATE`,
      [args.userId],
    );
    if (!userRows.length) throw new Error(`no app_user ${args.userId}`);

    let customerId = userRows[0].customer_id;
    if (!customerId) {
      const { rows: made } = await client.query<{ id: string }>(
        // business_name is NOT NULL and the profile is not collected yet.
        // The Page name is the best truth we have at this instant, and the
        // customer corrects it in the business profile step.
        `INSERT INTO customers (business_name, contact_name, contact_email, onboarding_status)
         VALUES ($1, $2, $3, 'campaign_under_review') RETURNING id`,
        [args.accountName || userRows[0].name || userRows[0].email, userRows[0].name ?? "", userRows[0].email],
      );
      customerId = made[0].id;
      await client.query(`UPDATE app_users SET customer_id = $1 WHERE id = $2`, [customerId, args.userId]);
    }

    const { rows: conn } = await client.query<{ id: string }>(
      `INSERT INTO meta_connections
         (customer_id, business_portfolio_id, system_user_id, page_id, instagram_id,
          access_token_encrypted, token_scopes, meta_user_id,
          granted_business_ids, granted_ad_account_ids, granted_page_ids, granted_instagram_ids,
          connected_via, connected_at, access_health, last_verified_at)
       VALUES ($1, $2, '', $3, $4, $5, $6, $7, $8, $9, $10, $11, 'oauth', now(), 'ok', now())
       RETURNING id`,
      [
        customerId,
        args.result.assets.businessIds[0] ?? "",
        args.pageId,
        args.instagramId,
        encrypted,
        args.result.scopes,
        args.result.assets.metaUserId,
        args.result.assets.businessIds,
        args.result.assets.adAccountIds,
        args.result.assets.pageIds,
        args.result.assets.instagramIds,
      ],
    );
    const connectionId = conn[0].id;

    const { rows: acct } = await client.query<{ id: string }>(
      `INSERT INTO ad_accounts (connection_id, meta_ad_account_id, name, currency, timezone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [connectionId, args.adAccountId, args.accountName, args.currency, args.timezone],
    );
    const adAccountRowId = acct[0].id;

    let adopted = 0;
    for (const c of args.campaigns) {
      // automation_enabled = FALSE, always.
      //
      // Discovering a customer's existing campaigns is observation. Letting the
      // engine change them is an action they have not asked for, and the column
      // defaults to true — so it has to be written explicitly here, every time.
      const { rowCount } = await client.query(
        `INSERT INTO managed_campaigns
           (customer_id, ad_account_id, meta_campaign_id, name, objective,
            status, agreed_budget_agorot, automation_enabled)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, false)
         ON CONFLICT (customer_id, meta_campaign_id) WHERE meta_campaign_id IS NOT NULL
         DO NOTHING`,
        [
          customerId,
          adAccountRowId,
          c.metaCampaignId,
          c.name,
          c.objective,
          c.dailyBudgetAgorot ?? 0,
        ],
      );
      adopted += rowCount ?? 0;
    }

    await client.query("COMMIT");
    return { connectionId, customerId, adopted };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
