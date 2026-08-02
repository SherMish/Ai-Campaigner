// All user-facing copy lives here — never hard-code Hebrew inside a component.
// (The static landing page is the one exception; its copy lives in landing/.)
export const strings = {
  he: {
    appName: "AI Campaigner",
    tagline:
      "מנהלים לכם את הפרסום במטא — בלי ריטיינר של אלפי שקלים. עוקבים, מנתחים וממליצים; כל שינוי בתקציב או בקמפיין מתבצע רק באישור שלכם.",

    // Internal admin dogfood readout (AIC-7). The reference the customer Home
    // (P0.5) later mirrors, so labels are already in Hebrew.
    admin: {
      readoutTitle: "ביצועי הקמפיין",
      status: "סטטוס",
      spend: "הוצאה",
      leads: "פניות",
      cpl: "עלות לפנייה",
      vsPrevious: "מול התקופה הקודמת",
      perCreative: "לפי מודעה",
      creative: "מודעה",
      noData: "—",
      noCampaigns: "אין עדיין קמפיין מנוהל עם נתונים.",
      loading: "טוען…",
    },

    // Connection health (AIC-5). Every non-ok state shows the same plain-Hebrew
    // reconnect message — the customer never sees Meta jargon like "revoked",
    // "invalid token", or "OAuth". The server sends the access_health value; the
    // client maps it to copy here.
    connection: {
      needsAttentionTitle: "חסרה לנו הרשאה לחשבון הפרסום",
      needsAttentionBody:
        "כדי שנוכל להמשיך לנהל את הקמפיין, צריך לחבר מחדש את חשבון הפרסום.",
      reconnectCta: "התחברות מחדש",
      healthyStatus: "החיבור לחשבון הפרסום תקין",
    },
  },
} as const;

// Map a connection's access_health to what the customer sees. Anything but "ok"
// is the same reconnect prompt — the distinction between revoked/invalid/
// needs_reconnect is internal only.
export function connectionMessage(
  accessHealth: "ok" | "revoked" | "invalid" | "needs_reconnect",
): { healthy: boolean; title: string; body?: string; cta?: string } {
  const c = strings.he.connection;
  if (accessHealth === "ok") {
    return { healthy: true, title: c.healthyStatus };
  }
  return {
    healthy: false,
    title: c.needsAttentionTitle,
    body: c.needsAttentionBody,
    cta: c.reconnectCta,
  };
}
