import { describe, it, expect } from "vitest";
import { profileBadge } from "./profile-badge";

// AIC-132. This mirrors the server's summarizeProfile so the wizard badge can
// update as the operator types. Two implementations is normally the thing to
// avoid — these tests exist to keep the drift small and visible, and mirror the
// server's cases deliberately. The server's verdict remains the one of record:
// nothing downstream reads this one.
const RICH = {
  category: "professional_services",
  mainService: "ניהול קמפיינים ממומנים לעסקים קטנים",
  geoArea: "כל הארץ (שירות מרחוק, בלי תלות במיקום)",
  primaryCustomer: "בעלי עסקים קטנים שמפרסמים לבד",
  offer: "ניהול מלא של הקמפיין ב-299 ש\"ח לחודש, בלי התחייבות",
  differentiators: "בדיקה כל שעה שתופסת תקלות שלא רואים ב-Ads Manager",
  objections: "כבר שילמתי לסוכנות ולא ראיתי תוצאות",
  priceRange: "299 ש\"ח לחודש",
};

describe("profileBadge (AIC-132, wizard mirror)", () => {
  it("agrees with the server on the rich profile", () => {
    expect(profileBadge(RICH).state).toBe("ok");
  });

  it("agrees that a blank profile is broken", () => {
    const b = profileBadge({});
    expect(b.state).toBe("broken");
    expect(b.missing).toContain("offer");
    expect(b.missing).toContain("differentiators");
  });

  it('agrees that "Israel" is thin', () => {
    expect(profileBadge({ ...RICH, geoArea: "Israel" }).state).toBe("thin");
  });

  it("agrees that a deliberate nationwide answer is fine", () => {
    expect(profileBadge(RICH).vague).not.toContain("geoArea");
  });

  it("names the fields, so the operator knows what to ask next", () => {
    // The reason this returns field keys rather than a score: "70% complete"
    // tells nobody what the next question on the call should be.
    const b = profileBadge({ ...RICH, offer: "", objections: "" });
    expect(b.missing).toEqual(["offer"]);
    expect(b.vague).toContain("objections");
  });
});
