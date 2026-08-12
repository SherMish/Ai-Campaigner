// Per-ad creative media (AIC-73 round 2). The customer's ads are pictures —
// showing them as thumbnails is what makes the details panel legible to a
// salon owner. Kept in its own module (not audience-label.ts) because it's a
// presentation-only read: nothing in the engine depends on it.

export interface AdMedia {
  adId: string;
  name: string | null;
  // Small square previews. Empty when Meta exposes no usable image (e.g. a
  // video-only creative whose thumbnail hasn't been generated yet) — the UI
  // must degrade to the name rather than render a broken image.
  thumbnails: string[];
  // How many creative assets Meta ACTUALLY reports for this ad. 1 for an
  // ordinary single-image ad. Deliberately never inferred from the ad's name:
  // the real GelNails ad is named "almond green, french, video, pink lines"
  // but has exactly one creative — claiming "4 קרייטיבים" would be inventing
  // data (AIC-73's round-2 review assumed a flexible ad; the live API says
  // otherwise).
  assetCount: number;
}

export interface RawAdMedia {
  id: string;
  name?: string | null;
  creative?: {
    thumbnail_url?: string | null;
    image_url?: string | null;
    asset_feed_spec?: {
      images?: Array<{ url?: string | null; permalink_url?: string | null }>;
      videos?: Array<{ thumbnail_url?: string | null }>;
    } | null;
  } | null;
}

export interface AdMediaReader {
  getAdMedia(metaCampaignId: string): Promise<AdMedia[]>;
}

export function normalizeAdMedia(row: RawAdMedia): AdMedia {
  const c = row.creative ?? {};
  const feed = c.asset_feed_spec ?? {};
  // A flexible/Advantage+ ad genuinely carries many assets; an ordinary ad
  // carries none of these and falls back to its single creative image.
  const feedImages = (feed.images ?? []).map((i) => i.permalink_url || i.url).filter(Boolean) as string[];
  const feedVideos = (feed.videos ?? []).map((v) => v.thumbnail_url).filter(Boolean) as string[];
  const multi = [...feedImages, ...feedVideos];

  if (multi.length > 0) {
    return { adId: row.id, name: row.name ?? null, thumbnails: multi.slice(0, 6), assetCount: multi.length };
  }
  const single = c.thumbnail_url || c.image_url || null;
  return {
    adId: row.id,
    name: row.name ?? null,
    thumbnails: single ? [single] : [],
    // An ad always has at least its one creative, even when we couldn't get a
    // usable image URL for it.
    assetCount: 1,
  };
}
