import { localizePlace } from "./audience-label.js";

// AIC-184 — the full configuration behind one audience row.
//
// The dashboard already names an ad set ("נשים · 18–40 · רמת גן, גבעתיים"), but
// that label is a SUMMARY and deliberately capped at two places. A customer who
// wants to know exactly who they are paying to reach has nowhere to look — the
// ad rows are clickable and the audience row above them is not.
//
// Mirrors ad-detail.ts: a live read on open, never bulk-loaded, because this is
// text nobody asked to see until they ask.
//
// Placements matter most here and are the newest thing on the screen (AIC-177).
// "custom" is a real answer, not a fallback: an ad set built in Ads Manager can
// carry any combination, and claiming it matches one of our three would be a
// small confident lie about where the money is going.

export type AdSetPlacement = "advantage" | "instagram" | "facebook" | "custom";

export interface AdSetDetail {
  adSetId: string;
  name: string | null;
  ageMin: number | null;
  ageMax: number | null;
  genders: "all" | "male" | "female";
  /** Every place, uncapped and localized — the label above shows at most two. */
  places: string[];
  placement: AdSetPlacement;
  /** Null when the ad set draws from the campaign budget (CBO). */
  dailyBudgetAgorot: number | null;
  createdAt: string | null;
}

export interface RawAdSetDetail {
  id: string;
  name?: string | null;
  created_time?: string | null;
  daily_budget?: string | null;
  targeting?: {
    age_min?: number;
    age_max?: number;
    genders?: number[];
    publisher_platforms?: string[];
    geo_locations?: {
      cities?: Array<{ name?: string }>;
      regions?: Array<{ name?: string }>;
      countries?: string[];
    };
  } | null;
}

/**
 * Meta's genders array: absent or empty means everyone. Anything we do not
 * recognise is reported as "all" rather than guessed — the two named values
 * are claims about who is being paid for.
 */
function gendersOf(g?: number[]): "all" | "male" | "female" {
  if (!g || g.length !== 1) return "all";
  return g[0] === 1 ? "male" : g[0] === 2 ? "female" : "all";
}

/**
 * Absent `publisher_platforms` IS Advantage+ placements — supplying the field
 * at all is what turns it off (see publisherPlatforms in campaign-adapter).
 */
export function placementOf(platforms?: string[]): AdSetPlacement {
  if (!platforms || platforms.length === 0) return "advantage";
  if (platforms.length === 1 && platforms[0] === "instagram") return "instagram";
  if (platforms.length === 1 && platforms[0] === "facebook") return "facebook";
  return "custom";
}

export function normalizeAdSetDetail(raw: RawAdSetDetail): AdSetDetail {
  const t = raw.targeting ?? {};
  const geo = t.geo_locations ?? {};
  // Cities, then regions, then countries — most specific first, which is the
  // order the customer chose them in and the order that answers "where".
  const places = [
    ...(geo.cities ?? []).map((c) => c.name),
    ...(geo.regions ?? []).map((r) => r.name),
    ...(geo.countries ?? []),
  ]
    .filter((p): p is string => !!p && p.trim().length > 0)
    .map(localizePlace);

  return {
    adSetId: raw.id,
    name: raw.name ?? null,
    ageMin: t.age_min ?? null,
    ageMax: t.age_max ?? null,
    genders: gendersOf(t.genders),
    places,
    placement: placementOf(t.publisher_platforms),
    // Meta returns minor units as a string; absent means CBO, which is a
    // different fact from "zero" and must not collapse into it.
    dailyBudgetAgorot: raw.daily_budget == null ? null : Number(raw.daily_budget),
    createdAt: raw.created_time ?? null,
  };
}

export interface AdSetDetailReader {
  getAdSetDetail(metaAdSetId: string): Promise<AdSetDetail | null>;
}
