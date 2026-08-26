import type pg from "pg";
import { getCustomerProfileById, type CustomerProfile } from "./customer-profile.js";
import { summarizeProfile, type ProfileSummary } from "./profile-quality.js";
import { listAdMeta } from "./ad-meta-cache.js";
import { loadLeadQuality } from "./lead-quality-source.js";
import { classifyAngle, type Angle } from "./creative-angle.js";
import type { AdDetailReader } from "../meta/ad-detail.js";
import { RULE_THRESHOLDS } from "../recommendations/rules.js";

// AIC-78: everything an ad writer — a person today, a generator later — needs
// to write copy about THIS business rather than generic marketing filler.
//
// ASSEMBLED, NOT STORED. The ticket asks for a model per customer, and the
// temptation is a `creative_context` table. Almost none of this should live in
// one: the business facts are already columns on `customers` (migration 050,
// AIC-138), and the creative history is DERIVED — which the ticket demands in
// so many words ("derived from our own data, not re-entered by hand"). A table
// would be a second copy of both, immediately able to disagree with them.
//
// The one genuinely new thing is the ANGLE each ad takes, and even that is read
// out of the copy rather than stored, so it stays true for ads created before
// this existed and for ads an operator built directly in Ads Manager.

export interface PastAd {
  adId: string;
  name: string | null;
  headline: string | null;
  primaryText: string | null;
  // Null when the copy commits to no clear angle — see creative-angle.ts.
  angle: Angle | null;
  // How safely that was decided. `weak` is a real answer resting on thin
  // evidence — carried so a consumer can weigh it rather than treating every
  // label as equally solid.
  angleConfidence: "clear" | "weak";
  angles: Angle[];
  // Its own performance, where we have it. Null means it has no snapshot rows
  // yet (a brand-new ad), NOT that it performed at zero.
  spendAgorot: number | null;
  leads: number | null;
  cplAgorot: number | null;
  // AIC-133, where the customer's reviews attribute cleanly to this ad alone.
  relevantRate: number | null;
  costPerRelevantAgorot: number | null;
  // An ad built from an existing Page post carries no copy of ours to learn
  // from — the post IS the creative.
  fromExistingPost: boolean;
}

// An angle, with the evidence behind it.
//
// THE DISTINCTION THIS TYPE EXISTS FOR. Four ads that between them spent ₪26
// and returned no leads have not TESTED anything — zero leads is the expected
// outcome at that spend, not a result. Calling that angle "tried" and excluding
// it from future proposals would rule it out on no evidence, permanently.
//
// So an angle is only `tested` once the ads carrying it clear the same spend
// bar the engine already uses before it will judge a creative
// (MIN_CREATIVE_SPEND_AGOROT, ₪150). Below that it is `attempted`, and every
// surface says so rather than implying a verdict.
export interface AngleRecord {
  angle: Angle;
  adCount: number;
  spendAgorot: number;
  leads: number;
  state: "tested" | "attempted";
  // How many of the ads behind this angle were classified with confidence. An
  // angle carried by four ads, three of them weakly read, is not the same
  // claim as one carried by four clear ones.
  clearAdCount: number;
}

export interface CreativeContext {
  business: CustomerProfile;
  // AIC-132's verdict on whether the business half is worth anything yet. A
  // context assembled from blank fields must SAY it is thin rather than hand
  // back a confident-looking object full of empty strings.
  businessQuality: ProfileSummary;
  pastAds: PastAd[];
  // Angles the copy already ran, best-performing first where we can rank, each
  // carrying the spend behind it. A FLOOR, never a census — see
  // `unclassifiedAds`.
  angles: AngleRecord[];
  // How many ads we could not read an angle out of. Without this number,
  // "we tried price" reads as "we tried everything except price".
  unclassifiedAds: number;
  // How many of the campaign's ads we managed to read copy for at all. A Meta
  // read that partly failed must not look like a customer who has run fewer
  // ads than they have.
  adsRead: number;
  adsTotal: number;
  // Set only when EVERY classified ad takes the same angle and there are at
  // least two of them. This is the single most useful thing on the panel: four
  // ads that all argue price are not four tests — and it was true on two of the
  // three real accounts the first time this ran. Null when the ads genuinely
  // vary, or when there is too little to say so.
  //
  // It is a statement about VARIETY, which is why it holds regardless of spend.
  // Whether that one angle has actually been judged is a separate question, and
  // `angles` carries the answer: with ₪26 behind it, the honest line is "every
  // ad argues price AND none of them has had enough budget to know".
  singleAngle: Angle | null;
  // Reserved for the P1 market-intelligence work (AIC-81/82). Explicitly null
  // rather than absent, so a consumer can tell "not built yet" from "nothing
  // found" once it is.
  market: null;
}

