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
  // Added 2026-08-26 from review of a live ad the taxonomy could not hold:
  // "אל תהיו חמורים. יש דרך אחרת לנהל קמפיין." Its body mentions paying a
  // freelancer thousands, so it scored as `price` — but the ad's CLAIM is a
  // provocation plus an alternative ("there is another way"), and the cost
  // line is the setup, not the argument. Without this bucket, the only ad on
  // that account which produced a lead was filed under the wrong lesson.
  "contrarian",   // אל תהיו, יש דרך אחרת, לא חייבים, תפסיקו
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
  // Deliberately narrow. "עדיין משלמים אלפי שקלים?" is ALSO rhetorical, and it
  // is a price ad — so the rhetorical framing alone must not qualify. What
  // qualifies is naming an alternative or rejecting the default outright.
  contrarian: ["יש דרך אחרת", "אל תהיו", "אל תשלמו", "לא חייבים", "תפסיקו", "די ל", "אחרת לגמרי", "לא חייב להיות"],
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
  // How safely this was decided. `weak` means the winner beat the runner-up by
  // a single hit, or rests on one matched term — a real answer, but not one to
  // build a conclusion on. Surfaced rather than hidden, and never silently
  // promoted to a confident label.
  confidence: "clear" | "weak";
  // Every angle the copy touches, strongest first. An ad usually leads with one
  // and mentions another; the LIST is what stops "we tried price" from erasing
  // the fact that the same ad also carried the experience claim.
  all: Angle[];
}

/**
 * Classify one ad's copy. `null` when nothing commits — an honest gap, not a
 * default bucket.
 */
const strip = (text: string) => {
  let out = normalize(text);
  // Remove the known collisions before counting, so the words inside them
  // cannot be read as the terms they merely contain.
  for (const c of COLLISIONS) out = out.split(c).join(" ");
  return out;
};

function score(text: string): Array<{ angle: Angle; hits: number }> {
  if (text.length === 0) return [];
  return ANGLES.map((angle) => ({
    angle,
    hits: TERMS[angle].reduce((n, t) => n + countTerm(text, t), 0),
  }))
    .filter((s) => s.hits > 0)
    // Stable order on a tie: ANGLES order. A tie means the copy carries both
    // equally, and the list keeps both.
    .sort((a, b) => b.hits - a.hits);
}

export function classifyAngle(headline: string | null, primaryText: string | null): AngleVerdict {
  const head = strip(headline ?? "");
  const body = strip(primaryText ?? "");
  if (`${head}${body}`.length === 0) return { angle: null, all: [], confidence: "weak" };

  const headScores = score(head);
  const bodyScores = score(body);

  // THE HEADLINE DECIDES WHEN IT SAYS ANYTHING.
  //
  // It used to be merely weighted double against a body many times its length,
  // which is not the same thing — and a live ad proved the difference:
  // "אל תהיו חמורים. יש דרך אחרת לנהל קמפיין." was filed as `price` because its
  // body mentions paying a freelancer thousands. The headline is the ad's
  // claim, the line beside the button; the body elaborates and often wanders
  // through the very thing being argued AGAINST.
  //
  // So the body only gets a vote when the headline commits to nothing.
  const decisive = headScores.length > 0 ? headScores : bodyScores;
  if (decisive.length === 0) return { angle: null, all: [], confidence: "weak" };

  const top = decisive[0];
  const runnerUp = decisive[1]?.hits ?? 0;
  // `weak` means AMBIGUOUS — another angle scored nearly as high — not merely
  // thin. One unambiguous term with nothing competing is a clear read, and an
  // earlier stricter rule that marked it weak put the caveat on every single
  // ad, which is the same as putting it on none.
  const confidence: "clear" | "weak" = runnerUp === 0 || top.hits - runnerUp >= 2 ? "clear" : "weak";

  // `all` still spans BOTH halves: the body genuinely carries angles the ad
  // touches, and losing them would erase that they were used at all. Only the
  // headline decides which one LEADS.
  const all: Angle[] = [];
  for (const s of [...decisive, ...headScores, ...bodyScores]) if (!all.includes(s.angle)) all.push(s.angle);

  return { angle: top.angle, all, confidence };
}
