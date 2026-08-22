import { formatShekel } from "@aic/shared";
import type { RecommendationRecord } from "./types.js";
import type { NoActionReason } from "./rules.js";

// ── Centralized Hebrew copy for customer-facing explanations ──────────────────
// Kept in one place (never scattered through logic). Figures are injected by
// CODE from the structured recommendation — the text never generates a number.
export const EXPLAINER_HE = {
  pauseCreative: (spend: string, leads: string) =>
    `מודעה אחת הוציאה ${spend} וקיבלה ${leads} פניות בלבד, בזמן שהמודעות האחרות מביאות פניות בעלות נמוכה משמעותית. אנחנו ממליצים לעצור אותה.`,
  increaseBudget: (from: string, to: string) =>
    `הקמפיין מביא פניות בעלות טובה כבר כמה ימים. אנחנו ממליצים להגדיל את התקציב היומי מ־${from} ל־${to}.`,
  decreaseBudget: (from: string, to: string) =>
    `עלות הפנייה עלתה בתקופה האחרונה. אנחנו ממליצים להוריד זמנית את התקציב היומי מ־${from} ל־${to}.`,
  replaceCreative: () =>
    `הביצועים של אחת המודעות נחלשו משמעותית לעומת הביצועים הקודמים שלה. אנחנו ממליצים להחליף את הקריאייטיב.`,
  // Named by its human dimension (AIC-37, e.g. "35–45" / "נשים" / a city) — never
  // "ad set N". Falls back to the generic phrasing if no label was derivable.
  pauseAudience: (label: string | null) =>
    label
      ? `הקהל ${label} מביא פניות ביקר משמעותית מהקהל האחר. אנחנו ממליצים לעצור אותו ולהפנות את התקציב לקהל שמביא תוצאות טובות יותר.`
      : `אחד הקהלים בקמפיין מביא פניות בעלות גבוהה משמעותית מהקהל השני. אנחנו ממליצים לעצור אותו ולהפנות את התקציב לקהל שמביא תוצאות טובות יותר.`,
  stable: () => `הקמפיין יציב ואין כרגע שינוי שאנחנו ממליצים לבצע.`,
  collecting: () => `אין כרגע מספיק מידע שמצדיק שינוי. נמשיך לעקוב.`,
  budgetBelowThreshold: () => `בתקציב הנוכחי אנחנו לא יכולים לזהות מה עובד. שווה לשקול להעלות אותו.`,
  deliveryBlocked: () => `אחת מקבוצות הפרסום לא מתפרסמת כרגע, כך שאין לנו עדיין תמונה מלאה.`,
  // AIC-88: the conversions ARE happening on Meta; we're not counting them,
  // because the campaign's configured lead event doesn't match what the ad
  // sets optimize for. Says plainly that the numbers are wrong and that it's
  // on us to fix — never implies the campaign is failing.
  trackingBroken: () => `יש אצלנו אי-התאמה בהגדרת מדידת הפניות בקמפיין הזה, כך שהפניות שמגיעות לא נספרות ומספרי הביצועים כאן אינם מלאים. אנחנו כבר על זה — לא נמליץ על שינויים עד שנתקן, כדי לא להסתמך על נתון שגוי.`,
  // AIC-85: replaces singleAdSet — same content, renamed to match the fixed
  // comparableAdsets() check (a dormant ad set no longer silently counts).
  noComparableAudiences: () => `הקמפיין יציב. יש כרגע קהל אחד פעיל, כך שאין עם מה להשוות כדי להמליץ על שינוי קהל.`,
  // Found 2026-08-22: `cooling_down` had NO case in explain(), so it fell to
  // `default: stable()` — "the campaign is stable" — while the web surface
  // said "עוקבים אחרי השינוי האחרון" for the very same reason. Two copy
  // sources contradicting each other about one state. Dormant in practice
  // (no_action is never persisted as a row, so explain() never saw it), but a
  // latent lie, and the switch below is now exhaustive so it cannot recur.
  coolingDown: () =>
    `ביצענו שינוי בקמפיין לאחרונה, ואנחנו נותנים לו זמן לפעול לפני שנמליץ על שינוי נוסף. שינוי על גבי שינוי לא מאפשר לדעת מה מהם עבד.`,
  belowObjectEvidenceFloor: () => `יש לנו כמה עיצובים או קהלים להשוות, אבל עדיין לא מספיק נתונים על כל אחד כדי לדעת מה עובד טוב יותר. נמשיך לעקוב.`,
  // Defensive — see rules.ts's classifyNoAction comment: in practice the
  // AIC-86 advisory recommendation intercepts this condition first.
  noComparableCreatives: () => `יש כרגע מודעה אחת בלבד בקמפיין, כך שאין עם מה להשוות כדי להמליץ על שינוי עיצוב.`,
  // AIC-86: advisory, two axes — with real performance data to open on vs.
  // the day-one case where there isn't one yet, and whether the sole
  // creative is a flexible ad (AIC-36: Meta collapses several designs into
  // one comparable object, so "add creatives" really means "split it").
  addCreativesWithData: (leads: string, avgCpl: string, isFlexibleAd: boolean) =>
    `הקמפיין רץ יפה — ${leads} פניות בעלות ממוצעת של ${avgCpl}. ` +
    (isFlexibleAd
      ? `המודעה שרצה היא מודעה גמישה שמשלבת כמה עיצובים וטקסטים יחד, ולכן אין לנו איך לדעת איזה שילוב ` +
        `הכי טוב. עם כמה מודעות נפרדות נוכל לזהות מה עובד, לעצור את החלש ולהעביר את התקציב למה שמביא תוצאות.`
      : `כרגע רצה מודעה אחת בלבד, ולכן אין לנו מה להשוות — אנחנו לא יכולים לדעת איזה עיצוב מביא את הפניות ` +
        `הזולות ביותר. עם 3–4 מודעות במקביל נוכל לזהות מה עובד, לעצור את החלשות ולהעביר את התקציב למה שמביא תוצאות.`),
  addCreativesNoData: (isFlexibleAd: boolean) =>
    `הקמפיין רק התחיל לרוץ. ` +
    (isFlexibleAd
      ? `המודעה שרצה היא מודעה גמישה שמשלבת כמה עיצובים וטקסטים יחד — כדי שבעתיד נוכל לדעת איזה שילוב ` +
        `עובד הכי טוב, כדאי כבר עכשיו לפצל אותה למספר מודעות נפרדות.`
      : `כרגע רצה מודעה אחת בלבד — כדי שבעתיד נוכל לדעת איזה עיצוב עובד הכי טוב, כדאי כבר עכשיו להוסיף ` +
        `עוד 2–3 מודעות, כך שברגע שיהיו תוצאות יהיה עם מה להשוות.`),
  weeklyStable: (leads: string, avgCpl: string) =>
    `השבוע התקבלו ${leads} פניות בעלות ממוצעת של ${avgCpl}. הביצועים יציבים ואין כרגע צורך בשינוי.`,
} as const;

