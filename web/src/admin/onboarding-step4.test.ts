import { describe, it, expect } from "vitest";
import { adAccountOptions, newCampaignBlocker, step4Branch } from "./onboarding-step4.js";

describe("step 4: which provisioning branch to show (AIC-119)", () => {
  // The bug, found live on a customer with no connection at all: the operator
  // was shown שם הקמפיין / מספר וואטסאפ / "יצירת הרשומות" — the form for
  // ADOPTING an existing Meta campaign — before picking an ad account. There
  // was no campaign to adopt, so the button could only ever fail.
  //
  // The old condition asked "is the campaign list known to be empty", which is
  // false before an account is picked, so it fell through to adopt-existing.
  // Absence of a loaded list is not evidence that a campaign exists.
  it("asks for an ad account first — neither branch's fields before then", () => {
    expect(step4Branch({ adAccountId: "", loading: false, error: null, campaigns: null }))
      .toBe("pick_account");
    // ...even if a stale list from a previously-selected account is still held.
    expect(step4Branch({ adAccountId: "", loading: false, error: null, campaigns: [{ supported: true }] }))
      .toBe("pick_account");
  });

  it("says nothing while the list is still loading", () => {
    expect(step4Branch({ adAccountId: "act_1", loading: true, error: null, campaigns: null }))
      .toBe("loading");
  });

  // A failed load must not silently become "this account has no campaigns" —
  // that would offer to build a second campaign for an account that has one.
  it("surfaces a failed load instead of guessing a branch", () => {
    expect(step4Branch({ adAccountId: "act_1", loading: false, error: "network", campaigns: null }))
      .toBe("error");
  });

  it("offers to build a new campaign only when the account is known to have none", () => {
    expect(step4Branch({ adAccountId: "act_1", loading: false, error: null, campaigns: [] }))
      .toBe("new_campaign");
  });

  it("offers to adopt only when the account actually has campaigns", () => {
    expect(step4Branch({ adAccountId: "act_1", loading: false, error: null, campaigns: [{ supported: true }] }))
      .toBe("adopt_existing");
  });

  // Unsupported campaigns still count as "this account has campaigns" — the
  // picker lists them disabled with a reason, which is more useful than
  // pretending the account is empty and offering to add another.
  it("counts unsupported campaigns as campaigns", () => {
    expect(step4Branch({ adAccountId: "act_1", loading: false, error: null, campaigns: [{ supported: false }] }))
      .toBe("adopt_existing");
  });
});

// An ad account having campaigns meant the operator COULD ONLY adopt one.
// Reported live: "although it has existing campaigns, maybe I want to create a
// new one? allow it as it's allowed for users without a campaign." The build
// path already existed and worked — it was simply unreachable for these
// accounts, which is an arbitrary restriction Meta itself does not impose.
describe("step4Branch — building a new campaign is always allowed", () => {
  const withCampaigns = {
    adAccountId: "act_1",
    loading: false,
    error: null,
    campaigns: [{ supported: true }],
  };

  it("still defaults to adopting when the account has campaigns", () => {
    // The common case is unchanged: an account with campaigns is usually one
    // we are taking over, and defaulting to "build another" would be wrong.
    expect(step4Branch(withCampaigns)).toBe("adopt_existing");
  });

  it("switches to building when the operator explicitly asks", () => {
    expect(step4Branch({ ...withCampaigns, forceNewCampaign: true })).toBe("new_campaign");
  });

  it("keeps building available for an account with none, override or not", () => {
    const empty = { ...withCampaigns, campaigns: [] };
    expect(step4Branch(empty)).toBe("new_campaign");
    expect(step4Branch({ ...empty, forceNewCampaign: true })).toBe("new_campaign");
  });

  it("the override never skips choosing an ad account first", () => {
    // Building needs an account to build IN. Honouring the override here would
    // render a form whose submit could only fail — the exact bug AIC-119 fixed
    // by making each branch require positive evidence.
    expect(step4Branch({ ...withCampaigns, adAccountId: "", forceNewCampaign: true })).toBe("pick_account");
  });

  it("the override does not paper over a failed campaign load", () => {
    // A list that failed to load is not evidence of anything, and letting the
    // override bypass it would hide a real Meta problem behind a form.
    expect(step4Branch({ ...withCampaigns, error: "boom", forceNewCampaign: true })).toBe("error");
  });
});

// Step 4 offered EVERY ad account our System User can reach — including other
// customers' — with only a "בשימוש גם עבור X" note to catch a wrong pick.
// Reported live: "the ONLY ad account that should be available is the one
// entered for this user during the wizard. I shouldn't see all the ad
// accounts."
//
// The intent already existed: an effect pre-selects the verified account,
// commented "the operator should never have to re-pick from a list that can
// contain another customer's account". It just stopped at pre-selecting.
describe("adAccountOptions — step 4 is scoped to the verified account", () => {
  const mine = { id: "act_mine" };
  const other = { id: "act_other" };

  it("offers only the account verified for THIS customer", () => {
    const r = adAccountOptions([mine, other], "act_mine");
    expect(r.options).toEqual([mine]);
    expect(r.scoped).toBe(true);
  });

  it("offers everything when no account has been verified yet", () => {
    // Nothing has been established for this customer, so narrowing would be
    // inventing a constraint rather than enforcing one.
    const r = adAccountOptions([mine, other], undefined);
    expect(r.options).toEqual([mine, other]);
    expect(r.scoped).toBe(false);
  });

  it("does NOT trap the operator when the verified account is absent from the list", () => {
    // Access could have changed, or the list failed to include it. Filtering to
    // nothing would leave a required field that cannot be filled — worse than
    // showing the full list with its existing warnings.
    const r = adAccountOptions([other], "act_mine");
    expect(r.options).toEqual([other]);
    expect(r.scoped).toBe(false);
  });

  it("handles a list that has not loaded", () => {
    expect(adAccountOptions(null, "act_mine")).toEqual({ options: [], scoped: false });
  });
});

describe("newCampaignBlocker", () => {
  const ready = { pageMissing: false, pageUnverified: false, instagramUnverified: false, budgetMissing: false };

  it("names the reason when only Instagram is unverified — the bug this fixes", () => {
    // Found on the real wizard: Page selected, budget filled, Instagram picked
    // but never checked. "צור קמפיין חדש" was disabled and the screen printed
    // NOTHING, because the two rendered explanations covered only the Page.
    expect(newCampaignBlocker({ ...ready, instagramUnverified: true })).toBe("instagram_unverified");
  });

  it("names the reason when only the budget is missing", () => {
    expect(newCampaignBlocker({ ...ready, budgetMissing: true })).toBe("budget_missing");
  });

  it("returns null only when nothing blocks — so a disabled button always has a reason", () => {
    expect(newCampaignBlocker(ready)).toBeNull();
  });

  it("reports the Page before its verification, and both before Instagram", () => {
    // The order the operator has to act in, and the same order startNewCampaign
    // guards in — one list, so the button, its message and the request can
    // never disagree about why.
    expect(newCampaignBlocker({ pageMissing: true, pageUnverified: true, instagramUnverified: true, budgetMissing: true }))
      .toBe("page_missing");
    expect(newCampaignBlocker({ ...ready, pageUnverified: true, instagramUnverified: true, budgetMissing: true }))
      .toBe("page_unverified");
    expect(newCampaignBlocker({ ...ready, instagramUnverified: true, budgetMissing: true }))
      .toBe("instagram_unverified");
  });
});