// Reading every ad's copy is one live Meta call each. Bounded because this runs
// on a page load: the newest ads are the ones worth learning from, and a
// customer with 40 ads does not need 40 round-trips to be told what they tried.
const MAX_ADS_READ = 8;

const EMPTY_PROFILE: CustomerProfile = {
  businessName: "", category: "", mainService: "", geoArea: "", primaryCustomer: "",
  offer: "", differentiators: "", objections: "", priceRange: "", copyConstraints: "",
  leadFollowup: "", contactName: "", contactPhone: "", contactEmail: "",
};

export async function buildCreativeContext(
  pool: pg.Pool,
  reader: AdDetailReader | null,
  customerId: string,
  campaignId: string | null,
): Promise<CreativeContext> {
  // Null only if the customer row vanished mid-request; an empty profile is a
  // blank object, which summarizeProfile then correctly calls `broken`.
  const business = (await getCustomerProfileById(pool, customerId)) ?? EMPTY_PROFILE;
  const businessQuality = summarizeProfile(business);

  if (!campaignId) {
    return {
      business, businessQuality, pastAds: [], angles: [],
      unclassifiedAds: 0, adsRead: 0, adsTotal: 0, singleAngle: null, market: null,
    };
  }

  const [ads, stats, quality] = await Promise.all([
    listAdMeta(pool, campaignId),
    adTotals(pool, campaignId),
    loadLeadQuality(pool, campaignId, "creative").then((q) => q.byAdSet).catch(() => new Map()),
  ]);

  // Gone ads still count: an ad that was archived last month is exactly the
  // history worth remembering, and hiding it would re-suggest what failed.
  const live = ads.slice(0, MAX_ADS_READ);
  const details = reader
    ? await Promise.all(
        live.map((a) =>
          reader.getAdDetail(a.adId).catch(() => null),
        ),
      )
    : [];

  const pastAds: PastAd[] = [];
  for (let i = 0; i < live.length; i++) {
    const d = details[i];
    // A failed read drops the ad entirely rather than inventing a blank one.
    // It is visible as adsRead < adsTotal, never as an ad that has no copy.
    if (!d) continue;
    const v = classifyAngle(d.headline, d.primaryText);
    const s = stats.get(d.adId);
    const q = quality.get(d.adId);
    pastAds.push({
      adId: d.adId,
      name: d.name ?? live[i].name,
      headline: d.headline,
      primaryText: d.primaryText,
      angle: v.angle,
      angleConfidence: v.confidence,
      angles: v.all,
      spendAgorot: s?.spendAgorot ?? null,
      leads: s?.leads ?? null,
      cplAgorot: s?.cplAgorot ?? null,
      relevantRate: q?.relevantRate ?? null,
      costPerRelevantAgorot: q?.costPerRelevantAgorot ?? null,
      fromExistingPost: d.fromExistingPost,
    });
  }

  const { angles, singleAngle, unclassifiedAds } = summarizeAngles(pastAds);

  return {
    business,
    businessQuality,
    pastAds,
    angles,
    singleAngle,
    unclassifiedAds,
    adsRead: pastAds.length,
    adsTotal: ads.length,
    market: null,
  };
}

/**
 * The angle picture, pure — everything the panel says about what was tried.
 * Separated from the DB/Meta assembly above so it can be tested on shapes that
 * would take a live account to produce.
 */
