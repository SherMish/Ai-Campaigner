import type pg from "pg";
import type { AccessHealth, CampaignStatus, SubscriptionStatus, CampaignRequiredField } from "@aic/shared";
import { logAdminAction, type Actor } from "./admin-audit.js";
import { classifyConnectionReadiness, missingConfigFields, type ConnectionReadinessReason } from "./connection-readiness.js";
import { deriveIsMessaging } from "../meta/tracking-health.js";

// The admin "Users" view — separate from the existing "Customers" (businesses)
// view. A user is the login (email/password/name, app_users) that will
// eventually carry billing/trial state directly; a customer is the business
// entity the Meta connection hangs off. Kept as a SEPARATE page rather than
// replacing /admin/customers (explicit user decision) because the two answer
// different questions: "who has signed up" vs "which businesses are we
// managing" — a signed-up user with no business yet is invisible on the
// customers page, and this view exists specifically to surface that gap.

export interface UserListRow {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  customerId: string | null;
  businessName: string | null;
  isTest: boolean | null;
  subscriptionStatus: SubscriptionStatus | null;
  accessHealth: AccessHealth | null;
  campaignStatus: CampaignStatus | null;
  connectionReadiness: ConnectionReadinessReason | null;
  // AIC-103: see CustomerListRow's twin field (services/customers.ts) — same
  // health check, same table, surfaced here too since a user with a business
  // but no customer_id-linked row yet would otherwise be invisible on the
  // Customers page (this view's whole reason to exist).
  missingConfigFields: CampaignRequiredField[];
}

export async function listAppUsers(pool: pg.Pool): Promise<UserListRow[]> {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.created_at,
            c.id AS customer_id, c.business_name, c.is_test,
            s.status AS subscription_status,
            conn.access_health, conn.page_id,
            mc.id AS campaign_id, mc.status AS campaign_status, mc.meta_campaign_id, aa.meta_ad_account_id,
            mc.whatsapp_destination, mc.website_url, mc.tracking_pixel_id, mc.lead_event_types
     FROM app_users u
     LEFT JOIN customers c        ON c.id = u.customer_id
     LEFT JOIN subscriptions s    ON s.customer_id = c.id
     LEFT JOIN meta_connections conn ON conn.customer_id = c.id
     LEFT JOIN ad_accounts aa     ON aa.connection_id = conn.id
     LEFT JOIN managed_campaigns mc ON mc.customer_id = c.id
     ORDER BY u.created_at DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    createdAt: new Date(r.created_at).toISOString(),
    customerId: r.customer_id ?? null,
    businessName: r.business_name ?? null,
    isTest: r.is_test ?? null,
    subscriptionStatus: r.subscription_status ?? null,
    accessHealth: r.access_health ?? null,
    campaignStatus: r.campaign_status ?? null,
    ...(r.customer_id
      ? (() => {
          const input = {
            campaignId: r.campaign_id ?? null,
            metaCampaignId: r.meta_campaign_id ?? null,
            accessHealth: r.access_health ?? null,
            metaAdAccountId: r.meta_ad_account_id ?? null,
            pageId: r.page_id ?? null,
            isMessaging: deriveIsMessaging(r.lead_event_types, r.whatsapp_destination),
            whatsappDestination: r.whatsapp_destination ?? null,
            websiteUrl: r.website_url ?? null,
            trackingPixelId: r.tracking_pixel_id ?? null,
            leadEventTypes: r.lead_event_types ?? null,
          };
          return { connectionReadiness: classifyConnectionReadiness(input), missingConfigFields: missingConfigFields(input) };
        })()
      : { connectionReadiness: null, missingConfigFields: [] }),
  }));
}

// The bridge from "a login" to "the business the onboarding wizard operates
// on" — the wizard is keyed by customerId (AIC-101), so a user with none yet
// needs a bare business row created and linked before it can open. Idempotent:
// a user who already has one just gets that id back, never a second row.
export async function ensureCustomerForUser(
  pool: pg.Pool,
  actor: Actor,
  userId: string,
): Promise<{ customerId: string; created: boolean }> {
  const { rows } = await pool.query<{ customer_id: string | null; email: string; name: string }>(
    `SELECT customer_id, email, name FROM app_users WHERE id = $1`,
    [userId],
  );
  const user = rows[0];
  if (!user) throw new Error("user not found");
  if (user.customer_id) return { customerId: user.customer_id, created: false };

  const businessName = user.name.trim() || user.email;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = await client.query<{ id: string }>(
      `INSERT INTO customers (business_name, contact_email, onboarding_status)
       VALUES ($1, $2, 'meta_connection_required') RETURNING id`,
      [businessName, user.email],
    );
    const customerId = created.rows[0].id;
    await client.query(`UPDATE app_users SET customer_id = $1 WHERE id = $2`, [customerId, userId]);
    await client.query("COMMIT");

    await logAdminAction(pool, {
      actorUserId: actor.userId,
      actorLabel: actor.label,
      action: "user.provision_customer",
      entityType: "customer",
      entityId: customerId,
      entityLabel: businessName,
      detail: `Created a bare business record for user ${user.email} to start onboarding`,
    });
    return { customerId, created: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
