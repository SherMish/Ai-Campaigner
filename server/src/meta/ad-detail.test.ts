import { describe, it, expect } from "vitest";
import { normalizeAdDetail } from "./ad-detail.js";

describe("normalizeAdDetail (AIC-139)", () => {
  it("reads the copy we wrote, from link_data", () => {
    // Shape verified against a real live ad on 2026-08-25.
    const d = normalizeAdDetail({
      id: "120251015785100544",
      name: "מודעה 2",
      effective_status: "ACTIVE",
      creative: {
        id: "1251658994706034",
        title: "כותרת",
        body: "טקסט",
        image_url: "https://cdn/x.jpg",
        object_story_spec: {
          link_data: {
            message: "הטקסט הראשי המלא",
            name: "הכותרת המלאה",
            link: "https://api.whatsapp.com/send",
            call_to_action: { type: "WHATSAPP_MESSAGE", value: { whatsapp_number: "972526964069" } },
          },
        },
      },
    });
    // link_data wins over Meta's derived title/body: it is what we WROTE, and
    // the derived pair can be truncated or absent depending on the shape.
    expect(d.headline).toBe("הכותרת המלאה");
    expect(d.primaryText).toBe("הטקסט הראשי המלא");
    expect(d.whatsappNumber).toBe("972526964069");
    expect(d.ctaType).toBe("WHATSAPP_MESSAGE");
    expect(d.fromExistingPost).toBe(false);
  });

  it("falls back to title/body when there is no link_data", () => {
    const d = normalizeAdDetail({ id: "1", creative: { title: "T", body: "B", call_to_action_type: "LEARN_MORE" } });
    expect(d.headline).toBe("T");
    expect(d.primaryText).toBe("B");
    expect(d.ctaType).toBe("LEARN_MORE");
  });

  it("flags an ad built from an existing post, which carries no copy of ours", () => {
    // The UI must say so rather than render three blanks and imply the ad is
    // empty — the POST is the creative.
    const d = normalizeAdDetail({ id: "1", creative: { object_story_id: "page_123_456" } });
    expect(d.fromExistingPost).toBe(true);
    expect(d.headline).toBeNull();
    expect(d.primaryText).toBeNull();
  });

  it("never throws on a creative Meta returns empty", () => {
    const d = normalizeAdDetail({ id: "1" });
    expect(d.adId).toBe("1");
    expect(d.creativeId).toBeNull();
  });
});