export function summarizeAngles(
  pastAds: readonly PastAd[],
  minSpendAgorot: number = RULE_THRESHOLDS.MIN_CREATIVE_SPEND_AGOROT,
): {
  angles: AngleRecord[];
  singleAngle: Angle | null;
  unclassifiedAds: number;
} {
  // Ranked by what the ad actually did: cheapest cost per lead first, ads with
  // no spend last. An angle that was "tried" on an ad that never delivered was
  // not really tried, and ordering says so without throwing it away.
  const ranked = [...pastAds].sort((a, b) => cost(a) - cost(b));
  const order: Angle[] = [];
  const totals = new Map<Angle, { adCount: number; spendAgorot: number; leads: number; clearAdCount: number }>();
  for (const ad of ranked) {
    for (const a of ad.angles) {
      if (!order.includes(a)) order.push(a);
      const t = totals.get(a) ?? { adCount: 0, spendAgorot: 0, leads: 0, clearAdCount: 0 };
      t.adCount++;
      if (ad.angleConfidence === "clear") t.clearAdCount++;
      t.spendAgorot += ad.spendAgorot ?? 0;
      t.leads += ad.leads ?? 0;
      totals.set(a, t);
    }
  }
  // Spend is summed across every ad carrying the angle: three ads at ₪60 each
  // is a real test of the angle even though no single ad clears the bar alone.
  const angles: AngleRecord[] = order.map((angle) => {
    const t = totals.get(angle)!;
    return { angle, ...t, state: t.spendAgorot >= minSpendAgorot ? "tested" : "attempted" };
  });

  // Judged on the ads we could actually classify — an unreadable ad is not
  // evidence of variety any more than it is evidence of sameness.
  const classified = pastAds.filter((a) => a.angle !== null);
  const singleAngle =
    classified.length >= 2 && classified.every((a) => a.angle === classified[0].angle)
      ? classified[0].angle
      : null;

  return {
    angles,
    singleAngle,
    // Counts every ad with TEXT we could not read an angle out of. An ad built
    // from an existing post still has copy that ran — we just didn't write it —
    // so it belongs in this count; only an ad with no text at all is excluded,
    // because there was nothing to classify.
    unclassifiedAds: pastAds.filter((a) => a.angle === null && !!(a.headline || a.primaryText)).length,
  };
}

// An ad with no leads sorts after every ad that has some, and an ad that never
// spent at all sorts last of all — "no result" and "bad result" are different.
function cost(a: PastAd): number {
  if (a.cplAgorot !== null) return a.cplAgorot;
  return a.spendAgorot ? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER;
}

/**
 * Everything each ad has spent and produced, summed over the per-day rows.
 *
 * NOT `store.creativeStats`, which looks lifetime-ish but returns each ad's
 * most recent 7-day ROLLING row — the right answer for "how is this ad doing
 * now", the wrong one for "has this angle ever had a fair test". Using it here
 * would have judged an angle on one week of a campaign's life.
 *
 * Summed over `insight_snapshot_daily`, never the raw table, which mixes
 * per-day rows with overlapping rolling ones and would double-count
 * (migration 030). The daily rows are retained for DAILY_LOOKBACK_DAYS, so
 * this is "the last 45 days", not all time — an older campaign's earliest
 * spend is not counted, which can only ever make the evidence bar HARDER to
 * clear, never easier.
 */
async function adTotals(
  pool: pg.Pool,
  campaignId: string,
): Promise<Map<string, { spendAgorot: number; leads: number; cplAgorot: number | null }>> {
  const { rows } = await pool.query<{ meta_object_id: string; spend: string; leads: string }>(
    `SELECT meta_object_id, SUM(spend_agorot)::int AS spend, SUM(leads)::int AS leads
       FROM insight_snapshot_daily
      WHERE campaign_id = $1 AND grain = 'creative'
      GROUP BY meta_object_id`,
    [campaignId],
  );
  return new Map(
    rows.map((r) => {
      const spendAgorot = Number(r.spend);
      const leads = Number(r.leads);
      return [r.meta_object_id, { spendAgorot, leads, cplAgorot: leads > 0 ? Math.round(spendAgorot / leads) : null }];
    }),
  );
}

// ── The operator's copy of it ────────────────────────────────────────────────
//
// Sent to the ops Telegram channel when a customer opens the create-ad screen.
// The reason to want it there: at that exact moment someone is about to write
// an ad, and this is when a human can help — "all four of your ads run the
// same angle" is worth saying before the fifth one is written, not after.