// Ads Manager jargon the customer must never see (PRD §5.1 / §17).
const FORBIDDEN_JARGON = [
  "cpm", "ctr", "cpc", "roas", "ad set", "ad-set", "adset",
  "attribution", "impression", "frequency", "placement", "learning phase",
];

function n(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0);
}

// The figures that MUST appear verbatim in the rendered text — the anchor for the
// number-fidelity guarantee. If an LLM rephrase drops or changes any, we reject it.
export function requiredFigures(rec: RecommendationRecord): string[] {
  switch (rec.type) {
    case "pause_creative":
      return [formatShekel(n(rec.evidence.spendAgorot)), String(n(rec.evidence.leads))];
    case "increase_budget":
    case "decrease_budget":
      return [
        formatShekel(n(rec.currentBudgetAgorot)),
        formatShekel(n(rec.proposedBudgetAgorot)),
      ];
    case "add_creatives_for_comparison": {
      const leads = n(rec.evidence.currentLeads);
      if (leads <= 0) return [];
      return [String(leads), formatShekel(n(rec.evidence.currentCplAgorot))];
    }
    default:
      return [];
  }
}

// Deterministic, always-available explanation. This is the source of truth; the
// LLM (if used) may only rephrase it, never change its numbers.
export function explain(rec: RecommendationRecord): string {
  switch (rec.type) {
    case "pause_creative":
      return EXPLAINER_HE.pauseCreative(
        formatShekel(n(rec.evidence.spendAgorot)),
        String(n(rec.evidence.leads)),
      );
    case "pause_adset":
      return EXPLAINER_HE.pauseAudience(
        typeof rec.evidence.audienceLabel === "string" ? rec.evidence.audienceLabel : null,
      );
    case "increase_budget":
      return EXPLAINER_HE.increaseBudget(
        formatShekel(n(rec.currentBudgetAgorot)),
        formatShekel(n(rec.proposedBudgetAgorot)),
      );
    case "decrease_budget":
      return EXPLAINER_HE.decreaseBudget(
        formatShekel(n(rec.currentBudgetAgorot)),
        formatShekel(n(rec.proposedBudgetAgorot)),
      );
    case "replace_creative":
      return EXPLAINER_HE.replaceCreative();
    case "add_creatives_for_comparison": {
      const leads = n(rec.evidence.currentLeads);
      const isFlexibleAd = rec.evidence.isFlexibleAd === true;
      return leads > 0
        ? EXPLAINER_HE.addCreativesWithData(String(leads), formatShekel(n(rec.evidence.currentCplAgorot)), isFlexibleAd)
        : EXPLAINER_HE.addCreativesNoData(isFlexibleAd);
    }
    case "no_action": {
      // `evidence` is a loose bag (Record<string, unknown>), so this switch was
      // never type-protected — which is how `cooling_down` silently fell
      // through to "stable". Narrowing to the real union restores the
      // exhaustiveness guarantee at the one place it matters.
      const reason = rec.evidence.reason as NoActionReason | undefined;
      switch (reason) {
        case "collecting":
          return EXPLAINER_HE.collecting();
        case "budget_below_threshold":
          return EXPLAINER_HE.budgetBelowThreshold();
        case "delivery_blocked":
          return EXPLAINER_HE.deliveryBlocked();
        case "tracking_broken":
          return EXPLAINER_HE.trackingBroken();
        case "no_comparable_audiences":
          return EXPLAINER_HE.noComparableAudiences();
        case "no_comparable_creatives":
          return EXPLAINER_HE.noComparableCreatives();
        case "below_object_evidence_floor":
          return EXPLAINER_HE.belowObjectEvidenceFloor();
        case "cooling_down":
          return EXPLAINER_HE.coolingDown();
        case "stable":
          return EXPLAINER_HE.stable();
        case undefined:
          // No reason recorded (an older row, or a write that failed) — the
          // neutral statement is the honest one.
          return EXPLAINER_HE.stable();
        default: {
          // Exhaustive by construction: a new NoActionReason without copy here
          // is a COMPILE error, not a silent fallback to "stable". The web
          // surface already had this discipline (Record<NoActionReason, ...>);
          // this switch did not, which is exactly how cooling_down came to
          // claim the campaign was stable.
          const _exhaustive: never = reason;
          void _exhaustive;
          return EXPLAINER_HE.stable();
        }
      }
    }
  }
}

