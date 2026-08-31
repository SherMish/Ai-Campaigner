// AIC-154 — what we call the campaigns, ad sets and ads WE create on Meta.
//
// There was no convention. Six call sites each built a name inline, and the
// results were, in order of how bad:
//
//   * every self-serve campaign was named `strings.he.appName` — literally
//     "Ads Agent". Not the business, not the destination, not a date. A
//     customer who built twice got two identical rows in their own Ads
//     Manager.
//   * ad sets were `${campaign name} — קהל 1`, where the 1 is a LITERAL, not
//     a counter. The builder only ever makes one ad set, so every build
//     produced another "…— קהל 1".
//   * ads were `מודעה ${i}` with i counted per DRAFTING SESSION, so
//     add-content dropped a second "מודעה 1" into an ad set that already had
//     one.
//
// The names live in the customer's own ad account, next to campaigns they
// made themselves, and they are what an operator reads when something is
// wrong at 9pm. One module, so they cannot drift again.
//
// WE NEVER RENAME. Everything here is applied at CREATE time only. Every
// existing campaign, ad set and ad sits in a live customer account, and a
// rename is a Meta write nobody asked for — CLAUDE.md's live-account safety
// boundary. Adopted campaigns keep the customer's own names, permanently.
//
// Hebrew lives here rather than in web/src/strings.ts because these names are
// written server-side, at the moment of the Meta call, and the server cannot
// import the web bundle. Same precedent and same rule as
// `execution/strings.he.ts` and `audience-label.ts`: centralized in one map
// per module, never inline at a call site.

import { composeAudienceLabel, localizePlace } from "./audience-label.js";

/**
 * Marks the objects we manage inside an account that also holds the
 * customer's own campaigns — GelNails has five of their own. This is what
 * "Ads Agent" was actually good for; the bug was that it was the WHOLE name
 * instead of the prefix.
 */
export const OUR_PREFIX = "Ads Agent";

const SEP = " · ";

const DESTINATION_HE: Record<string, string> = {
  whatsapp: "וואטסאפ",
  website: "אתר",
  engagement: "פוסט",
};

const AD_PREFIX = "מודעה";

/**
 * `Ads Agent · וואטסאפ · 2026-08`
 *
 * Prefix, what the campaign actually does, and when we started it — the three
 * things that distinguish one of our campaigns from another of ours in a list.
 * The month rather than the day: a campaign is a months-long object, and a
 * name that implies a launch DATE invites reading it as a date range.
 *
 * THROWS on an unknown destination, deliberately, exactly as
 * `resolveDestinationShape` does for the same class of value. A destination we
 * have no word for is a destination someone added without finishing the job;
 * falling back to a generic name would ship it silently onto a customer's
 * account.
 */
export function campaignName(input: { destination: string; createdAt: Date }): string {
  const destination = DESTINATION_HE[input.destination];
  if (!destination) {
    throw new Error(
      `campaignName: no Hebrew name known for destination "${input.destination}" — ` +
        `add one to DESTINATION_HE before a campaign with this destination can be built`,
    );
  }
  const y = input.createdAt.getFullYear();
  const m = String(input.createdAt.getMonth() + 1).padStart(2, "0");
  return [OUR_PREFIX, destination, `${y}-${m}`].join(SEP);
}

/**
 * The audience, in the same words the customer is shown: `נשים · 35–55 · ישראל`.
 *
 * Built by the SAME composer that produces the audience labels on the
 * dashboard (`composeAudienceLabel`), which is the point. Those labels are
 * derived from what Meta reports about the ad set; this name is written to
 * Meta at create time. Two independent formatters for one concept would agree
 * on the day they were written and drift after that — an operator comparing
 * the dashboard to Ads Manager has to be able to trust that the same audience
 * reads the same way in both.
 *
 * Drops the campaign name the old format repeated: Meta already nests an ad
 * set under its campaign, so restating it spent the whole name on something
 * the surrounding UI shows anyway.
 */
export function adSetName(targeting: {
  ageMin: number | null;
  ageMax: number | null;
  genders: "all" | "male" | "female";
  countries?: string[] | null;
  // AIC-157: the chosen cities/regions, when there are any. They REPLACE the
  // country in the name for the same reason they replace it in the Meta
  // payload — an ad set targeting Ramat Gan is not an ad set targeting Israel,
  // and a name saying otherwise is the kind of small lie that gets trusted.
  cities?: Array<{ name: string }> | null;
}): string {
  const places = targeting.cities?.length
    ? targeting.cities.map((c) => c.name)
    : (targeting.countries ?? []);
  return composeAudienceLabel({
    genders: targeting.genders,
    ageMin: targeting.ageMin,
    ageMax: targeting.ageMax,
    // Same two-place cap and same localization the display labels use, so a
    // city reads "רמת גן" here and on the dashboard rather than "Ramat Gan" in
    // one of them — Meta's geo search answers in English whatever you ask in.
    geoSummary: places.map(localizePlace).slice(0, 2).join(", "),
  });
}

/**
 * `מודעה 3`.
 *
 * DELIBERATELY AN INDEX AND NOTHING ELSE. The obvious alternative — name the
 * ad after its headline — is worse than it looks: the creative can be edited
 * on Meta afterwards and the name would not follow, leaving a label that
 * confidently describes copy the ad no longer runs. And nothing actually
 * needs the name to carry meaning: every consumer that wants to identify an
 * ad by its content already prefers the headline, then the primary text, and
 * only falls through to the name when both are absent
 * (`services/creative-context.ts`). So the name's one job is to be UNIQUE
 * inside its ad set, which is precisely the job it was failing.
 */
export function adName(index: number): string {
  return `${AD_PREFIX} ${index}`;
}

const AD_INDEX_PATTERN = new RegExp(`^${AD_PREFIX}\\s+(\\d+)$`);

/**
 * The next free index for an ad set that already holds `existingNames`.
 *
 * Takes the higher of "one past the biggest index we have used" and "one past
 * how many ads are already here". The second half is what makes it safe in an
 * ad set we did not create: an adopted ad set whose five ads carry the
 * customer's own names has no parsable index at all, and starting again from
 * 1 would produce a name that LOOKS like our first ad in a set of six.
 *
 * Names are read from Meta rather than counted locally because Meta is where
 * the truth is — an ad added through Ads Manager between two of our calls is
 * invisible to anything we store.
 */
export function nextAdIndex(existingNames: ReadonlyArray<string | null | undefined>): number {
  let highest = 0;
  for (const name of existingNames) {
    const m = name?.trim().match(AD_INDEX_PATTERN);
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return Math.max(highest, existingNames.length) + 1;
}
