import { describe, it, expect } from "vitest";
import { normalizeAdMedia } from "./ad-media.js";

describe("normalizeAdMedia (AIC-73 round 2)", () => {
  // Verified against the REAL GelNails ad: one creative, no asset_feed_spec.
  // Its name is "almond green, french, video, pink lines" — four
  // comma-separated words describing ONE creative. The round-2 review assumed
  // this was a flexible ad with 4 creatives; the live API says otherwise, so
  // assetCount must come from Meta, never from splitting the name.
  it("an ordinary single-creative ad reports assetCount 1, regardless of a multi-part NAME", () => {
    const m = normalizeAdMedia({
      id: "ad_1",
      name: "almond green, french, video, pink lines",
      creative: { thumbnail_url: "https://cdn/thumb.jpg", image_url: "https://cdn/full.jpg" },
    });
    expect(m.assetCount).toBe(1);
    expect(m.thumbnails).toEqual(["https://cdn/thumb.jpg"]);
  });

  it("a genuinely flexible ad counts its real assets from asset_feed_spec", () => {
    const m = normalizeAdMedia({
      id: "ad_2",
      name: "Flexible",
      creative: {
        thumbnail_url: "https://cdn/ignored.jpg",
        asset_feed_spec: {
          images: [{ permalink_url: "https://cdn/a.jpg" }, { url: "https://cdn/b.jpg" }],
          videos: [{ thumbnail_url: "https://cdn/v.jpg" }],
        },
      },
    });
    expect(m.assetCount).toBe(3);
    expect(m.thumbnails).toEqual(["https://cdn/a.jpg", "https://cdn/b.jpg", "https://cdn/v.jpg"]);
  });

  it("falls back to image_url when no thumbnail is offered", () => {
    const m = normalizeAdMedia({ id: "ad_3", creative: { image_url: "https://cdn/only.jpg" } });
    expect(m.thumbnails).toEqual(["https://cdn/only.jpg"]);
  });

  // The UI must degrade to the ad's name rather than render a broken image.
  it("no usable image at all → empty thumbnails, still assetCount 1", () => {
    const m = normalizeAdMedia({ id: "ad_4", name: "No media", creative: {} });
    expect(m.thumbnails).toEqual([]);
    expect(m.assetCount).toBe(1);
  });

  it("a missing creative object doesn't throw", () => {
    const m = normalizeAdMedia({ id: "ad_5" });
    expect(m).toMatchObject({ adId: "ad_5", thumbnails: [], assetCount: 1 });
  });

  it("caps how many thumbnails a very flexible ad renders", () => {
    const images = Array.from({ length: 12 }, (_, i) => ({ url: `https://cdn/${i}.jpg` }));
    const m = normalizeAdMedia({ id: "ad_6", creative: { asset_feed_spec: { images } } });
    expect(m.assetCount).toBe(12); // the honest count is preserved...
    expect(m.thumbnails).toHaveLength(6); // ...even though we only render some
  });
});
