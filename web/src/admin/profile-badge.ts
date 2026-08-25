import { strings } from "../strings";
import type { CustomerWriteFields } from "../api";

const w = strings.he.onboardingWizard;

// AIC-132: the client-side mirror of summarizeProfile, so the wizard badge
// updates as the operator types rather than only after a save + a tick.
//
// A DELIBERATE SECOND IMPLEMENTATION, which is normally the thing to avoid —
// justified here because the two answer different questions at different
// moments. The server's verdict is the one of record: it drives suppression,
// the ops item and the no-rec reason, and it must be computed from what was
// actually STORED. This one is a live hint about the text currently in the
// boxes, before any of it has been saved.
//
// The risk is drift, so the rules are kept blunt and identical in spirit, and
// a pure function on both sides is tested on both sides. If they ever disagree
// the server wins by construction — nothing downstream reads this one.
export type BadgeState = "ok" | "thin" | "broken";

export interface Badge {
  state: BadgeState;
  missing: string[];
  vague: string[];
}

const COUNTRY_ONLY = new Set([
  "ישראל", "כל הארץ", "כל המדינה", "ארצי", "israel", "nationwide", "countrywide", "all of israel",
]);
const FILLER = ["מקצועי", "אמין", "שירות מעולה", "איכות", "הכי טוב", "מחירים טובים"];

const t = (v: unknown) => String(v ?? "").trim();
const words = (v: string) => v.split(/\s+/).filter(Boolean).length;

export function profileBadge(form: CustomerWriteFields): Badge {
  const missing: string[] = [];
  const vague: string[] = [];

  const offer = t(form.offer);
  const diff = t(form.differentiators);
  const geo = t(form.geoArea);
  const audience = t(form.primaryCustomer);

  if (!offer) missing.push("offer");
  if (!diff) missing.push("differentiators");
  if (!t(form.category) && !t(form.mainService)) missing.push("mainService");
  else if (t(form.category) && !t(form.mainService)) vague.push("mainService");
  if (!geo) missing.push("geoArea");
  else if (COUNTRY_ONLY.has(geo.toLowerCase())) vague.push("geoArea");
  if (!audience) missing.push("primaryCustomer");
  else if (/^(כולם|הכל|everyone|anyone)$/i.test(audience)) vague.push("primaryCustomer");

  if (offer && words(offer) <= 2) vague.push("offer");
  if (diff && words(diff) <= 3 && FILLER.some((f) => diff.toLowerCase().includes(f))) vague.push("differentiators");
  if (!t(form.objections)) vague.push("objections");
  if (!t(form.priceRange)) vague.push("priceRange");

  const uniqueVague = [...new Set(vague)];
  if (missing.length > 0) return { state: "broken", missing, vague: uniqueVague };
  if (uniqueVague.length > 0) return { state: "thin", missing, vague: uniqueVague };
  return { state: "ok", missing: [], vague: [] };
}

export function badgeLabel(state: BadgeState): string {
  return state === "ok" ? w.profileBadgeOk : state === "thin" ? w.profileBadgeThin : w.profileBadgeBroken;
}

export function fieldNames(keys: string[]): string {
  return keys.map((k) => w.profileFieldNames[k] ?? k).join(", ");
}
