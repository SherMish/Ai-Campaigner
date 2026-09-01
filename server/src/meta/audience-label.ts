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
    // ⚠️ age_min/age_max are NOT necessarily the customer's chosen range.
    // With Advantage+ audience expansion on (targeting_automation.
    // individual_setting.age = 1 — the default for builder-created ad sets),
    // Meta reports the EXPANSION CEILING here, typically 18–65, while the
    // actually-configured range lives in `age_range`. Real GelNails case
    // (AIC-73): age_min/age_max = 18/65 but age_range = [21,46] — the panel
    // confidently showed "18–65", an audience the customer never chose.
    // Always prefer age_range; these are the fallback.
    age_min?: number;
    age_max?: number;
    age_range?: number[]; // [min, max] — the real configured range
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
  // AIC-171: the Facebook Page this ad set promotes. An ADOPTED campaign can
  // hold ad sets on Pages we are not connected to, and Meta refuses an ad
  // whose creative Page differs from its ad set's ("Pages Don't Match").
  promoted_object?: { page_id?: string } | null;
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
  //
  // AIC-130: this conflates two facts, and one caller needs them apart —
  // see `existsOnMeta`. `isManaged` keeps its meaning ("has something to
  // show right now") for every DISPLAY consumer.
  isManaged: boolean;
  // AIC-130, found live: the ad set is a real object on Meta — not deleted,
  // not archived — regardless of whether it currently has ads.
  //
  // The bug this exists to fix. A customer deleted both ads from a live,
  // ACTIVE ad set. `isManaged` went false (zero ads ⇒ "unpublished draft"),
  // so the add-an-ad picker showed "no ad sets found" and there was NO WAY
  // BACK: the one screen that could put an ad into that ad set refused to
  // list it. The campaign became unrecoverable through the UI while being
  // perfectly healthy on Meta.
  //
  // "Has no ads" is the strongest possible reason to OFFER an ad set as a
  // place to add one — the heuristic was pointing exactly backwards for that
  // caller. Display consumers still want `isManaged`; anything asking "can I
  // write here?" wants this.
  existsOnMeta: boolean;
  // AIC-171: which Page this ad set promotes, so a caller can tell whether we
  // are able to put content into it at all. Null when Meta reports none.
  promotedPageId: string | null;
}

function isDeletedOrArchived(status?: string | null): boolean {
  return status === "DELETED" || status === "ARCHIVED";
}

const GENDER_HE: Record<AdSetMeta["genders"], string> = {
  all: "כלל הקהל",
  male: "גברים",
  female: "נשים",
};

// Meta returns place names in ENGLISH regardless of locale, so an otherwise
// Hebrew label read half-raw ("נשים · 21–46 · Ramat Gan, Giv'atayim").
// Israel has a bounded set of real ad-targetable cities, so a lookup is
// honest and cheap. Anything unmapped falls through UNCHANGED rather than
// being mangled — an English city name is worse than Hebrew but far better
// than a wrong transliteration.
const CITY_HE: Record<string, string> = {
  "tel aviv": "תל אביב", "tel aviv-yafo": "תל אביב-יפו", jerusalem: "ירושלים",
  haifa: "חיפה", "rishon letziyon": "ראשון לציון", "rishon lezion": "ראשון לציון",
  "petah tikva": "פתח תקווה", ashdod: "אשדוד", netanya: "נתניה", beersheba: "באר שבע",
  "be'er sheva": "באר שבע", holon: "חולון", "bnei brak": "בני ברק", "ramat gan": "רמת גן",
  "giv'atayim": "גבעתיים", givatayim: "גבעתיים", rehovot: "רחובות", ashkelon: "אשקלון",
  "bat yam": "בת ים", "beit shemesh": "בית שמש", "kfar saba": "כפר סבא", herzliya: "הרצליה",
  "kfar sava": "כפר סבא", hadera: "חדרה", modiin: "מודיעין", "modi'in": "מודיעין",
  ramla: "רמלה", raanana: "רעננה", "ra'anana": "רעננה", "rosh haayin": "ראש העין",
  lod: "לוד", nazareth: "נצרת", akko: "עכו", eilat: "אילת", tiberias: "טבריה",
  "kiryat gat": "קריית גת", "kiryat ono": "קריית אונו", "kiryat bialik": "קריית ביאליק",
  "kiryat motzkin": "קריית מוצקין", "kiryat yam": "קריית ים", "kiryat ata": "קריית אתא",
  nahariya: "נהריה", afula: "עפולה", dimona: "דימונה", yavne: "יבנה",
  "or yehuda": "אור יהודה", "hod hasharon": "הוד השרון", "even yehuda": "אבן יהודה",
  israel: "ישראל", il: "ישראל",
};

