import type pg from "pg";

// AIC-188 — the business-details step, which now CREATES the customer.
//
// Before this, a customer row first existed when OAuth ran, and `business_name`
// was filled from the ad account's own name — which on a real account came out
// as "2181076988590009". That name feeds ad copy generation, so it is not
// cosmetic: it is the difference between a campaign written for a business and
// one written for a number.

export const MAX_NAME = 80;
export const MIN_NAME = 2;
export const MAX_URL = 300;

export interface BusinessDetailsInput {
  businessName?: unknown;
  websiteUrl?: unknown;
}

export interface BusinessDetails {
  businessName: string;
  websiteUrl: string;
}

export type DetailsRefusal =
  | "name_required"
  | "name_too_short"
  | "name_too_long"
  | "url_too_long"
  | "url_not_http";

/**
 * Validates and normalises. Returns a refusal rather than throwing, so the route
 * can map each case to its own message — "Never render a blank where a reason
 * exists" applies to a rejected form as much as to a missing metric.
 *
 * The website is optional. A customer with no site is normal, and demanding one
 * would block the step for exactly the small businesses this product is for.
 */
export function validateBusinessDetails(
  input: BusinessDetailsInput,
): { ok: true; value: BusinessDetails } | { ok: false; reason: DetailsRefusal } {
  const rawName = typeof input.businessName === "string" ? input.businessName.trim() : "";
  if (!rawName) return { ok: false, reason: "name_required" };
  if (rawName.length < MIN_NAME) return { ok: false, reason: "name_too_short" };
  if (rawName.length > MAX_NAME) return { ok: false, reason: "name_too_long" };

  const rawUrl = typeof input.websiteUrl === "string" ? input.websiteUrl.trim() : "";
  if (!rawUrl) return { ok: true, value: { businessName: rawName, websiteUrl: "" } };
  if (rawUrl.length > MAX_URL) return { ok: false, reason: "url_too_long" };

  // People type "example.co.il", not "https://example.co.il". Assuming https is
  // the normalisation; assuming http would silently downgrade them.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: "url_not_http" };
  }
  // The scheme check is the security-relevant one: this value is stored and
  // later rendered as a link, and `javascript:` in an href is script execution
  // in whoever's browser opens it — an operator's, in the admin console.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "url_not_http" };
  }
  if (!parsed.hostname.includes(".")) return { ok: false, reason: "url_not_http" };

  return { ok: true, value: { businessName: rawName, websiteUrl: parsed.toString() } };
}

/**
 * Creates the customer if the user has none, or updates the one they have.
 *
 * `FOR UPDATE` because a double-submitted form must not create two customers for
 * one user — the same reason the OAuth callback locks the row.
 */
export async function saveBusinessDetails(
  pool: pg.Pool,
  userId: string,
  details: BusinessDetails,
): Promise<{ customerId: string; created: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<{ customer_id: string | null; name: string | null; email: string }>(
      `SELECT customer_id, name, email FROM app_users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (!rows.length) throw new Error(`no app_user ${userId}`);
    const existing = rows[0].customer_id;

    if (existing) {
      // Editing details later must never rewind someone's onboarding, so the
      // status is deliberately untouched here.
      await client.query(
        `UPDATE customers SET business_name = $1, website_url = $2, updated_at = now() WHERE id = $3`,
        [details.businessName, details.websiteUrl, existing],
      );
      await client.query("COMMIT");
      return { customerId: existing, created: false };
    }

    const { rows: made } = await client.query<{ id: string }>(
      `INSERT INTO customers (business_name, website_url, contact_name, contact_email, onboarding_status)
       VALUES ($1, $2, $3, $4, 'meta_connection_required') RETURNING id`,
      [details.businessName, details.websiteUrl, rows[0].name ?? "", rows[0].email],
    );
    await client.query(`UPDATE app_users SET customer_id = $1 WHERE id = $2`, [made[0].id, userId]);
    await client.query("COMMIT");
    return { customerId: made[0].id, created: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
