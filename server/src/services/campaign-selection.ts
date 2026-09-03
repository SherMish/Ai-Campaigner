import type pg from "pg";

// AIC-186 — which of the customer's campaigns a request is about.
//
// Until now a customer had exactly one campaign (a UNIQUE constraint said so),
// and every route resolved it from the user with LIMIT 1. With two, the
// question "which campaign" has to be answered per request — and answered
// SAFELY, because the failure mode is showing one customer another campaign's
// numbers.
//
// Two rules make that hard to get wrong:
//
//   1. A campaign id from the client is a REQUEST, never a fact. It is always
//      re-checked against the caller's own customer, in the same query that
//      fetches it, so there is no window where an unvalidated id is in play.
//   2. No id means the customer's own default (their oldest campaign), which
//      is exactly what LIMIT 1 did before — so every existing caller keeps
//      working unchanged, and multi-campaign is opt-in per surface.
//
// The alternative — a "currently selected campaign" stored server-side — was
// rejected. It reads well until two tabs disagree, and it still needs the
// ownership check on every request, so it buys nothing and adds hidden state.

export interface OwnedCampaign {
  campaignId: string;
  customerId: string;
  metaCampaignId: string | null;
  name: string;
  destination: string;
  status: string;
  isTest: boolean;
}

/**
 * Resolve the campaign a request is about, scoped to the caller.
 *
 * Returns null when the caller has no campaign at all, AND when the requested
 * id is not theirs — deliberately the same answer. Distinguishing "not found"
 * from "not yours" tells an attacker which ids exist.
 *
 * Ordered by `created_at` so "the default" is stable: a customer's first
 * campaign stays their default when a second is added, rather than the
 * dashboard silently switching under them.
 */
export async function resolveOwnedCampaign(
  pool: pg.Pool,
  userId: string,
  campaignId?: string | null,
): Promise<OwnedCampaign | null> {
  const { rows } = await pool.query<{
    id: string; customer_id: string; meta_campaign_id: string | null;
    name: string; destination: string; status: string; is_test: boolean | null;
  }>(
    `SELECT mc.id, mc.customer_id, mc.meta_campaign_id, mc.name, mc.destination, mc.status, c.is_test
       FROM app_users u
       JOIN managed_campaigns mc ON mc.customer_id = u.customer_id
       JOIN customers c ON c.id = mc.customer_id
      WHERE u.id = $1
        AND ($2::uuid IS NULL OR mc.id = $2::uuid)
      ORDER BY mc.created_at ASC
      LIMIT 1`,
    [userId, campaignId ?? null],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    campaignId: r.id, customerId: r.customer_id, metaCampaignId: r.meta_campaign_id,
    name: r.name, destination: r.destination, status: r.status, isTest: r.is_test === true,
  };
}

export interface CampaignChoice {
  campaignId: string;
  name: string;
  destination: string;
  status: string;
  /** True for the one a request gets when it names none. */
  isDefault: boolean;
}

/**
 * Every campaign this customer has, for the dashboard's switcher.
 *
 * Carries the DESTINATION, not just the name: a customer switching between a
 * leads campaign and an engagement campaign is switching between two different
 * meanings of "results", and a list of names alone would invite reading one as
 * the other.
 */
export async function listOwnedCampaigns(pool: pg.Pool, userId: string): Promise<CampaignChoice[]> {
  const { rows } = await pool.query<{
    id: string; name: string; destination: string; status: string;
  }>(
    `SELECT mc.id, mc.name, mc.destination, mc.status
       FROM app_users u
       JOIN managed_campaigns mc ON mc.customer_id = u.customer_id
      WHERE u.id = $1
      ORDER BY mc.created_at ASC`,
    [userId],
  );
  return rows.map((r, i) => ({
    campaignId: r.id, name: r.name, destination: r.destination, status: r.status,
    isDefault: i === 0,
  }));
}

/**
 * A campaign id straight off a query string, or null.
 *
 * Anything that is not a UUID is dropped rather than passed to Postgres: an
 * arbitrary string in a `::uuid` cast is a 500, and a 500 is a worse answer to
 * a malformed id than simply falling back to the default campaign.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function campaignIdParam(raw: unknown): string | null {
  return typeof raw === "string" && UUID.test(raw) ? raw : null;
}

/**
 * The campaign a REQUEST is about, from wherever the client put it.
 *
 * Query for reads, body for writes — a POST that carries its target in the URL
 * and its payload in the body is the kind of split that gets one of them
 * forgotten. Both are validated the same way, and an absent or malformed id
 * falls back to the customer's default rather than erroring: a bad id is not
 * worth a 500 when there is a correct campaign to show.
 */
export function campaignIdFromRequest(req: {
  query?: Record<string, unknown>;
  body?: unknown;
}): string | null {
  const fromQuery = campaignIdParam(req.query?.campaignId);
  if (fromQuery) return fromQuery;
  const body = req.body as { campaignId?: unknown } | undefined;
  return campaignIdParam(body?.campaignId);
}
