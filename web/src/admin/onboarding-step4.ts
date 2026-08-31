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
// Having campaigns used to make adopting the ONLY reachable path.
// Adopting stays the default — an account with campaigns is usually one we are
// taking over — but the operator can override it and build a new campaign
// instead, which the builder already supported and Meta never objected to.
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
  /**
   * The operator chose to BUILD a campaign on an account that already has
   * some. Having campaigns made adopting one the only reachable
   * path, which is a restriction we invented — Meta is perfectly happy with a
   * second campaign, and an operator onboarding a customer who wants a fresh
   * one had nowhere to go.
   *
   * It overrides the campaigns-exist rule and NOTHING else: the three states
   * above are about whether we know anything yet, and an override cannot
   * manufacture knowledge. Honouring it before an ad account is picked would
   * render a form whose submit could only fail — the exact class of bug
   * AIC-119 fixed by making each branch require positive evidence.
   */
  forceNewCampaign?: boolean;
}): Step4Branch {
  if (!input.adAccountId) return "pick_account";
  if (input.loading) return "loading";
  if (input.error) return "error";
  if (input.forceNewCampaign) return "new_campaign";
  // null = never loaded for this account. Treated as "still coming" rather than
  // as an empty account, which would offer to build a second campaign for an
  // account that already has one.
  if (input.campaigns === null) return "loading";
  return input.campaigns.length === 0 ? "new_campaign" : "adopt_existing";
}

/**
 * Which ad accounts step 4 may offer.
 *
 * The picker used to list every ad account the System User can reach, which on
 * a real token means other customers' accounts too. A note said "בשימוש גם
 * עבור X" next to them, but a note is a poor guard against provisioning the
 * wrong account for a customer — and provisioning is the step that writes the
 * connection everything else is built on.
 *
 * Once an ad account has been VERIFIED for this customer earlier in the wizard,
 * that is the account this customer gets, so it is the only one offered.
 *
 * The escape hatch matters as much as the rule: if the verified account is not
 * in the fetched list — access changed, the list came back partial — filtering
 * would leave a required field that cannot be filled. Showing the full list
 * (with its existing warnings) beats trapping the operator in a form they
 * cannot submit.
 */
export function adAccountOptions<T extends { id: string }>(
  all: T[] | null,
  verifiedId: string | null | undefined,
): { options: T[]; scoped: boolean } {
  if (!all) return { options: [], scoped: false };
  const verified = verifiedId ? all.find((a) => a.id === verifiedId) : undefined;
  return verified ? { options: [verified], scoped: true } : { options: all, scoped: false };
}

/**
 * Why "צור קמפיין חדש" cannot be pressed yet — or null when it can.
 *
 * THIS EXISTS BECAUSE THE BUTTON WENT SILENT. Its disabled expression listed
 * four conditions, `startNewCampaign` re-checked the same four in its own
 * order, and the screen rendered explanations for TWO of them. An operator
 * with a picked-but-unchecked Instagram account got a dead primary button and
 * not one word about why — and could not reach the guard that knows, because
 * being disabled is exactly what stops the click.
 *
 * One ordered list, consumed by all three, so the button, its message and the
 * request cannot disagree. The order is the order the operator has to act in:
 * a Page before its check, both before Instagram's, the budget last because it
 * is the only one fixed without leaving this step.
 */
export type NewCampaignBlocker =
  | "page_missing"
  | "page_unverified"
  | "instagram_unverified"
  | "budget_missing";

export function newCampaignBlocker(input: {
  pageMissing: boolean;
  pageUnverified: boolean;
  instagramUnverified: boolean;
  budgetMissing: boolean;
}): NewCampaignBlocker | null {
  if (input.pageMissing) return "page_missing";
  if (input.pageUnverified) return "page_unverified";
  if (input.instagramUnverified) return "instagram_unverified";
  if (input.budgetMissing) return "budget_missing";
  return null;
}

/**
 * Why "יצירת הרשומות" cannot be pressed yet — or null when it can (AIC-161).
 *
 * THE SIBLING OF newCampaignBlocker, AND THE SAME BUG A SECOND TIME. That one
 * was a disabled button with no stated reason. This one was worse: the button
 * was ENABLED, `submitProvision` refused, and the refusal went to a `setError`
 * rendered ~570 lines up the page in the header — most of a screen away from
 * the button that was clicked. So it read as "nothing happens".
 *
 * The four field checks also shared one `errorGeneric` naming none of them, so
 * even scrolled to, it could not say which box to fill.
 *
 * Order is the order the operator acts in: pick the thing, verify the thing,
 * then fill what the chosen destination needs. `incomplete_config` carries the
 * field list because the server names them and dropping it puts the operator
 * back to guessing.
 */
export type ProvisionBlocker =
  | { reason: "ad_account_missing" }
  | { reason: "campaign_missing" }
  | { reason: "name_missing" }
  | { reason: "budget_missing" }
  | { reason: "page_unverified" }
  | { reason: "instagram_unverified" }
  | { reason: "incomplete_config"; fields: string[] };

export function provisionBlocker(input: {
  adAccountMissing: boolean;
  campaignMissing: boolean;
  nameMissing: boolean;
  budgetMissing: boolean;
  pageUnverified: boolean;
  instagramUnverified: boolean;
  missingConfigFields: string[];
}): ProvisionBlocker | null {
  if (input.adAccountMissing) return { reason: "ad_account_missing" };
  if (input.campaignMissing) return { reason: "campaign_missing" };
  if (input.nameMissing) return { reason: "name_missing" };
  if (input.budgetMissing) return { reason: "budget_missing" };
  if (input.pageUnverified) return { reason: "page_unverified" };
  if (input.instagramUnverified) return { reason: "instagram_unverified" };
  if (input.missingConfigFields.length > 0) {
    return { reason: "incomplete_config", fields: input.missingConfigFields };
  }
  return null;
}