// Weekly status summary (PRD §17 example).
export function explainWeeklyStatus(args: {
  leads: number;
  avgCplAgorot: number | null;
}): string {
  return EXPLAINER_HE.weeklyStable(
    String(args.leads),
    args.avgCplAgorot === null ? "—" : formatShekel(args.avgCplAgorot),
  );
}

export interface LlmRephraser {
  rephrase(base: string, guard: string): Promise<string>;
}

const REPHRASE_GUARD =
  "נסח מחדש בעברית פשוטה ועסקית. אל תשנה, תוסיף או תסיר אף מספר או סכום. אל תשתמש במונחים טכניים של פרסום.";

// Explain with optional LLM smoothing. The LLM may only rephrase; the result is
// accepted ONLY if every required figure survives verbatim and no jargon appears.
// On no LLM, empty output, dropped/changed number, or jargon → the template.
export async function explainWithLlm(
  rec: RecommendationRecord,
  llm?: LlmRephraser,
): Promise<string> {
  const base = explain(rec);
  if (!llm) return base;

  let candidate: string;
  try {
    candidate = (await llm.rephrase(base, REPHRASE_GUARD)) ?? "";
  } catch {
    return base;
  }
  if (!candidate.trim()) return base;

  const figures = requiredFigures(rec);
  const allFiguresPresent = figures.every((f) => candidate.includes(f));
  const jargonFree = !FORBIDDEN_JARGON.some((j) =>
    candidate.toLowerCase().includes(j),
  );
  return allFiguresPresent && jargonFree ? candidate : base;
}

export { FORBIDDEN_JARGON };
