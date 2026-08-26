import type pg from "pg";
import { getCustomerProfileById, type CustomerProfile } from "./customer-profile.js";
import { summarizeProfile, type ProfileSummary } from "./profile-quality.js";
import { listAdMeta } from "./ad-meta-cache.js";
import { loadLeadQuality } from "./lead-quality-source.js";
import { classifyAngle, type Angle } from "./creative-angle.js";
import { PgSnapshotStore } from "../meta/snapshot-store.js";
import type { AdDetailReader } from "../meta/ad-detail.js";

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

export interface CreativeContext {
  business: CustomerProfile;
  // AIC-132's verdict on whether the business half is worth anything yet. A
  // context assembled from blank fields must SAY it is thin rather than hand
  // back a confident-looking object full of empty strings.
  businessQuality: ProfileSummary;
  pastAds: PastAd[];
  // Angles the copy already ran, best-performing first where we can rank.
  // A FLOOR, never a census — see `unclassifiedAds`.
  anglesTested: Angle[];
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
  // ads that all argue price are not four tests, they are one test run four
  // times — and it was true on two of the three real accounts the first time
  // this ran. Null when the ads genuinely vary, or when there is too little to
  // say so.
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
      business, businessQuality, pastAds: [], anglesTested: [],
      unclassifiedAds: 0, adsRead: 0, adsTotal: 0, singleAngle: null, market: null,
    };
  }

  const store = new PgSnapshotStore(pool);
  // The ad's standing over the engine's own window — the same figures the
  // dashboard shows, so the context can never quietly rank ads differently
  // from the screen the customer just came from.
  const [ads, stats, quality] = await Promise.all([
    listAdMeta(pool, campaignId),
    lifetimeCreativeStats(store, campaignId),
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
      angles: v.all,
      spendAgorot: s?.spendAgorot ?? null,
      leads: s?.leads ?? null,
      cplAgorot: s?.cplAgorot ?? null,
      relevantRate: q?.relevantRate ?? null,
      costPerRelevantAgorot: q?.costPerRelevantAgorot ?? null,
      fromExistingPost: d.fromExistingPost,
    });
  }

  const { anglesTested, singleAngle, unclassifiedAds } = summarizeAngles(pastAds);

  return {
    business,
    businessQuality,
    pastAds,
    anglesTested,
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
export function summarizeAngles(pastAds: readonly PastAd[]): {
  anglesTested: Angle[];
  singleAngle: Angle | null;
  unclassifiedAds: number;
} {
  // Ranked by what the ad actually did: cheapest cost per lead first, ads with
  // no spend last. An angle that was "tried" on an ad that never delivered was
  // not really tried, and ordering says so without throwing it away.
  const ranked = [...pastAds].sort((a, b) => cost(a) - cost(b));
  const anglesTested: Angle[] = [];
  for (const ad of ranked) {
    for (const a of ad.angles) if (!anglesTested.includes(a)) anglesTested.push(a);
  }

  // Judged on the ads we could actually classify — an unreadable ad is not
  // evidence of variety any more than it is evidence of sameness.
  const classified = pastAds.filter((a) => a.angle !== null);
  const singleAngle =
    classified.length >= 2 && classified.every((a) => a.angle === classified[0].angle)
      ? classified[0].angle
      : null;

  return {
    anglesTested,
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

// Per-ad standing over a wide window. Uses the ad-grain rows rather than the
// creative-grain ones because `getAdDetail` is keyed by AD id, and mixing the
// two keys is how a join silently returns nothing.
async function lifetimeCreativeStats(
  store: PgSnapshotStore,
  campaignId: string,
): Promise<Map<string, { spendAgorot: number; leads: number; cplAgorot: number | null }>> {
  const end = new Date().toISOString().slice(0, 10);
  const rows = await store.creativeStats(campaignId, "1970-01-01", end);
  return new Map(rows.map((r) => [r.metaObjectId, { spendAgorot: r.spendAgorot, leads: r.leads, cplAgorot: r.cplAgorot }]));
}

// ── The operator's copy of it ────────────────────────────────────────────────
//
// Sent to the ops Telegram channel when a customer opens the create-ad screen.
// The reason to want it there: at that exact moment someone is about to write
// an ad, and this is when a human can help — "all four of your ads run the
// same angle" is worth saying before the fifth one is written, not after.

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
    ["Offer", b.offer], ["Differentiators", b.differentiators], ["Objections", b.objections],
    ["Price", b.priceRange], ["Constraints", b.copyConstraints],
  ] as const) {
    if (value.trim()) L.push(`   ${label}: ${value.trim().slice(0, 160)}`);
  }
  L.push("");

  if (ctx.adsTotal === 0) {
    L.push("No previous ads — nothing tried yet.");
    return L.join("\n").slice(0, 3800);
  }

  // "Angles tried" is a floor, and says so. A count of what we could not read
  // is the difference between a fact and a claim.
  L.push(`🎯 Angles already tried: ${ctx.anglesTested.join(", ") || "(none readable)"}`);
  if (ctx.singleAngle) L.push(`   ⚠️ EVERY readable ad argues "${ctx.singleAngle}" — one test run ${ctx.pastAds.filter((a) => a.angle !== null).length} times, not ${ctx.pastAds.filter((a) => a.angle !== null).length} tests.`);
  if (ctx.unclassifiedAds > 0) L.push(`   (${ctx.unclassifiedAds} ad(s) took no clear angle)`);
  if (ctx.adsRead < ctx.adsTotal) L.push(`   (read ${ctx.adsRead} of ${ctx.adsTotal} ads)`);
  L.push("");

  for (const a of ctx.pastAds) {
    const perf = a.leads === null
      ? "no data yet"
      : `${a.leads} leads · ${a.spendAgorot !== null ? `₪${(a.spendAgorot / 100).toFixed(0)}` : "?"}${
          a.cplAgorot !== null ? ` · ₪${(a.cplAgorot / 100).toFixed(0)}/lead` : ""
        }`;
    L.push(`• [${a.angle ?? "?"}] ${a.headline ?? a.name ?? a.adId} — ${perf}`);
  }
  return L.join("\n").slice(0, 3800);
}
