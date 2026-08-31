import { localizePlace } from "../meta/audience-label.js";

// AIC-157 — the geo lookup behind the city picker, shared by the customer
// builder, the admin builder and add-content.
//
// One module because three screens creating ad sets with different targeting
// powers is exactly the divergence AIC-155 turned out to be: the same
// component fed from two sources, disagreeing for months.
//
// LOCALIZED HERE, ONCE. Meta's `search?type=adgeolocation` answers in English
// whatever language you ask in — "רמת גן" comes back "Ramat Gan" — so the
// results are run through the same `localizePlace` map the dashboard's
// audience labels use. A customer picking "רמת גן" and later reading
// "Ramat Gan" on their own dashboard would have no way to know it is the same
// place.
//
// `key` is never localized and never re-derived: it is Meta's own targeting
// value, and a name is not a targetable thing at all.

export interface GeoOption {
  key: string;
  name: string;
  type: "city" | "region";
  region: string | null;
}

export async function searchGeoOrEmpty(writer: unknown, query: string): Promise<GeoOption[]> {
  const q = (query ?? "").trim();
  // Meta returns broad noise for one or two letters, and the picker is a
  // type-ahead — asking before the customer has said anything useful spends a
  // live call to show them nothing they can choose.
  if (q.length < 2) return [];
  const reader = writer as { searchGeoLocations?: (q: string) => Promise<GeoOption[]> } | null;
  if (!reader?.searchGeoLocations) return [];
  const results = await reader.searchGeoLocations(q);
  return results.map((r) => ({ ...r, name: localizePlace(r.name), region: r.region ? localizePlace(r.region) : null }));
}
