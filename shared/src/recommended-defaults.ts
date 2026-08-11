import type { Agorot } from "./money.js";

// Recommended-defaults spec (AIC-49): the single documented source of truth
// for what the campaign builder recommends at every step. Consumed by the
// builder UI (AIC-52) and the create-writes (AIC-50); referenced by the
// first-campaign-review "rebuild to standard" language (AIC-18/38, see
// docs/features/ops-console.md). Never re-hardcode an opinion in a UI
// component — import it from here. Everything here is a RECOMMENDATION: the
// customer/operator can change any of it in the builder; nothing is a hard
// constraint except where Meta itself fixes the choice (objective/buying-
// type/destination are P0-fixed, not presented as a choice at all — see
// AIC-52 step 1, "not shown as a choice").

// ── P0-fixed choices (not recommendations — there is no alternative in P0) ──
export const FIXED_OBJECTIVE = "OUTCOME_LEADS"; // Meta campaign objective
export const FIXED_BUYING_TYPE = "AUCTION";
export const FIXED_DESTINATION = "whatsapp"; // Click-to-WhatsApp, PRD-mandated in P0

// ── Structure (AIC-38: the single-ad-set ideal is a RECOMMENDATION, never an
// assumption the engine/review may rely on — a customer can and does run more) ──
export const RECOMMENDED_STRUCTURE = {
  adSetCount: 1,
  adCountMin: 3,
  adCountMax: 5,
  rationale:
    "ממליצים להתחיל בקבוצת מודעות אחת עם 3–5 מודעות שונות — כך המנוע יכול להשוות בין המודעות ולזהות מה עובד הכי מהר. אפשר תמיד לפצל לפי קהל בהמשך.",
} as const;

// ── Placements ────────────────────────────────────────────────────────────
export const RECOMMENDED_PLACEMENTS = {
  advantagePlus: true,
  rationale:
    "השארת המיקומים אוטומטיים (Advantage+) נותנת למטא לחפש את המיקום הזול ביותר לכל ליד. צמצום מיקומים ידני בדרך כלל מעלה את העלות לפנייה בלי לשפר את האיכות.",
} as const;

// ── Budget: a starting range, framed honestly as "enough to gather data" —
// never a guaranteed-exact number, since real CPL varies by category/creative. ──
export const RECOMMENDED_BUDGET_AGOROT_PER_DAY: { min: Agorot; max: Agorot; recommended: Agorot; rationale: string } = {
  min: 3000, // ₪30
  max: 5000, // ₪50
  recommended: 4000, // ₪40
  rationale:
    "תקציב של כ־₪40 ליום נותן למנוע מספיק נתונים תוך כשבוע כדי להתחיל להשוות מודעות ולזהות מה מביא פניות בעלות טובה. אפשר להתחיל נמוך יותר ולהעלות בהמשך — זו נקודת פתיחה, לא מספר קבוע.",
};

// ── Special Ad Category (Meta compliance) ───────────────────────────────────
// A campaign that relates to credit, employment, housing, or social issues/
// elections MUST declare it — Meta restricts targeting for these by law/policy.
// The default is always NONE; the builder must ask the question explicitly
// every time and only change this on a real yes, never inferred silently.
export const SPECIAL_AD_CATEGORY = ["NONE", "CREDIT", "EMPLOYMENT", "HOUSING", "ISSUES_ELECTIONS_POLITICS"] as const;
export type SpecialAdCategory = (typeof SPECIAL_AD_CATEGORY)[number];
export const RECOMMENDED_SPECIAL_AD_CATEGORY: SpecialAdCategory = "NONE";
export const SPECIAL_AD_CATEGORY_QUESTION =
  "האם העסק שלכם עוסק באשראי, תעסוקה/גיוס עובדים, נדל\"ן/דיור, או נושאים חברתיים/פוליטיים?";

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
  radiusKm: number;
  rationale: string;
}

export const CATEGORY_AUDIENCE_DEFAULTS: Record<BusinessCategory, AudienceDefault> = {
  beautician: {
    ageMin: 18, ageMax: 45, genders: "female", radiusKm: 8,
    rationale: "עסקי יופי וטיפוח מתבססים על תנועה מקומית — רדיוס צר ונשים 18–45 בדרך כלל הקהל הרלוונטי ביותר.",
  },
  fitness: {
    ageMin: 20, ageMax: 45, genders: "all", radiusKm: 8,
    rationale: "אימונים וכושר תלויים בנוחות ההגעה — רדיוס מקומי, וקהל רחב משני המגדרים.",
  },
  tutor: {
    ageMin: 28, ageMax: 55, genders: "all", radiusKm: 15,
    rationale: "בהוראה פרטית ההורים (או התלמידים הבוגרים) הם מקבלי ההחלטה — קהל רחב יותר, כולל היכן שהם יהיו מוכנים לנסוע.",
  },
  restaurant: {
    ageMin: 18, ageMax: 55, genders: "all", radiusKm: 5,
    rationale: "מסעדות ובתי קפה מבוססים כמעט לגמרי על תנועה מקומית — רדיוס צר מאוד וקהל רחב.",
  },
  home_services: {
    ageMin: 28, ageMax: 60, genders: "all", radiusKm: 20,
    rationale: "בעלי מקצוע שמגיעים אל הלקוח (אינסטלציה, חשמל, ניקיון) יכולים לכסות רדיוס רחב יותר.",
  },
  retail: {
    ageMin: 20, ageMax: 55, genders: "all", radiusKm: 10,
    rationale: "חנות מקומית פונה לרוב לתנועה באזור — רדיוס בינוני וקהל רחב.",
  },
  health_wellness: {
    ageMin: 25, ageMax: 60, genders: "all", radiusKm: 12,
    rationale: "קליניקות וטיפולים בריאותיים מושכים קהל מקומי-אזורי רחב יחסית.",
  },
  professional_services: {
    ageMin: 30, ageMax: 60, genders: "all", radiusKm: 25,
    rationale: "שירותים מקצועיים (ייעוץ, ראיית חשבון וכו') — לקוחות מוכנים לנסוע יותר עבור מומחיות, רדיוס רחב.",
  },
  real_estate: {
    ageMin: 28, ageMax: 55, genders: "all", radiusKm: 30,
    rationale: "נדל\"ן פונה לאזור שלם ולא רק לשכונה — רדיוס רחב.",
  },
  other: {
    ageMin: 18, ageMax: 65, genders: "all", radiusKm: 15,
    rationale: "אין לנו עדיין המלצה ספציפית לתחום הזה — התחלה רחבה וניתנת לשינוי לפי מה שתדעו על הלקוחות שלכם.",
  },
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