// Cut on a word boundary where there is one nearby — a field that stops
// mid-word reads as corrupted data rather than as a deliberate summary.
function ellipsis(raw: string, max: number): string {
  // Collapse the newlines first: ad copy is multi-line, and a raw \n inside a
  // Telegram bullet breaks the list into what looks like two entries.
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max - 25 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function describeCreativeContext(
  ctx: CreativeContext,
  who: { businessName: string; email?: string | null },
): string {
  const L: string[] = [];
  L.push(`📝 ${who.businessName || "(no business name)"} opened the create-ad screen`);
  if (who.email) L.push(`   ${who.email}`);
  L.push("");

  // The business half first, because it is the half a human can fix on a phone
  // call — and AIC-132 already knows whether it is worth anything.
  const q = ctx.businessQuality;
  const flag = q.state === "ok" ? "✅" : q.state === "thin" ? "⚠️" : "❌";
  L.push(`${flag} Business profile: ${q.state}${q.reason ? ` — ${q.reason}` : ""}`);
  const b = ctx.business;
  for (const [label, value] of [
    // Who it is for comes FIRST: copy written without knowing the audience is
    // guessing, and this was missing from the first version.
    ["Audience", b.primaryCustomer], ["Area", b.geoArea], ["Service", b.mainService],
    ["Offer", b.offer], ["Differentiators", b.differentiators], ["Objections", b.objections],
    ["Price", b.priceRange], ["Constraints", b.copyConstraints],
  ] as const) {
    // Truncated for the MESSAGE ONLY — Telegram caps at ~4k and eight full
    // fields would blow it. The API response and the on-screen panel carry the
    // complete text, and so would any generator reading this model.
    if (value.trim()) L.push(`   ${label}: ${ellipsis(value.trim(), 160)}`);
  }
  L.push("");

  if (ctx.adsTotal === 0) {
    L.push("No previous ads — nothing tried yet.");
    return L.join("\n").slice(0, 3800);
  }

  // "Angles tried" is a floor, and says so. A count of what we could not read
  // is the difference between a fact and a claim.
  if (ctx.angles.length === 0) {
    L.push("🎯 Angles already tried: (none readable)");
  } else {
    L.push("🎯 Angles already tried:");
    for (const a of ctx.angles) {
      const spend = `₪${(a.spendAgorot / 100).toFixed(0)}`;
      // "attempted" is not a softer word for "failed" — it means we do not
      // know. Spelling out the spend is what makes that checkable.
      // Flag when the angle's own label is shaky, so a thin reading cannot be
      // mistaken for a firm one.
      const weak = a.clearAdCount < a.adCount ? ` · ${a.adCount - a.clearAdCount} weakly classified` : "";
      L.push(
        a.state === "tested"
          ? `   • ${a.angle} — ${a.adCount} ad(s) · ${spend} · ${a.leads} leads${weak}`
          : `   • ${a.angle} — ATTEMPTED, not judged (${a.adCount} ad(s) · only ${spend})${weak}`,
      );
    }
  }
  if (ctx.singleAngle) {
    const rec = ctx.angles.find((a) => a.angle === ctx.singleAngle);
    L.push(
      rec?.state === "tested"
        // Name the number of ads the claim rests on. "every readable ad" over
        // two ads is a much weaker statement than over eight, and the reader
        // cannot tell which without being told.
        ? `   ⚠️ All ${rec.adCount} readable ad(s) argue "${ctx.singleAngle}" — one angle run ${rec.adCount} times, not ${rec.adCount} tests.`
        : `   ⚠️ All ${rec?.adCount ?? 0} readable ad(s) argue "${ctx.singleAngle}", and it has NOT had enough spend to judge. Nothing here has been ruled out.`,
    );
  }
  if (ctx.unclassifiedAds > 0) L.push(`   (${ctx.unclassifiedAds} ad(s) took no clear angle)`);
  if (ctx.adsRead < ctx.adsTotal) L.push(`   (read ${ctx.adsRead} of ${ctx.adsTotal} ads)`);
  L.push("");

  for (const a of ctx.pastAds) {
    const perf = a.leads === null
      ? "no data yet"
      : `${a.leads} leads · ${a.spendAgorot !== null ? `₪${(a.spendAgorot / 100).toFixed(0)}` : "?"}${
          a.cplAgorot !== null ? ` · ₪${(a.cplAgorot / 100).toFixed(0)}/lead` : ""
        }`;
    // Show the COPY, falling back to the body when an ad has no headline —
    // printing the internal ad name ("מודעה 1") made a classified ad look
    // like one we could not read, which is a different and much worse claim.
    const shown = a.headline ?? (a.primaryText ? ellipsis(a.primaryText, 70) : null) ?? a.name ?? a.adId;
    const tag = a.angle ? `${a.angle}${a.angleConfidence === "weak" ? "?" : ""}` : "?";
    L.push(`• [${tag}] ${shown} — ${perf}`);
  }
  return L.join("\n").slice(0, 3800);
}
