import type { Agorot } from "./money.js";

// Recommended-defaults spec (AIC-49): the single documented source of truth
// for what the campaign builder recommends at every step. Consumed by the
// builder UI (AIC-52) and the create-writes (AIC-50); referenced by the
// first-campaign-review "rebuild to standard" language (AIC-18/38, see
// docs/features/ops-console.md). Never re-hardcode a NUMBER or a STRUCTURAL
// choice in a UI component — import it from here. Everything here is a
// RECOMMENDATION: the customer/operator can change any of it in the builder;
// nothing is a hard constraint except where Meta itself fixes the choice
// (objective/buying-type/destination are P0-fixed, not presented as a choice
// at all — see AIC-52 step 1, "not shown as a choice"). COPY-FREE (AIC-52):
// no Hebrew lives here — every rationale/question the builder displays lives
// in web/src/strings.ts's `builder` section, keyed to match these values.

// ── P0-fixed choices (not recommendations — there is no alternative in P0) ──
export const FIXED_OBJECTIVE = "OUTCOME_LEADS"; // Meta campaign objective
export const FIXED_BUYING_TYPE = "AUCTION";
export const FIXED_DESTINATION = "whatsapp"; // Click-to-WhatsApp, PRD-mandated in P0
export const FIXED_CTA = "WHATSAPP_MESSAGE"; // Meta call_to_action.type — follows from FIXED_DESTINATION, not a separate choice (AIC-51)
export const FIXED_BID_STRATEGY = "LOWEST_COST_WITHOUT_CAP"; // no bid-strategy step in the builder (AIC-52) — not presented as a choice
// Placements are FIXED in P0, not a recommendation: createAdSet sends no
// placement field at all, so Meta uses automatic (Advantage+) placements and
// there is no code path to narrow them. Presented in the builder as a fixed
// choice with an explanation, NOT a badged "recommended" option the customer
// could change — the same honesty as objective/buying-type above.
export const FIXED_PLACEMENTS = "advantage_plus";

// The Meta ad-set/creative fields a given lead destination needs. Structural,
// not copy — same rule as everything else in this file: never re-hardcode
// these strings at a call site, resolve them from here.
//
// Bug fix, 2026-08-14: FIXED_DESTINATION/FIXED_CTA had ZERO consumers before
// this — the literals they were meant to own ("CONVERSATIONS", "WHATSAPP",
// "WHATSAPP_MESSAGE") were re-hardcoded directly in
// `server/src/meta/campaign-adapter.ts`'s `createAdSet`/
// `createCreativeFromUpload`, which is exactly how a Pixel campaign got sent
// a WhatsApp-shaped Meta write (a customer's own lead type never entered the
// decision). `resolveDestinationShape` makes the constants the actual single
// source, and — the part that matters more than tidiness — THROWS for an
// unrecognized destination instead of silently falling back to the WhatsApp
// shape, so a caller can never emit a wrong write by omission. Every caller
// of `createAdSet`/`createCreativeFromUpload` now passes an explicit
// `destination` sourced from `FIXED_DESTINATION`; a second destination
// (AIC-89) is added by extending this map, not by hunting down literals.
export interface DestinationShape {
  optimizationGoal: string;
  destinationType: string;
  ctaType: string;
}

const DESTINATION_SHAPES: Record<string, DestinationShape> = {
  [FIXED_DESTINATION]: { optimizationGoal: "CONVERSATIONS", destinationType: "WHATSAPP", ctaType: FIXED_CTA },
};

export function resolveDestinationShape(destination: string): DestinationShape {
  const shape = DESTINATION_SHAPES[destination];
  if (!shape) {
    throw new Error(
      `resolveDestinationShape: no Meta ad shape known for destination "${destination}" — ` +
        `AIC-89 must add one here before a campaign with this destination can be built or added to`,
    );
  }
  return shape;
}

// ── Structure (AIC-38: the single-ad-set ideal is a RECOMMENDATION, never an
// assumption the engine/review may rely on — a customer can and does run more) ──
export const RECOMMENDED_STRUCTURE = {
  adSetCount: 1,
  adCountMin: 3,
  adCountMax: 5,
} as const;

