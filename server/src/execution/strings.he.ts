// Customer-facing Hebrew for execution outcomes. Centralized (never scattered in
// logic); plain business language, no Meta jargon.
export const EXEC_HE = {
  genericFailure: "משהו השתבש בביצוע השינוי. אנחנו בודקים ונחזור אליכם.",
  externalChange: "הקמפיין השתנה מאז שהצענו את השינוי, אז לא ביצענו אותו. נציג יבדוק את המצב.",
  accessLost: "חסרה לנו הרשאה לחשבון הפרסום. לחצו כאן כדי להתחבר מחדש.",
  overBudget: "השינוי חרג מהתקציב שסוכם, אז לא ביצענו אותו. נציג ייצור קשר.",
} as const;
