import type pg from "pg";

// AIC-67: incremental delta-review model for weekly lead quality (replaces
// the old "of your N leads this week, how many were relevant?" cumulative
// single value, which had no memory of what was already reviewed and forced
// the customer to do their own mental accounting — see migration 027 for the
// full rationale). `lead_quality_reviews` is an append-only event log;
// everything here is either a derived read (SUM) or a single INSERT, never
// an UPDATE — the watermark can only ever advance, which is what makes
// double-counting structurally impossible rather than merely avoided.

export interface LeadQualityStatus {
  reviewedSoFar: number; // all-time, from the watermark
  relevantSoFar: number; // all-time
  pending: number; // leads not yet reviewed — the delta to ask about next
  leadsThisWeek: number; // sum of leads_delta for reviews landed in the current calendar week
  relevantThisWeek: number;
}

// Monday-anchored calendar week (UTC) — the pre-AIC-67 weekly-key convention,
// kept for continuity with the historical lead_quality_feedback data this
// migrates forward. Deliberately distinct from readout's rolling 7-day
// window (scheduled-ingestion.ts's rollingPeriods), which answers a
// different question (period-over-period comparison, not "this calendar
// week").
export function mondayOf(d: Date): string {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = copy.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // days since Monday
  copy.setUTCDate(copy.getUTCDate() - diff);
  return copy.toISOString().slice(0, 10);
}

// `leadsToDate` is the caller's responsibility (all-time cumulative leads
// from insight_snapshots — see customer-overview.ts) so this module has no
// Meta/snapshot dependency of its own.
export async function getLeadQualityStatus(
  pool: pg.Pool,
  campaignId: string,
  leadsToDate: number,
  ref: Date = new Date(),
): Promise<LeadQualityStatus> {
  const watermark = await pool.query<{ leads: string | null; relevant: string | null }>(
    `SELECT COALESCE(SUM(leads_delta),0) AS leads, COALESCE(SUM(relevant_delta),0) AS relevant
     FROM lead_quality_reviews WHERE campaign_id = $1`,
    [campaignId],
  );
  const reviewedSoFar = Number(watermark.rows[0]?.leads ?? 0);
  const relevantSoFar = Number(watermark.rows[0]?.relevant ?? 0);

  const thisWeek = await pool.query<{ leads: string | null; relevant: string | null }>(
    `SELECT COALESCE(SUM(leads_delta),0) AS leads, COALESCE(SUM(relevant_delta),0) AS relevant
     FROM lead_quality_reviews WHERE campaign_id = $1 AND reviewed_at >= $2::date`,
    [campaignId, mondayOf(ref)],
  );

  return {
    reviewedSoFar,
    relevantSoFar,
    // Attribution-lag safe: leadsToDate can legitimately dip (Meta's
    // attribution window can revise a count downward after the fact) without
    // ever producing a negative pending count — it just reads as "caught up"
    // until the real total climbs back past the watermark.
    pending: Math.max(0, leadsToDate - reviewedSoFar),
    leadsThisWeek: Number(thisWeek.rows[0]?.leads ?? 0),
    relevantThisWeek: Number(thisWeek.rows[0]?.relevant ?? 0),
  };
}

export class LeadQualityValidationError extends Error {}

// Record one review action covering exactly `leadsDelta` new leads, of which
// `relevantDelta` were relevant. The CALLER computes leadsDelta server-side
// from the current watermark (see routes/app.ts) — never from a
// client-supplied number — so re-rating the same leads can't happen: the
// watermark only ever advances by what this function is told, and this
// function is only ever told the server's own computed pending count.
export async function recordLeadQualityReview(
  pool: pg.Pool,
  campaignId: string,
  input: { leadsDelta: number; relevantDelta: number },
): Promise<void> {
  const { leadsDelta, relevantDelta } = input;
  if (!Number.isInteger(leadsDelta) || leadsDelta <= 0) {
    throw new LeadQualityValidationError("nothing to review");
  }
  if (!Number.isInteger(relevantDelta) || relevantDelta < 0 || relevantDelta > leadsDelta) {
    throw new LeadQualityValidationError("relevant count must be between 0 and the pending count");
  }
  await pool.query(
    `INSERT INTO lead_quality_reviews (campaign_id, leads_delta, relevant_delta) VALUES ($1,$2,$3)`,
    [campaignId, leadsDelta, relevantDelta],
  );
}
