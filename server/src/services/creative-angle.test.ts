import { describe, it, expect } from "vitest";
import { classifyAngle } from "./creative-angle.js";

describe("classifyAngle", () => {
  it("names the angle the copy actually commits to", () => {
    expect(classifyAngle("מבצע החודש", "הנחה של 20% על כל טיפול").angle).toBe("price");
    expect(classifyAngle("12 שנות ניסיון", "מומחים בתחום").angle).toBe("experience");
    expect(classifyAngle("זמינות מיידית", "מגיעים אליכם היום").angle).toBe("speed");
  });

  it("returns null when the copy takes no clear angle — the whole point", () => {
    // A tested-angles list is only useful if it is true. Generic copy has to
    // come back unclassified rather than land in whichever bucket is nearest,
    // or "we tried price" starts meaning "we tried everything else too".
    expect(classifyAngle("שירות מקצועי ואמין", "צרו קשר עוד היום").angle).toBeNull();
    expect(classifyAngle(null, null).angle).toBeNull();
    expect(classifyAngle("", "   ").angle).toBeNull();
  });

  it("keeps every angle the copy touches, not just the strongest", () => {
    // The ad leads on price and also carries the experience claim. Recording
    // only the lead would erase the fact that experience was already tried.
    const v = classifyAngle("מחיר מיוחד", "12 שנות ניסיון, מחיר שלא תמצאו במקום אחר");
    expect(v.angle).toBe("price");
    expect(v.all).toContain("experience");
  });

  it("matches through the Hebrew prefixes that attach to words", () => {
    // ב/ל/ו/ה glue onto the next word, so a whole-word match would miss.
    expect(classifyAngle(null, "אנחנו באזור שלכם").all).toContain("local");
  });

  it("reads an objection-handling promise as its own angle, not as price", () => {
    // "ללא התחייבות" contains no price term but is the classic hesitation
    // remover, and conflating it with price would hide that it was tried.
    expect(classifyAngle("ייעוץ ראשוני", "בלי התחייבות, אפשר לבטל בכל שלב").angle).toBe("objection");
  });
});

// Both of these were produced by running the classifier over the REAL live ads
// on two accounts. They are here because they were wrong on screen, not
// because they were imagined.
describe("classifyAngle — Hebrew substring collisions found on live ads", () => {
  it('does not read "ומבצע שינויים" (performs changes) as "מבצע" (a sale)', () => {
    const v = classifyAngle("אל תהיו חמורים. יש דרך אחרת לנהל קמפיין.", "Ads Agent עוקב, מנתח, ממליץ ומבצע שינויים באישורכם.");
    expect(v.all).not.toContain("price");
  });

  it('does not read "לשנות" (to change) as "שנות" (years of experience)', () => {
    const v = classifyAngle(null, "מזהה מה כדאי לשנות ומציע פעולות ברורות לאישור.");
    expect(v.all).not.toContain("experience");
  });

  it("reads the cost complaint that both of those ads were actually making", () => {
    // "still paying thousands a month?" is a price angle in every sense, and
    // the first version matched none of its words.
    expect(classifyAngle("עדיין משלמים אלפי שקלים על ניהול קמפיינים?", "בלי ריטיינר מנופח.").angle).toBe("price");
    expect(classifyAngle(null, "מה איתך עדיין משלם ריטיינר חודשי של 1000+ לקמפיינר ?").angle).toBe("price");
  });

  it("still absorbs the prefix that glues onto a real term", () => {
    // "בחינם" must count as "חינם" — this is the case the loose matching exists
    // for, and the collision fix must not break it.
    expect(classifyAngle(null, "100 הנרשמים הראשונים יקבלו גישה מלאה בחינם.").angle).toBe("price");
  });
});
