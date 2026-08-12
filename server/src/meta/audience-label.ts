// Human audience labels (AIC-37, corrected AIC-73). Never show a raw ad-set
// name or "ad set N" to the customer. One shared helper, reused by the
// customer details view, the explainer, and (later) the internal Meta
// explorer (AIC-45).

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
  // AIC-65: at least one ad, requested as ads.limit(1){id} — the cheapest way
  // to tell "a never-published draft" from a real ad set without a full count.
  ads?: { data?: Array<{ id: string }> } | null;
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
  // AIC-65: false for a deleted/archived ad set, or a never-published draft
  // with zero ads — a real GelNails case: `effective_status` still reports
  // ACTIVE (Meta doesn't always reclassify a deleted ad set), but it has no
  // ads and can't deliver. Callers must exclude these everywhere: counts,
  // labels, delivery-health, the audience rule, the customer dashboard.
  isManaged: boolean;
}

function isDeletedOrArchived(status?: string | null): boolean {
  return status === "DELETED" || status === "ARCHIVED";
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
  // A "no ads" signal only counts when the field was actually requested and
  // returned an empty list — if `ads` is absent entirely, we don't know
  // either way, so don't penalize (never falsely exclude a real ad set just
  // because a caller didn't ask for this field).
  const isDraftWithNoAds = row.ads != null && (row.ads.data?.length ?? 0) === 0;
  return {
    adSetId: row.id,
    name: row.name ?? "",
    ageMin: t.age_min ?? null,
    ageMax: t.age_max ?? null,
    genders: gender,
    geoSummary: places.slice(0, 2).join(", "),
    isDynamicCreative: row.is_dynamic_creative === true,
    status: row.effective_status === "ACTIVE" ? "active" : "paused",
    isManaged: !isDeletedOrArchived(row.effective_status) && !isDraftWithNoAds,
  };
}

// No structured targeting at all (a broad/Advantage+ audience with no
// age/gender/geo set) — the only true fallback. Never the raw ad-set name
// (AIC-73: the previous "fall back to the name when siblings don't differ"
// rule broke on the single-ad-set account, the MOST common shape for a small
// business — with nothing to differ from, every real account hit this
// fallback and leaked "IL | Ramat Gan, Givatayim | Women 18-46 | Advantage+"
// straight to the customer).
const GENERIC_AUDIENCE_LABEL = "קהל כללי";

// Derive one label per ad set by composing ITS OWN structured targeting —
// gender (when not "all"), age range, geo — never conditioned on whether a
// sibling ad set differs. A campaign's single ad set now gets an honest label
// like "נשים · 18–46 · תל אביב" instead of falling through to the Meta name.
// If two ad sets end up with the identical composed label (same targeting,
// only creative differs), a running "(2)", "(3)" suffix disambiguates them —
// still never the raw name.
export function deriveAudienceLabels(adsets: AdSetMeta[]): Map<string, string> {
  const labels = new Map<string, string>();
  const seen = new Map<string, number>();

  for (const a of adsets) {
    const parts: string[] = [];
    if (a.genders !== "all") parts.push(GENDER_HE[a.genders]);
    if (a.ageMin != null) parts.push(a.ageMax != null ? `${a.ageMin}–${a.ageMax}` : `${a.ageMin}+`);
    if (a.geoSummary) parts.push(a.geoSummary);
    const base = parts.length > 0 ? parts.join(" · ") : GENERIC_AUDIENCE_LABEL;

    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    labels.set(a.adSetId, n === 1 ? base : `${base} (${n})`);
  }
  return labels;
}
