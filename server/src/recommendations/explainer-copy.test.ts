import { describe, it, expect } from "vitest";
import { EXPLAINER_HE } from "./explainer.js";

// Copy audit, 2026-08-22. Three defects in two adjacent functions, all of the
// same family: text that was true for the shape it was written against.
describe("explainer copy — counts and spelling", () => {
  it("does not contain the ביקר typo (it means 'visited', not 'expensively')", () => {
    // The proof this was a slip and not a choice: the FALLBACK branch of the
    // same function, one line below, said "בעלות גבוהה" correctly. Same
    // author, same function, one line apart.
    const all = Object.values(EXPLAINER_HE).map((f) => (f as (...a: never[]) => string)("x" as never, "y" as never, 2 as never)).join(" ");
    expect(all).not.toMatch(/ביקר/);
  });

  it("says 'the other ad' for one peer and 'the other ads' for several", () => {
    // Hardcoded plural was wrong for the commonest case a small business has:
    // exactly two ads.
    expect(EXPLAINER_HE.pauseCreative("₪200", "0", 1)).toContain("המודעה האחרת");
    expect(EXPLAINER_HE.pauseCreative("₪200", "0", 1)).not.toContain("המודעות האחרות");
    expect(EXPLAINER_HE.pauseCreative("₪200", "0", 3)).toContain("המודעות האחרות");
  });

  it("never says 'the second audience' — meaningless with three or more", () => {
    // With 3+ audiences "מהקהל השני" is unanswerable: which one is second?
    // Naming the winner is both correct and more useful.
    const many = EXPLAINER_HE.pauseAudience("18–35", "45–65", 3);
    expect(many).not.toContain("השני");
    expect(many).toContain("45–65"); // names the winner instead of counting
    const one = EXPLAINER_HE.pauseAudience("18–35", "45–65", 1);
    expect(one).toContain("45–65");
  });

  it("still works when no audience label could be derived", () => {
    // The generic phrasing must survive — a null label is a real case.
    const s = EXPLAINER_HE.pauseAudience(null, null, 2);
    expect(s.length).toBeGreaterThan(20);
    expect(s).not.toContain("null");
  });
});
