// Human audience labels (AIC-37). Never show a raw ad-set name or "ad set N" to
// the customer. Derive the label from what actually DIFFERS between a campaign's
// ad sets — age → "18–35"/"35–45", gender, or geo — falling back to the ad set's
// own Meta name only when nothing structured distinguishes them. One shared
// helper, reused by the customer details view, the explainer, and (later) the
// internal Meta explorer (AIC-45).

export interface RawAdSetMeta {
  id: string;
  name?: string | null;
  is_dynamic_creative?: boolean | null;
  effective_status?: string | null;
  targeting?: {
    age_min?: number;
    age_max?: number;
    genders?: number[]; // Meta: [1]=male, [2]=female, absent/both=all
    geo_locations?: {
      countries?: string[];
      cities?: Array<{ name?: string }>;
      regions?: Array<{ name?: string }>;
    };
  } | null;
}

export interface AdSetMeta {
  adSetId: string;
  name: string;
  ageMin: number | null;
  ageMax: number | null;
  genders: "all" | "male" | "female";
  geoSummary: string; // short joined place names, "" if account-default/none
  // Dynamic/Advantage+ creative (AIC-36): Meta mixes multiple assets per
  // impression and doesn't expose reliable per-asset CPL — pause_weak_creative
  // must skip these ad sets rather than compare unreliable "peers".
  isDynamicCreative: boolean;
  // AIC-63: whether a new ad added to this (already-existing) ad set would
  // actually deliver once approved, or whether the ad set itself is paused.
  status: "active" | "paused";
}

const GENDER_HE: Record<AdSetMeta["genders"], string> = {
  all: "כלל הקהל",
  male: "גברים",
  female: "נשים",
};

export function normalizeAdSetMeta(row: RawAdSetMeta): AdSetMeta {
  const t = row.targeting ?? {};
  const genders = t.genders ?? [];
  const gender: AdSetMeta["genders"] =
    genders.length === 1 && genders[0] === 1 ? "male" : genders.length === 1 && genders[0] === 2 ? "female" : "all";
  const places = [
    ...(t.geo_locations?.cities ?? []).map((c) => c.name).filter(Boolean),
    ...(t.geo_locations?.regions ?? []).map((r) => r.name).filter(Boolean),
    ...(t.geo_locations?.countries ?? []),
  ] as string[];
  return {
    adSetId: row.id,
    name: row.name ?? "",
    ageMin: t.age_min ?? null,
    ageMax: t.age_max ?? null,
    genders: gender,
    geoSummary: places.slice(0, 2).join(", "),
    isDynamicCreative: row.is_dynamic_creative === true,
    status: row.effective_status === "ACTIVE" ? "active" : "paused",
  };
}

// Derive one label per ad set: prefer the dimension that DIFFERS across the set
// (age, then gender, then geo); fall back to the ad set's own name when nothing
// structured distinguishes them (e.g. two ad sets that only differ by creative).
export function deriveAudienceLabels(adsets: AdSetMeta[]): Map<string, string> {
  const labels = new Map<string, string>();
  if (adsets.length === 0) return labels;

  const ages = new Set(adsets.map((a) => `${a.ageMin ?? ""}-${a.ageMax ?? ""}`));
  const genders = new Set(adsets.map((a) => a.genders));
  const geos = new Set(adsets.map((a) => a.geoSummary));

  for (const a of adsets) {
    if (ages.size > 1 && a.ageMin != null) {
      labels.set(a.adSetId, a.ageMax != null ? `${a.ageMin}–${a.ageMax}` : `${a.ageMin}+`);
    } else if (genders.size > 1) {
      labels.set(a.adSetId, GENDER_HE[a.genders]);
    } else if (geos.size > 1 && a.geoSummary) {
      labels.set(a.adSetId, a.geoSummary);
    } else {
      labels.set(a.adSetId, a.name || a.adSetId);
    }
  }
  return labels;
}
