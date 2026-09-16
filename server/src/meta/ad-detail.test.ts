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

import { mergePostIntoDetail, postIdOf } from "./ad-detail.js";

// Found live on M Jobs: every ad is a BOOST, and the detail popup showed "—" for
// headline, primary text, button and destination. A boosted creative carries no
// copy of its own — only `effective_object_story_id` pointing at the post — so
// the text lives on the post.
describe("boosted-post ads", () => {
  const boosted = {
    id: "120249122012140173",
    name: "פיקוח - עיצוב 1",
    creative: {
      id: "916909074822078",
      effective_object_story_id: "1149927111545438_122124130041377275",
      object_story_spec: { page_id: "1149927111545438", instagram_user_id: "17841411454845298" },
      object_type: "SHARE",
    },
  };

  it("recognises a boosted creative as an existing post", () => {
    // It carries effective_object_story_id, NOT object_story_id — so the old
    // check missed it and the popup rendered four blanks instead of saying so.
    expect(normalizeAdDetail(boosted as never).fromExistingPost).toBe(true);
    expect(postIdOf(boosted as never)).toBe("1149927111545438_122124130041377275");
  });

  it("fills the popup from the post", () => {
    const merged = mergePostIntoDetail(normalizeAdDetail(boosted as never), {
      message: "🚌 מחפש/ת עבודה עצמאית בשטח?",
      call_to_action: {
        type: "WHATSAPP_MESSAGE",
        value: { link_title: "לשליחת מועמדות >>", link: "https://api.whatsapp.com/send?phone=972547892429&token=SIGNED" },
      },
      attachments: { data: [{ title: "לשליחת מועמדות >>" }] },
    });
    expect(merged).toMatchObject({
      primaryText: "🚌 מחפש/ת עבודה עצמאית בשטח?",
      headline: "לשליחת מועמדות >>",
      ctaType: "WHATSAPP_MESSAGE",
      whatsappNumber: "972547892429",
      fromExistingPost: true,
    });
  });

  it("never exposes the signed WhatsApp link — only the number", () => {
    // Meta's link carries a signed token; the number is what a person needs.
    const merged = mergePostIntoDetail(normalizeAdDetail(boosted as never), {
      call_to_action: { type: "WHATSAPP_MESSAGE", value: { link: "https://api.whatsapp.com/send?phone=972547892429&token=SIGNED" } },
    });
    expect(merged.link).toBeNull();
    expect(merged.whatsappNumber).toBe("972547892429");
  });

  it("keeps a real website link from a post", () => {
    const merged = mergePostIntoDetail(normalizeAdDetail(boosted as never), {
      call_to_action: { type: "LEARN_MORE", value: { link: "https://lakgel.co.il/book" } },
    });
    expect(merged).toMatchObject({ link: "https://lakgel.co.il/book", whatsappNumber: null, ctaType: "LEARN_MORE" });
  });

  it("does not overwrite copy the creative already had", () => {
    const own = normalizeAdDetail({
      id: "1", creative: { id: "c", effective_object_story_id: "p_1", object_story_spec: { link_data: { message: "ours", name: "our headline" } } },
    } as never);
    const merged = mergePostIntoDetail(own, { message: "the post's", attachments: { data: [{ title: "post title" }] } });
    expect(merged.primaryText).toBe("ours");
    expect(merged.headline).toBe("our headline");
  });

  it("an unreadable post leaves the detail as it was — still marked as a post", () => {
    const d = normalizeAdDetail(boosted as never);
    expect(mergePostIntoDetail(d, null)).toEqual(d);
  });
});

import { fillImage } from "./ad-detail.js";

// A boosted ad has no image_url; its picture is only reachable as the
// creative's thumbnail, which Meta serves at 1080×1080 when asked (verified live).
describe("fillImage", () => {
  const d = normalizeAdDetail({ id: "1", creative: { id: "c", effective_object_story_id: "p_1" } } as never);

  it("gives a boosted ad the picture the popup was missing", () => {
    expect(fillImage(d, "https://scontent.example/1080.jpg").imageUrl).toBe("https://scontent.example/1080.jpg");
  });

  it("never replaces an image the creative already had", () => {
    const own = { ...d, imageUrl: "https://scontent.example/ours.jpg" };
    expect(fillImage(own, "https://scontent.example/thumb.jpg").imageUrl).toBe("https://scontent.example/ours.jpg");
  });

  it("leaves the detail alone when no thumbnail came back", () => {
    expect(fillImage(d, null)).toEqual(d);
  });
});