// ── Budget: a starting range, framed honestly as "enough to gather data" —
// never a guaranteed-exact number, since real CPL varies by category/creative. ──
export const RECOMMENDED_BUDGET_AGOROT_PER_DAY: { min: Agorot; max: Agorot; recommended: Agorot } = {
  min: 3000, // ₪30
  max: 5000, // ₪50
  recommended: 4000, // ₪40
};

// ── Special Ad Category (Meta compliance) ───────────────────────────────────
// A campaign that relates to credit, employment, housing, or social issues/
// elections MUST declare it — Meta restricts targeting for these by law/policy.
// The default is always NONE; the builder must ask the question explicitly
// every time and only change this on a real yes, never inferred silently.
export const SPECIAL_AD_CATEGORY = ["NONE", "CREDIT", "EMPLOYMENT", "HOUSING", "ISSUES_ELECTIONS_POLITICS"] as const;
export type SpecialAdCategory = (typeof SPECIAL_AD_CATEGORY)[number];
export const RECOMMENDED_SPECIAL_AD_CATEGORY: SpecialAdCategory = "NONE";

// ── Business-category → audience defaults ───────────────────────────────────
// Deliberately a SMALL, curated set (not a taxonomy) — covers the common P0
// Israeli-SMB categories with sensible starting points; anything unrecognized
// resolves to `other`'s broad, honest default rather than guessing.
export const BUSINESS_CATEGORY = [
  "beautician",
  "fitness",
  "tutor",
  "restaurant",
  "home_services",
  "retail",
  "health_wellness",
  "professional_services",
  "real_estate",
  "other",
] as const;
export type BusinessCategory = (typeof BUSINESS_CATEGORY)[number];

export interface AudienceDefault {
  ageMin: number;
  ageMax: number;
  genders: "all" | "male" | "female";
  // Reserved for real geo-targeting (AIC-54): P0 targets all of Israel and
  // does NOT wire this to Meta — createAdSet sends only age/gender/country.
  // Kept here as the per-category seed the geo ticket will use once we collect
  // a business location; the builder deliberately does NOT show it as an
  // editable control, since a control that silently discards its value is a lie.
  radiusKm: number;
}

export const CATEGORY_AUDIENCE_DEFAULTS: Record<BusinessCategory, AudienceDefault> = {
  beautician: { ageMin: 18, ageMax: 45, genders: "female", radiusKm: 8 },
  fitness: { ageMin: 20, ageMax: 45, genders: "all", radiusKm: 8 },
  tutor: { ageMin: 28, ageMax: 55, genders: "all", radiusKm: 15 },
  restaurant: { ageMin: 18, ageMax: 55, genders: "all", radiusKm: 5 },
  home_services: { ageMin: 28, ageMax: 60, genders: "all", radiusKm: 20 },
  retail: { ageMin: 20, ageMax: 55, genders: "all", radiusKm: 10 },
  health_wellness: { ageMin: 25, ageMax: 60, genders: "all", radiusKm: 12 },
  professional_services: { ageMin: 30, ageMax: 60, genders: "all", radiusKm: 25 },
  real_estate: { ageMin: 28, ageMax: 55, genders: "all", radiusKm: 30 },
  other: { ageMin: 18, ageMax: 65, genders: "all", radiusKm: 15 },
};

// A category commonly touching a Meta Special Ad Category — a HINT to prompt
// the operator/customer to double-check honestly at the question above, never
// an assumption the declaration is auto-set from (see RECOMMENDED_SPECIAL_AD_CATEGORY).
export const SPECIAL_AD_CATEGORY_HINT: Partial<Record<BusinessCategory, SpecialAdCategory>> = {
  real_estate: "HOUSING",
};

// Case/whitespace-insensitive lookup against the known set; anything outside
// it (free text from manual onboarding, AIC-44) resolves to `other` rather
// than throwing or guessing at an unrecognized category.
export function normalizeBusinessCategory(raw: string): BusinessCategory {
  const k = raw.trim().toLowerCase();
  return (BUSINESS_CATEGORY as readonly string[]).includes(k) ? (k as BusinessCategory) : "other";
}

export function resolveAudienceDefault(category: string): AudienceDefault {
  return CATEGORY_AUDIENCE_DEFAULTS[normalizeBusinessCategory(category)];
}

export function resolveSpecialAdCategoryHint(category: string): SpecialAdCategory | null {
  return SPECIAL_AD_CATEGORY_HINT[normalizeBusinessCategory(category)] ?? null;
}
