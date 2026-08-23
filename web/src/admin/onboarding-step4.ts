// Which of step 4's two provisioning branches to render (AIC-119).
//
// Step 4 does two different jobs depending on the account:
//   - the account has NO campaigns  → we will BUILD one. Provisioning only
//     needs the agreed daily ceiling; the builder collects the name, the
//     destination and the WhatsApp number afterwards.
//   - the account HAS campaigns     → we may ADOPT one. Provisioning records
//     an existing campaign's own config, so it needs its name, its budget and
//     its WhatsApp destination.
//
// Found live: this was `!loadingCampaigns && !campaignsError && !!adAccountId
// && campaigns?.length === 0` for the first branch, with the second rendering
// on the plain negation. That negation is true before an ad account is even
// selected, so a customer with no Meta connection at all was shown the
// ADOPT form — שם הקמפיין, מספר וואטסאפ, "יצירת הרשומות" — with nothing to
// adopt. The button could only ever fail.
//
// The rule now, stated positively: absence of a loaded list is not evidence
// that a campaign exists. Each branch requires its own positive evidence, and
// the three states in between say so rather than defaulting into a form.
export type Step4Branch =
  | "pick_account" // no ad account chosen yet
  | "loading" // its campaign list is on the way
  | "error" // the list failed to load — do not guess
  | "new_campaign" // the account is known to have none
  | "adopt_existing"; // the account is known to have some

export function step4Branch(input: {
  adAccountId: string;
  loading: boolean;
  error: string | null;
  campaigns: Array<{ supported: boolean }> | null;
}): Step4Branch {
  if (!input.adAccountId) return "pick_account";
  if (input.loading) return "loading";
  if (input.error) return "error";
  // null = never loaded for this account. Treated as "still coming" rather than
  // as an empty account, which would offer to build a second campaign for an
  // account that already has one.
  if (input.campaigns === null) return "loading";
  return input.campaigns.length === 0 ? "new_campaign" : "adopt_existing";
}
