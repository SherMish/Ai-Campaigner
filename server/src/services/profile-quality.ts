// AIC-132: do we know enough about this business to advertise it?
//
// Every other health check asks whether the campaign's NUMBERS can be trusted.
// This one asks whether OUR OWN homework is done — and it is the only check
// that reads no Meta data at all, because the missing information was never
// Meta's to give.
//
// WHY IT MATTERS MORE THAN IT LOOKS. The failure is invisible in the output.
// Hand a copy generator "12 שנות ניסיון, מלווים עד החתימה" and it writes
// something specific; hand it nothing and it writes "שירות מקצועי ואמין, צרו
// קשר עוד היום" — equally fluent, equally confident, worthless. You cannot tell
// from the ad which input it had, so a downstream feature degrades silently
// while still producing polished-looking work.
//
// PRESENCE IS NOT THE CHECK. `geo_area = "Israel"` is technically an answer and
// passes any is-it-filled test, while telling targeting nothing — it produces
// exactly the country-wide spend that wastes the budget. So the gate is about
// SPECIFICITY.
//
// Rules only, deliberately. They catch the blatant cases for nothing. A real
// specificity judgement needs an LLM pass at capture time, and that is a
// separate decision rather than a hidden dependency of this one — see the
// ticket. Where the rules cannot tell, they say `ok`: a false alarm here nags
// an operator about a profile that is actually fine, which erodes the signal
// faster than a missed one.

export type ProfileState = "ok" | "thin" | "broken";

export interface ProfileInput {
  category?: string | null;
  mainService?: string | null;
  geoArea?: string | null;
  primaryCustomer?: string | null;
  offer?: string | null;
  differentiators?: string | null;
  objections?: string | null;
  priceRange?: string | null;
}

export interface ProfileSummary {
  state: ProfileState;
  // What is missing or too vague, in the order an operator should fix it.
  // Field names, not sentences — the UI owns the wording.
  missing: string[];
  vague: string[];
  reason: string | null;
}

const clean = (v: string | null | undefined) => (v ?? "").trim();
const words = (v: string) => v.split(/\s+/).filter(Boolean).length;

// Answers that name a whole country. Real for a remote service, useless for a
// local business — and we cannot tell which from this field alone, so it is
// `vague` (a nudge) rather than `broken` (a blocker). Matched as a WHOLE value:
// "כל הארץ (שירות מרחוק)" says the same thing but says it deliberately, and
// nagging someone who already explained themselves is how a check gets ignored.
const COUNTRY_ONLY = new Set([
  "ישראל", "כל הארץ", "כל המדינה", "ארצי", "israel", "nationwide", "countrywide", "all of israel",
]);

// Placeholder answers that fill the box and say nothing. Deliberately short:
// every entry is a phrase that could describe literally any business, so
// flagging it is never a judgement about THIS one.
const EMPTY_CALORIES = [
  "מקצועי", "אמין", "שירות מעולה", "איכות", "הכי טוב", "מחירים טובים",
  "professional", "reliable", "best quality", "great service",
];

function isFiller(v: string): boolean {
  const low = v.toLowerCase();
  // Only when the WHOLE answer is filler. "12 שנות ניסיון, שירות אמין" contains
  // one of these and is still a real answer.
  return EMPTY_CALORIES.some((f) => low === f || low === f + ".") ||
    (words(v) <= 3 && EMPTY_CALORIES.some((f) => low.includes(f)));
}

/**
 * Judge a business profile.
 *
 * `broken` is reserved for the two fields without which there is nothing to
 * say about the business at all: the OFFER (what you get if you click) and the
 * DIFFERENTIATORS (why them). Missing either, an ad can only compete on price,
 * which is the worst competition a small business can pick.
 *
 * Everything else is `thin` — a nudge, not a blocker.
 */
export function summarizeProfile(input: ProfileInput): ProfileSummary {
  const offer = clean(input.offer);
  const diff = clean(input.differentiators);
  const category = clean(input.category);
  const mainService = clean(input.mainService);
  const geo = clean(input.geoArea);
  const audience = clean(input.primaryCustomer);
  const objections = clean(input.objections);
  const price = clean(input.priceRange);

  const missing: string[] = [];
  const vague: string[] = [];

  if (!offer) missing.push("offer");
  if (!diff) missing.push("differentiators");

  // A category alone picks a default age range and nothing else. Without the
  // specific service, "professional_services" cannot produce a sentence.
  if (category && !mainService) vague.push("mainService");
  if (!category && !mainService) missing.push("mainService");

  if (!geo) missing.push("geoArea");
  else if (COUNTRY_ONLY.has(geo.toLowerCase())) vague.push("geoArea");

  if (!audience) missing.push("primaryCustomer");
  // "כולם" is the answer that feels safe and targets nobody.
  else if (/^(כולם|הכל|everyone|anyone)$/i.test(audience)) vague.push("primaryCustomer");

  // A one- or two-word offer is a label, not an offer: "ייעוץ" tells a reader
  // nothing they can act on.
  if (offer && words(offer) <= 2) vague.push("offer");
  if (offer && isFiller(offer)) vague.push("offer");
  if (diff && isFiller(diff)) vague.push("differentiators");

  // Not blockers — an ad can be written without them — but they are the two
  // fields that most change what the copy can DO, so a profile without them is
  // never fully `ok`.
  if (!objections) vague.push("objections");
  if (!price) vague.push("priceRange");

  const uniqueVague = [...new Set(vague)];

  if (missing.length > 0) {
    return {
      state: "broken",
      missing,
      vague: uniqueVague,
      reason: `missing: ${missing.join(", ")}`,
    };
  }
  if (uniqueVague.length > 0) {
    return {
      state: "thin",
      missing,
      vague: uniqueVague,
      reason: `too vague: ${uniqueVague.join(", ")}`,
    };
  }
  return { state: "ok", missing: [], vague: [], reason: null };
}
