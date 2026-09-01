import { describe, it, expect } from "vitest";
import { adCreateBlocker, adSetSubmitBlocker, createCampaignBlocker, nextBlocker, type BuilderGateState } from "./builder-gates";

const ENGAGEMENT = "engagement";
const WEBSITE = "website";

const base: BuilderGateState = {
  destination: "whatsapp",
  whatsappNumber: "972500000000",
  destinationUrl: "https://example.com",
  pixelId: "px1",
  conversionEvent: "LEAD",
  dailyBudgetShekels: 50,
  budgetOverCeiling: false,
  ageMin: 25,
  ageMax: 55,
  createdAdCount: 1,
};
const next = (step: number, over: Partial<BuilderGateState> = {}) =>
  nextBlocker(step, { ...base, ...over }, ENGAGEMENT, WEBSITE);

describe("nextBlocker (AIC-163)", () => {
  it("is null on every step when nothing blocks", () => {
    for (const step of [0, 1, 2, 3, 4, 5, 6, 7]) expect(next(step)).toBeNull();
  });

  it("names the WhatsApp number when it is malformed", () => {
    // The reported class of bug: one digit short and the only control on the
    // screen goes grey with no explanation.
    expect(next(1, { whatsappNumber: "97250" })).toBe("whatsapp_number_invalid");
    expect(next(1, { whatsappNumber: "" })).toBe("whatsapp_number_invalid");
  });

  it("names WHICH website field is missing, not just 'invalid'", () => {
    // destinationValid collapsed three requirements into one boolean, so even
    // a generic message left the customer testing fields one at a time.
    expect(next(1, { destination: WEBSITE, destinationUrl: "example.com" })).toBe("website_url_invalid");
    expect(next(1, { destination: WEBSITE, pixelId: "" })).toBe("pixel_missing");
    expect(next(1, { destination: WEBSITE, conversionEvent: "" })).toBe("conversion_event_missing");
    expect(next(1, { destination: WEBSITE })).toBeNull();
  });

  it("asks nothing of an engagement campaign — there is no destination to give", () => {
    expect(next(1, { destination: ENGAGEMENT, whatsappNumber: "", destinationUrl: "" })).toBeNull();
  });

  it("separates a missing budget from one over the agreed ceiling", () => {
    // Different fixes: type a number, versus type a SMALLER number.
    expect(next(2, { dailyBudgetShekels: 0 })).toBe("budget_missing");
    expect(next(2, { dailyBudgetShekels: Number.NaN })).toBe("budget_missing");
    expect(next(2, { budgetOverCeiling: true })).toBe("budget_over_ceiling");
  });

  it("catches an age range Meta will not accept", () => {
    expect(next(4, { ageMin: 12 })).toBe("age_invalid");
    expect(next(4, { ageMax: 70 })).toBe("age_invalid");
    expect(next(4, { ageMin: 40, ageMax: 30 })).toBe("age_invalid");
    expect(next(4, { ageMin: 40, ageMax: 40 })).toBe("age_invalid"); // max must exceed min
  });

  it("blocks the ads step until at least one ad has been created", () => {
    expect(next(6, { createdAdCount: 0 })).toBe("no_ads");
  });

  it("says nothing on the steps that never gate", () => {
    // goal, special category, placements, review — the wizard lets these
    // through unconditionally, so inventing a reason would be noise.
    for (const step of [0, 3, 5, 7]) expect(next(step, { createdAdCount: 0, ageMin: 1 })).toBeNull();
  });
});

describe("createCampaignBlocker", () => {
  it("explains the dead final button after eight steps of work", () => {
    expect(createCampaignBlocker(0)).toBe("no_ads");
    expect(createCampaignBlocker(1)).toBeNull();
  });
});

describe("adCreateBlocker", () => {
  const upload = { source: "upload" as const, postId: null, hasMedia: true, headline: "h", primaryText: "t" };

  it("points at the next empty box, top to bottom", () => {
    expect(adCreateBlocker({ ...upload, hasMedia: false })).toBe("media_missing");
    expect(adCreateBlocker({ ...upload, headline: " " })).toBe("headline_missing");
    expect(adCreateBlocker({ ...upload, primaryText: "" })).toBe("text_missing");
    expect(adCreateBlocker(upload)).toBeNull();
  });

  it("asks a post-sourced ad only for its post", () => {
    // An existing post carries its own copy — the headline/text fields are not
    // even shown on that path, so demanding them would be nonsense.
    expect(adCreateBlocker({ source: "post", postId: null, hasMedia: false, headline: "", primaryText: "" }))
      .toBe("post_not_chosen");
    expect(adCreateBlocker({ source: "post", postId: "p1", hasMedia: false, headline: "", primaryText: "" }))
      .toBeNull();
  });
});

describe("adSetSubmitBlocker", () => {
  it("only the ads block it — the name is optional (AIC-172)", () => {
    // A blank name derives the audience label server-side, the same convention
    // every ad set we build already uses. Requiring one was a field that
    // earned nothing and stopped a customer with nothing useful to type.
    expect(adSetSubmitBlocker({ createdAdCount: 0 })).toBe("no_created_ads");
    expect(adSetSubmitBlocker({ createdAdCount: 1 })).toBeNull();
  });
});
