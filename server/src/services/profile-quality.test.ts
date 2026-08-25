import { describe, it, expect } from "vitest";
import { summarizeProfile } from "./profile-quality.js";

// A profile good enough to write an ad from — the real Ads Agent one, so the
// "ok" case is anchored to something a person actually wrote rather than to a
// fixture built to pass.
const RICH = {
  category: "professional_services",
  mainService: "ניהול קמפיינים ממומנים בפייסבוק ובאינסטגרם לעסקים קטנים",
  geoArea: "כל הארץ (שירות מרחוק, בלי תלות במיקום)",
  primaryCustomer: "בעלי עסקים קטנים שמפרסמים לבד ולא בטוחים אם זה עובד",
  offer: "ניהול מלא של הקמפיין ב-299 ש\"ח לחודש, בלי התחייבות",
  differentiators: "בדיקה כל שעה שתופסת תקלות שלא רואים ב-Ads Manager; מחיר קבוע ולא אחוז מהתקציב",
  objections: "כבר שילמתי לסוכנות ולא ראיתי תוצאות",
  priceRange: "299 ש\"ח לחודש, בלי התחייבות",
};

describe("summarizeProfile (AIC-132)", () => {
  it("passes a profile a person actually filled in", () => {
    expect(summarizeProfile(RICH).state).toBe("ok");
  });

  describe("broken — nothing to say about the business at all", () => {
    it("a blank profile is broken, not merely thin", () => {
      // The measured reality when this shipped: three of five customers,
      // including the only one spending money.
      const s = summarizeProfile({});
      expect(s.state).toBe("broken");
      expect(s.missing).toContain("offer");
      expect(s.missing).toContain("differentiators");
    });

    it("no offer is broken — there is nothing to put in the ad", () => {
      expect(summarizeProfile({ ...RICH, offer: "" }).state).toBe("broken");
    });

    it("no differentiators is broken — the ad can only compete on price", () => {
      // Which is the worst competition a small business can pick, and the
      // reason this is a blocker rather than a nudge.
      expect(summarizeProfile({ ...RICH, differentiators: "  " }).state).toBe("broken");
    });
  });

  describe("thin — filled in, and still uninformative", () => {
    it('geo_area "Israel" is thin — it passes any is-it-filled test and targets everyone', () => {
      const s = summarizeProfile({ ...RICH, geoArea: "Israel" });
      expect(s.state).toBe("thin");
      expect(s.vague).toContain("geoArea");
    });

    it("but a deliberate nationwide answer is NOT flagged", () => {
      // "כל הארץ (שירות מרחוק, בלי תלות במיקום)" says the same thing and says
      // it on purpose. Nagging someone who already explained themselves is how
      // a check gets ignored.
      expect(summarizeProfile(RICH).vague).not.toContain("geoArea");
    });

    it("a two-word offer is a label, not an offer", () => {
      const s = summarizeProfile({ ...RICH, offer: "ייעוץ משכנתאות" });
      expect(s.state).toBe("thin");
      expect(s.vague).toContain("offer");
    });

    it('an audience of "כולם" targets nobody', () => {
      expect(summarizeProfile({ ...RICH, primaryCustomer: "כולם" }).vague).toContain("primaryCustomer");
    });

    it("a category with no main service cannot produce a sentence", () => {
      const s = summarizeProfile({ ...RICH, mainService: "" });
      expect(s.state).toBe("thin");
      expect(s.vague).toContain("mainService");
    });

    it("flags filler that could describe any business", () => {
      expect(summarizeProfile({ ...RICH, differentiators: "מקצועי ואמין" }).vague).toContain("differentiators");
    });

    it("does NOT flag a real answer that merely contains a filler word", () => {
      // "12 שנות ניסיון, שירות אמין" contains "אמין" and is still a real
      // answer. Only a whole answer made of filler counts.
      const s = summarizeProfile({ ...RICH, differentiators: "12 שנות ניסיון, שירות אמין ומלווה עד הסוף" });
      expect(s.vague).not.toContain("differentiators");
    });

    it("missing objections or price is a nudge, never a blocker", () => {
      const s = summarizeProfile({ ...RICH, objections: "", priceRange: "" });
      expect(s.state).toBe("thin");
      expect(s.missing).toEqual([]);
    });
  });

  it("reports missing before vague — that is the order to fix them in", () => {
    const s = summarizeProfile({ ...RICH, offer: "", geoArea: "Israel" });
    expect(s.state).toBe("broken");
    expect(s.reason).toContain("missing");
  });
});
