import type { Placement } from "@aic/shared";

// AIC-185 — editing an ad set's audience from the customer's own dashboard.
//
// Two things make this harder than it looks, and both were learned the
// expensive way on 2026-09-02.
//
// FIRST: Meta REPLACES `targeting` wholesale on update. Sending only the field
// you changed silently wipes everything else — Advantage+ settings, brand
// safety levels, geo. So an edit is necessarily read-modify-write, and the
// merge has to preserve keys this code has never heard of.
//
// SECOND: a write Meta answers 200 to is not a write Meta applied. Sending
// age 20–35 came back as 18–65; the discrepancy was only visible because
// something read it back afterwards. Every edit here re-reads and compares
// what was ASKED against what was STORED.

export interface AdSetPatch {
  name?: string;
  ageMin?: number;
  ageMax?: number;
  genders?: "all" | "male" | "female";
  placement?: Placement;
  cities?: Array<{ key: string; name: string; type: "city" | "region" }>;
}

export type PatchProblem =
  | "empty_name"
  | "age_out_of_range"
  | "age_inverted"
  | "nothing_to_change";

/**
 * Meta's own bounds, refused here rather than by a 400 mid-write. 13 and 65
 * are Meta's floor and ceiling; 65 means "65+".
 */
export function validateAdSetPatch(patch: AdSetPatch): PatchProblem | null {
  const touched =
    patch.name !== undefined || patch.ageMin !== undefined || patch.ageMax !== undefined ||
    patch.genders !== undefined || patch.placement !== undefined || patch.cities !== undefined;
  if (!touched) return "nothing_to_change";

  if (patch.name !== undefined && patch.name.trim().length === 0) return "empty_name";

  const min = patch.ageMin;
  const max = patch.ageMax;
  if (min !== undefined && (!Number.isInteger(min) || min < 13 || min > 65)) return "age_out_of_range";
  if (max !== undefined && (!Number.isInteger(max) || max < 13 || max > 65)) return "age_out_of_range";
  // Both are always sent together by the UI; if only one arrives, the other
  // side of the comparison is unknown and the range cannot be checked here.
  if (min !== undefined && max !== undefined && max <= min) return "age_inverted";

  return null;
}

const GENDER_CODES: Record<"all" | "male" | "female", number[]> = {
  all: [], male: [1], female: [2],
};

/**
 * The full targeting object to send: everything Meta currently has, with only
 * the patched keys replaced.
 *
 * SPREADS THE CURRENT OBJECT FIRST, deliberately. `targeting_automation`,
 * `brand_safety_content_filter_levels`, `user_age_unknown` and anything Meta
 * adds next year all survive because they are copied rather than enumerated.
 * Rebuilding targeting from a known field list is how an edit quietly turns
 * off a setting nobody was talking about.
 *
 * `age_range` is dropped when ages change: it is Meta's derived echo of the
 * configured range, and sending a stale one alongside a new age_min/age_max
 * asks for two different answers to the same question.
 */
export function mergeTargeting(current: Record<string, unknown>, patch: AdSetPatch): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };

  if (patch.ageMin !== undefined) next.age_min = patch.ageMin;
  if (patch.ageMax !== undefined) next.age_max = patch.ageMax;
  if (patch.ageMin !== undefined || patch.ageMax !== undefined) delete next.age_range;

  if (patch.genders !== undefined) next.genders = GENDER_CODES[patch.genders];

  if (patch.placement !== undefined) {
    // The absence of publisher_platforms IS Advantage+ placements — supplying
    // the key at all is what turns it off (AIC-177). So "advantage" must
    // DELETE the key, never send an empty array.
    if (patch.placement === "advantage") delete next.publisher_platforms;
    else next.publisher_platforms = [patch.placement];
  }

  if (patch.cities !== undefined) {
    const geo = { ...((current.geo_locations as Record<string, unknown>) ?? {}) };
    if (patch.cities.length === 0) {
      // Nationwide. Cities and regions REPLACE countries rather than joining
      // them (AIC-157), so clearing the list has to restore the country.
      delete geo.cities;
      delete geo.regions;
      geo.countries = ["IL"];
    } else {
      delete geo.countries;
      geo.cities = patch.cities.filter((c) => c.type === "city").map((c) => ({ key: c.key }));
      geo.regions = patch.cities.filter((c) => c.type === "region").map((c) => ({ key: c.key }));
      if ((geo.cities as unknown[]).length === 0) delete geo.cities;
      if ((geo.regions as unknown[]).length === 0) delete geo.regions;
    }
    next.geo_locations = geo;
  }

  return next;
}

export interface StoredComparison {
  field: string;
  asked: string;
  stored: string;
}

/**
 * What Meta stored that we did not ask for — empty when the edit applied.
 *
 * Only the patched fields are compared. Meta legitimately normalizes things we
 * did not touch (and, when age or gender changes, switches its own automatic
 * expansion off), and reporting those as failures would make every successful
 * edit look broken.
 */
export function diffApplied(patch: AdSetPatch, stored: {
  name: string | null; ageMin: number | null; ageMax: number | null;
  genders: "all" | "male" | "female"; placement: string;
}): StoredComparison[] {
  const out: StoredComparison[] = [];
  const cmp = (field: string, asked: unknown, got: unknown) => {
    if (asked === undefined) return;
    if (String(asked) !== String(got)) out.push({ field, asked: String(asked), stored: String(got) });
  };
  cmp("name", patch.name?.trim(), stored.name);
  cmp("ageMin", patch.ageMin, stored.ageMin);
  cmp("ageMax", patch.ageMax, stored.ageMax);
  cmp("genders", patch.genders, stored.genders);
  cmp("placement", patch.placement, stored.placement);
  return out;
}
