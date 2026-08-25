// AIC-133: which audience produced the GOOD leads?
//
// AIC-67 already asks "how many of these were relevant" and gets a real answer.
// It is used only in aggregate, never crossed with the audience that produced
// them — so the engine optimises toward whatever is cheapest, and cheap leads
// are very often the wrong leads:
//
//   Audience A:  12 leads · ₪22 CPL · 2 relevant  →  ₪132 per REAL lead
//   Audience B:   6 leads · ₪48 CPL · 5 relevant  →  ₪58  per REAL lead
//
// Today the engine keeps A and may pause B, while every number on screen
// improves. That is not a missing feature; it is a rule actively making the
// campaign worse.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY MOST REVIEWS CANNOT BE ATTRIBUTED, AND WHY WE DON'T PRETEND OTHERWISE
//
// A review covers a WINDOW — the leads accumulated since the previous review —
// and the customer answers for the whole campaign. If two audiences were
// delivering in that window, nothing in the answer says which produced the
// relevant ones.
//
// The obvious move is to apportion the relevant count in proportion to each
// audience's share of the leads. THAT IS WORSE THAN USELESS. Splitting
// proportionally gives every audience the SAME relevance rate, so
// cost-per-relevant-lead becomes CPL multiplied by a constant — it reorders
// nothing, while looking like quality data and carrying a quality label. The
// engine would make exactly the same wrong decision, now with a confident
// justification attached.
//
// So attribution here is deliberately narrow: a review is attributable only
// when ONE audience produced all the leads in its window. Those windows are
// common in practice (a campaign usually has one audience live at a time, and
// paused audiences produce nothing), and they are the only ones that carry
// real information. Everything else is recorded as unattributable and left out
// of the judgement rather than being softened into a guess.

export interface LeadQualityReview {
  id: string;
  createdAt: Date;
  leadsDelta: number;
  relevantDelta: number;
}

/** Leads produced by one ad set inside one review window. */
export interface WindowLeads {
  adSetId: string;
  leads: number;
}

export type AttributionBasis = "sole_source" | "unattributable";

export interface AdSetQuality {
  adSetId: string;
  // Leads covered by reviews we could attribute to this ad set.
  reviewedLeads: number;
  relevantLeads: number;
  // How many distinct reviews contributed. One noisy answer is weak evidence;
  // a consistent pattern across several is strong.
  reviewCount: number;
}

export interface AttributionResult {
  byAdSet: Map<string, AdSetQuality>;
  attributed: number;
  unattributable: number;
}

/**
 * Attribute reviews to ad sets.
 *
 * `windowLeadsFor(review)` returns the per-ad-set lead counts inside that
 * review's window — the caller owns the window arithmetic and the snapshot
 * read, so this stays a pure function that can be tested on its own.
 */
export function attributeLeadQuality(
  reviews: readonly LeadQualityReview[],
  windowLeadsFor: (review: LeadQualityReview) => readonly WindowLeads[],
): AttributionResult {
  const byAdSet = new Map<string, AdSetQuality>();
  let attributed = 0;
  let unattributable = 0;

  for (const review of reviews) {
    const producing = windowLeadsFor(review).filter((w) => w.leads > 0);

    // Zero producers means the review's leads predate the snapshots we hold,
    // or the window is empty. Not attributable, and not an error.
    if (producing.length !== 1) {
      unattributable++;
      continue;
    }

    const sole = producing[0];
    const entry = byAdSet.get(sole.adSetId) ?? {
      adSetId: sole.adSetId, reviewedLeads: 0, relevantLeads: 0, reviewCount: 0,
    };
    entry.reviewedLeads += review.leadsDelta;
    entry.relevantLeads += review.relevantDelta;
    entry.reviewCount += 1;
    byAdSet.set(sole.adSetId, entry);
    attributed++;
  }

  return { byAdSet, attributed, unattributable };
}

// The minimum before quality may OVERRIDE cost. Two answers is not a basis for
// pausing an audience: customers estimate, they forget, they answer while busy,
// and a single divergent period is noise. Reusing the shape of the existing
// evidence gates rather than inventing a new kind of threshold.
export const MIN_QUALITY_REVIEWS = 2;
export const MIN_QUALITY_LEADS = 5;

export interface QualityVerdict {
  usable: boolean;
  // Cost per RELEVANT lead, in agorot. Null when unusable, or when the ad set
  // produced no relevant leads at all — a divide-by-zero that would otherwise
  // read as "infinitely expensive" and always win a comparison.
  costPerRelevantAgorot: number | null;
  relevantRate: number | null;
  reviewCount: number;
}

/**
 * Is this ad set's quality data good enough to act on, and what does it say?
 *
 * Never replaces CPL — the caller decides, and must SAY which basis it used.
 * "Based on relevant leads" and "based on lead volume" are different claims
 * and the customer is approving one of them.
 */
export function qualityVerdict(quality: AdSetQuality | undefined, spendAgorot: number): QualityVerdict {
  if (!quality || quality.reviewCount < MIN_QUALITY_REVIEWS || quality.reviewedLeads < MIN_QUALITY_LEADS) {
    return { usable: false, costPerRelevantAgorot: null, relevantRate: null, reviewCount: quality?.reviewCount ?? 0 };
  }
  const rate = quality.reviewedLeads > 0 ? quality.relevantLeads / quality.reviewedLeads : null;
  // Zero relevant leads is a real and important finding — an audience sending
  // nothing but junk — but it has no finite cost-per-relevant-lead. Reported
  // as a rate of 0 with a null cost, so a caller compares rates rather than
  // silently treating Infinity as a number.
  const cost = quality.relevantLeads > 0 ? Math.round(spendAgorot / quality.relevantLeads) : null;
  return { usable: true, costPerRelevantAgorot: cost, relevantRate: rate, reviewCount: quality.reviewCount };
}
