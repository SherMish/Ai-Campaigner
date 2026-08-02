import type pg from "pg";

export type ReviewOutcome = "approved" | "changes_requested" | "unsupported";

// The §11 checklist the reviewer fills. Free-form booleans so it can evolve.
export type ReviewChecklist = Record<string, boolean>;

export interface CampaignReview {
  id: string;
  createdAt: Date;
  campaignId: string;
  reviewer: string;
  outcome: ReviewOutcome;
  checklist: ReviewChecklist;
  notes: string;
  customerApproved: boolean | null;
  customerApprovedAt: Date | null;
}

function rowToReview(r: Record<string, unknown>): CampaignReview {
  return {
    id: r.id as string,
    createdAt: r.created_at as Date,
    campaignId: r.campaign_id as string,
    reviewer: r.reviewer as string,
    outcome: r.outcome as ReviewOutcome,
    checklist: (r.checklist as ReviewChecklist) ?? {},
    notes: (r.notes as string) ?? "",
    customerApproved: (r.customer_approved as boolean) ?? null,
    customerApprovedAt: (r.customer_approved_at as Date) ?? null,
  };
}

// First-campaign review (AIC-18): the mandatory human gate before a campaign
// becomes managed. Records the outcome + reviewer + timestamp, and moves the
// campaign's status — but NEVER activates/rebuilds/modifies without recorded
// customer approval (PRD §11 hard rule):
//   approved            → status 'active' (we manage + monitor; no Meta change)
//   unsupported         → status 'unmanaged'
//   changes_requested   → status stays 'under_review' until the customer approves
export async function submitReview(
  pool: pg.Pool,
  input: { campaignId: string; reviewer: string; outcome: ReviewOutcome; checklist?: ReviewChecklist; notes?: string },
): Promise<CampaignReview> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO campaign_reviews (campaign_id, reviewer, outcome, checklist, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [input.campaignId, input.reviewer, input.outcome, JSON.stringify(input.checklist ?? {}), input.notes ?? ""],
    );
    if (input.outcome === "approved") {
      await client.query(`UPDATE managed_campaigns SET status = 'active' WHERE id = $1`, [input.campaignId]);
    } else if (input.outcome === "unsupported") {
      await client.query(`UPDATE managed_campaigns SET status = 'unmanaged' WHERE id = $1`, [input.campaignId]);
    }
    // changes_requested: leave status 'under_review' — no modification until the
    // customer approves (recordCustomerDecision).
    await client.query("COMMIT");
    return rowToReview(rows[0]);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// The customer's decision on a changes_requested review. Only an explicit
// approval moves the campaign to managed — the §11 no-modification-without-
// approval rule.
export async function recordCustomerDecision(
  pool: pg.Pool,
  reviewId: string,
  approved: boolean,
): Promise<CampaignReview | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE campaign_reviews
       SET customer_approved = $2, customer_approved_at = now()
       WHERE id = $1 RETURNING *`,
      [reviewId, approved],
    );
    const review = rows[0];
    if (review && approved && review.outcome === "changes_requested") {
      await client.query(`UPDATE managed_campaigns SET status = 'active' WHERE id = $1`, [review.campaign_id]);
    }
    await client.query("COMMIT");
    return review ? rowToReview(review) : null;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function getLatestReview(pool: pg.Pool, campaignId: string): Promise<CampaignReview | null> {
  const { rows } = await pool.query(
    `SELECT * FROM campaign_reviews WHERE campaign_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [campaignId],
  );
  return rows[0] ? rowToReview(rows[0]) : null;
}