export function localizePlace(name: string): string {
  return CITY_HE[name.trim().toLowerCase()] ?? name;
}

// The customer's ACTUAL configured age range. `age_range` is authoritative
// when present; age_min/age_max are the Advantage+ expansion ceiling and are
// only a fallback (see the RawAdSetMeta comment).
function configuredAge(t: NonNullable<RawAdSetMeta["targeting"]>): { min: number | null; max: number | null } {
  const r = t.age_range;
  if (Array.isArray(r) && r.length >= 2 && Number.isFinite(r[0]) && Number.isFinite(r[1])) {
    return { min: r[0], max: r[1] };
  }
  return { min: t.age_min ?? null, max: t.age_max ?? null };
}

export function normalizeAdSetMeta(row: RawAdSetMeta): AdSetMeta {
  const t = row.targeting ?? {};
  const genders = t.genders ?? [];
  const gender: AdSetMeta["genders"] =
    genders.length === 1 && genders[0] === 1 ? "male" : genders.length === 1 && genders[0] === 2 ? "female" : "all";
  const places = ([
    ...(t.geo_locations?.cities ?? []).map((c) => c.name).filter(Boolean),
    ...(t.geo_locations?.regions ?? []).map((r) => r.name).filter(Boolean),
    ...(t.geo_locations?.countries ?? []),
  ] as string[]).map(localizePlace);
  // A "no ads" signal only counts when the field was actually requested and
  // returned an empty list — if `ads` is absent entirely, we don't know
  // either way, so don't penalize (never falsely exclude a real ad set just
  // because a caller didn't ask for this field).
  const isDraftWithNoAds = row.ads != null && (row.ads.data?.length ?? 0) === 0;
  const age = configuredAge(t);
  return {
    adSetId: row.id,
    name: row.name ?? "",
    ageMin: age.min,
    ageMax: age.max,
    genders: gender,
    geoSummary: places.slice(0, 2).join(", "),
    isDynamicCreative: row.is_dynamic_creative === true,
    status: row.effective_status === "ACTIVE" ? "active" : "paused",
    isManaged: !isDeletedOrArchived(row.effective_status) && !isDraftWithNoAds,
    existsOnMeta: !isDeletedOrArchived(row.effective_status),
    promotedPageId: row.promoted_object?.page_id ?? null,
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
/**
 * One audience, in words: `נשים · 21–46 · תל אביב`.
 *
 * Extracted from deriveAudienceLabels (AIC-154) so the NAME we write to Meta
 * when creating an ad set and the LABEL we show the customer for it come from
 * the same function. They describe the same thing, and two formatters would
 * have agreed on the day they were written and drifted afterwards — leaving
 * an operator comparing the dashboard against Ads Manager unable to tell
 * whether a difference in wording means a difference in audience.
 *
 * Takes the four fields it actually reads rather than a whole AdSetMeta: at
 * create time there is no ad set yet, only the targeting we are about to send.
 */
export function composeAudienceLabel(a: {
  genders: AdSetMeta["genders"];
  ageMin: number | null;
  ageMax: number | null;
  geoSummary: string;
}): string {
  const parts: string[] = [];
  if (a.genders !== "all") parts.push(GENDER_HE[a.genders]);
  if (a.ageMin != null) parts.push(a.ageMax != null ? `${a.ageMin}–${a.ageMax}` : `${a.ageMin}+`);
  if (a.geoSummary) parts.push(a.geoSummary);
  return parts.length > 0 ? parts.join(" · ") : GENERIC_AUDIENCE_LABEL;
}

export function deriveAudienceLabels(adsets: AdSetMeta[]): Map<string, string> {
  const labels = new Map<string, string>();
  const seen = new Map<string, number>();

  for (const a of adsets) {
    const base = composeAudienceLabel(a);

    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    labels.set(a.adSetId, n === 1 ? base : `${base} (${n})`);
  }
  return labels;
}
