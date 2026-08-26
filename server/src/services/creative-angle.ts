// AIC-78: which ANGLE an ad's copy takes.
//
// The point of knowing is memory: "we already tried price twice and it didn't
// work" is the difference between a suggestion about this business and generic
// marketing filler. Without it, whoever writes the next ad — a person today, a
// generator later — re-proposes the angle that already failed.
//
// RULE-BASED, AND DELIBERATELY WILLING TO SAY "I DON'T KNOW". An LLM would
// classify more copy, and would also produce a confident label for an ad that
// takes no clear angle at all. A tested-angles list is only useful if it is
// TRUE, so this returns null the moment the copy doesn't clearly commit — and
// the context reports how many ads it could not classify, so "we tried price"
// is never read as "we tried everything except price".
//
// Hebrew-first because every ad we write is Hebrew; the English terms that
// appear are the ones that actually show up in Israeli small-business copy.

export const ANGLES = [
  "price",        // מחיר, מבצע, הנחה — the cheapest angle to reach for, and the most common
  "speed",        // זמינות מיידית, היום, תוך שעה
  "experience",   // ותק, שנות ניסיון, מומחיות
  "trust",        // המלצות, לקוחות מרוצים, אחריות
  "outcome",      // what the customer ends up with
  "objection",    // copy that pre-empts the hesitation ("בלי התחייבות")
  "local",        // באזור, קרוב אליכם, שם היישוב
] as const;

export type Angle = (typeof ANGLES)[number];

// Each angle needs a term that COMMITS to it. "שירות" is not an angle;
// "12 שנות ניסיון" is. Terms are matched as substrings on normalized text, so
// prefixes with ו/ב/ל/ה attached still hit.
const TERMS: Record<Angle, readonly string[]> = {
  // The cost vocabulary that ACTUALLY appears in Israeli small-business copy.
  // Found by running this over real live ads: "עדיין משלמים אלפי שקלים?" is a
  // price angle in every sense, and the first version classified it as
  // `experience` because it matched nothing here at all.
  price: ["מחיר", "מבצע", "הנחה", "בזול", "משתלם", "החל מ", "ללא עלות", "חינם", "עלות",
    "משלם", "משלמים", "לשלם", "שקלים", "ריטיינר", "תשלום", "₪"],
  // "היום" and "עכשיו" are deliberately ABSENT. They are CTA words — "צרו קשר
  // עוד היום" ends half the ads ever written and commits to nothing — and
  // including them classified generic filler as a speed angle. Caught by the
  // test that says unclear copy must come back null.
  speed: ["מיידי", "מיידית", "תוך שעה", "תוך יום", "זמינות", "מהיר", "מהירה", "בו ביום", "הגעה תוך"],
  // Bare "שנות" is GONE: it is a substring of "לשנות" (to change), and a live
  // ad reading "מזהה מה כדאי לשנות" was filed as an experience claim. The
  // phrase carries the angle; the bare word carries a collision.
  experience: ["ניסיון", "שנות ניסיון", "ותק", "מומחה", "מומחים", "מומחיות", "מקצוענים", "שנים בתחום"],
  trust: ["המלצות", "ממליצים", "לקוחות מרוצים", "אחריות", "מוסמך", "מורשה", "דירוג", "ביקורות", "אלפי לקוחות"],
  outcome: ["תוצאה", "תוצאות", "לפני ואחרי", "תיהנו", "תקבלו", "תחסכו", "בלי כאב", "שקט נפשי"],
  objection: ["בלי התחייבות", "ללא התחייבות", "בלי מחויבות", "אפשר לבטל", "בדיקה חינם", "ייעוץ ללא", "לא משלמים", "בלי הפתעות"],
  local: ["באזור", "קרוב אליכם", "בקרבת", "תושבי", "אזור ה", "בכל אזור"],
};

// Punctuation and repeated whitespace only — never strip Hebrew niqqud or
// letters, which would break the very terms we match on.
function normalize(text: string): string {
  return text.replace(/[\n\r\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

// Phrases where one of our terms appears as part of a DIFFERENT word. Hebrew
// glues prefixes on and has no capitalisation, so a plain substring search
// finds "מבצע" (a sale) inside "ומבצע שינויים" (performs changes) and reads an
// operations sentence as a discount offer.
//
// Every entry earned its place by firing on a real live ad. The list is meant
// to grow that way — from observed collisions — rather than from imagination.
const COLLISIONS: readonly string[] = ["מבצע שינויים", "מבצע פעולות", "לשנות"];

// A term matches at a word start, allowing the prefix letters that attach in
// Hebrew (ו/ב/ל/ה/מ/ש/כ) — "בחינם" has to count as "חינם". Matching the END
// loosely is deliberate: plural and possessive suffixes are exactly what we
// want to absorb.
function countTerm(haystack: string, term: string): number {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[^\\p{Script=Hebrew}])[ובלהמשכ]{0,2}${escaped}`, "gu");
  return (haystack.match(re) ?? []).length;
}

export interface AngleVerdict {
  angle: Angle | null;
  // Every angle the copy touches, strongest first. An ad usually leads with one
  // and mentions another; the LIST is what stops "we tried price" from erasing
  // the fact that the same ad also carried the experience claim.
  all: Angle[];
}

/**
 * Classify one ad's copy. `null` when nothing commits — an honest gap, not a
 * default bucket.
 */
export function classifyAngle(headline: string | null, primaryText: string | null): AngleVerdict {
  let text = normalize(`${headline ?? ""} ${primaryText ?? ""}`);
  if (text.length === 0) return { angle: null, all: [] };
  // Remove the known collisions before counting, so the words inside them
  // cannot be read as the terms they merely contain.
  for (const c of COLLISIONS) text = text.split(c).join(" ");

  // Weighted by OCCURRENCES, not by how many distinct synonyms matched —
  // otherwise an angle simply having more words in its list wins, and copy
  // that says "מחיר" twice loses to copy that mentions experience once in two
  // ways. The headline counts double: it is the ad's actual claim, the line
  // next to the button, while the body can wander.
  let head = normalize(headline ?? "");
  for (const c of COLLISIONS) head = head.split(c).join(" ");
  const scored = ANGLES.map((angle) => ({
    angle,
    hits: TERMS[angle].reduce((n, t) => n + countTerm(text, t) + countTerm(head, t), 0),
  })).filter((s) => s.hits > 0);

  if (scored.length === 0) return { angle: null, all: [] };
  // Stable order on a tie: ANGLES order, which runs cheapest-to-reach-for
  // first. A tie means the copy carries both equally, and the list keeps both.
  scored.sort((a, b) => b.hits - a.hits);
  return { angle: scored[0].angle, all: scored.map((s) => s.angle) };
}
