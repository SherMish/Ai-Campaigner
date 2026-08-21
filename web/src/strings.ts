// Our Meta Business Portfolio ID used to live here as a hardcoded literal.
// AIC-101 moved it to server config (server/src/config/meta-identity.ts,
// served unauthenticated at GET /api/config) — the exact "read from config,
// never hardcoded" it flagged: a value duplicated into the frontend bundle
// is a value the AIC-99 rename could silently strand. Consumers call
// `getConfig()` (web/src/api.ts) instead of importing a constant.
//
// (Earlier history: before this, Connect.tsx read the ID from
// `strings.he.app.mock` — a real bug, found live, where the onboarding
// screen showed a fake placeholder ID with a working copy button,
// indistinguishable from the real one.)

// All user-facing copy lives here — never hard-code Hebrew inside a component.
// (The static landing page is the one exception; its copy lives in landing/.)
export const strings = {
  he: {
    appName: "Ads Agent",
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
      // AIC-101: entry point from a customer's detail card into the guided
      // connection wizard.
      onboardingWizard: "אשף חיבור Meta",
    },

    // Ops console (P0.4)
    ops: {
      title: "קונסולת תפעול",
      customers: "לקוחות",
      queue: "דורש טיפול",
      business: "עסק",
      connection: "חיבור",
      campaign: "קמפיין",
      subscription: "מנוי",
      budget: "תקציב",
      openRecs: "המלצות פתוחות",
      none: "אין",
      claim: "לקיחה לטיפול",
      resolve: "סגירה",
      review: "בדיקת קמפיין ראשונה",
      approve: "אישור",
      requestChanges: "בקשת שינויים",
      unsupported: "לא נתמך",
      billing: "חיוב",
      leadQuality: "איכות פניות",
      empty: "הרשימה ריקה.",
      openMetaExplorer: "נתוני Meta המלאים ←",
      // AIC-64: the precise reason the engine last had nothing to propose —
      // operator-facing, so jargon/numbers are fine (unlike the customer copy).
      noRecTitle: "אין המלצה כרגע —",
      noRecReason: {
        stable: "יציב, אין מה להמליץ",
        collecting: "עדיין אוסף נתונים",
        budget_below_threshold: "תקציב מתחת לסף הזיהוי",
        delivery_blocked: "קבוצת מודעות לא מתפרסמת",
        tracking_broken: "מדידת הפניות לא תואמת את הגדרות Meta", // AIC-88
        no_comparable_audiences: "קהל אחד בלבד — אין השוואה", // AIC-85, was single_ad_set
        cooling_down: "בתקופת צינון לאחר שינוי אחרון", // AIC-77b
        below_object_evidence_floor: "יש מה להשוות, אבל עדיין לא מספיק נתונים", // AIC-85
        no_comparable_creatives: "מודעה אחת בלבד — אין השוואה", // AIC-85, rarely stored — see rules.ts
      } as Record<string, string>,
      // Same reasons the customer-facing add-content 409 uses
      // (connection-readiness.ts) — operator label, not customer copy, so
      // it can name the technical gap directly.
      connectionReadinessReason: {
        no_campaign: "אין קמפיין מנוהל",
        not_launched: "קמפיין קיים, לא מקושר ל-Meta",
        missing_page: "חסרה גישה לעמוד הפייסבוק",
        connection_issue: "בעיית חיבור ל-Meta",
        // AIC-103: the ops-console health check's own reason — a campaign
        // that's otherwise fully connected but missing a type-required field
        // (website_url, Pixel, whatsapp number). The specific field(s) render
        // separately from missingConfigFields — this label just flags it.
        incomplete_config: "חסרים פרטי הגדרה לקמפיין",
      } as Record<string, string>,
    },

    // Admin console shell + nav (AIC-43)
    adminShell: {
      brand: "Ads Agent",
      brandSub: "ניהול",
      navOverview: "סקירה כללית",
      navCustomers: "לקוחות",
      navUsers: "משתמשים",
      navMeta: "נתוני Meta",
      navRecs: "המלצות",
      navOperators: "מפעילים",
      comingSoon: "בקרוב",
      logout: "יציאה",
      searchPlaceholder: "חיפוש לקוח או קמפיין…",
      searchNoResults: "לא נמצאו תוצאות.",
    },

    // Users view — separate from the Customers (business) page (2026-08-16):
    // every signed-up login, whether or not a business is linked yet. Clicking
    // a row jumps straight into the AIC-101 onboarding wizard, creating a bare
    // business record first if the user doesn't have one.
    adminUsers: {
      title: "משתמשים",
      searchPlaceholder: "חיפוש לפי אימייל או שם…",
      noResults: "לא נמצאו משתמשים.",
      colEmail: "אימייל",
      colName: "שם",
      colJoined: "הצטרפות",
      colBusiness: "עסק",
      colSubscription: "מנוי",
      colConnection: "חיבור",
      colCampaign: "קמפיין",
      noBusiness: "טרם קושר לעסק",
      startOnboarding: "התחלת קליטה ←",
      // Shown instead of "start onboarding" once the connection is already
      // fully working — re-running the wizard would only create a duplicate
      // connection/campaign for the same customer.
      viewCustomer: "לצפייה בלקוח ←",
      provisioning: "יוצר רשומת עסק…",
      provisionError: "יצירת רשומת העסק נכשלה.",
    },

    // Customer CRUD (AIC-44) — create/edit/deactivate/delete, on the customers page.
    customerCrud: {
      newCustomer: "לקוח חדש",
      searchPlaceholder: "חיפוש לפי שם עסק או איש קשר…",
      filterAll: "הכל",
      filterActive: "פעילים",
      filterDeactivated: "מושבתים",
      filterAttention: "בעיית חיבור",
      noResults: "לא נמצאו לקוחות.",
      fieldBusinessName: "שם העסק",
      fieldCategory: "תחום",
      fieldMainService: "שירות עיקרי",
      fieldGeoArea: "אזור שירות",
      fieldPrimaryCustomer: "קהל היעד",
      fieldOffer: "הצעה",
      fieldContactName: "איש קשר",
      fieldContactPhone: "טלפון",
      fieldContactEmail: "אימייל",
      fieldIsTest: "חשבון פנימי/בדיקה (לא נספר בנתוני חיוב)",
      fieldAgreedBudget: "תקציב מוסכם (₪ ליום)",
      // AIC-103: the fix-it surface for a campaign the health check found
      // incomplete — same fields the onboarding wizard's step 4 collects,
      // editable here for a campaign that's already provisioned.
      configTitle: "הגדרות יעד הקמפיין",
      configHint: "משלימים כאן שדה שחסר לקמפיין הזה (למשל אחרי אזהרת \"חסרים פרטי הגדרה לקמפיין\") — לא צריך אשף חדש.",
      fieldWhatsappDestination: "מספר וואטסאפ ליצירת קשר",
      fieldWebsiteUrl: "כתובת אתר היעד",
      fieldPixelId: "מזהה Pixel",
      fieldLeadEventTypes: "סוג האירוע שנספר כפנייה",
      create: "יצירה",
      edit: "עריכה",
      save: "שמירה",
      cancel: "ביטול",
      saving: "שומר…",
      createError: "יצירת הלקוח נכשלה.",
      saveError: "השמירה נכשלה.",
      deactivate: "השבתה",
      reactivate: "הפעלה מחדש",
      deactivateConfirm: "להשבית את הלקוח? הקמפיין יסומן כלא מנוהל — המעקב וההפעלה ייעצרו. הפעולה הפיכה.",
      deactivatedBadge: "מושבת",
      deactivatedNote: "לקוח מושבת — הקמפיין מסומן כלא מנוהל. ניתן להפעיל מחדש.",
      reactivateNote: "הפעלה מחדש תבטל את סטטוס ההשבתה בלבד — ניהול הקמפיין בפועל מופעל בנפרד דרך פקדי הקמפיין.",
      deleteButton: "מחיקה סופית",
      deleteTitle: "מחיקת לקוח לצמיתות",
      deleteWarning:
        "פעולה זו מוחקת לצמיתות את הלקוח ואת כל הנתונים המקושרים אליו (מנוי, חיבור Meta, קמפיין מנוהל, המלצות, היסטוריית פעולות). היא אינה הפיכה. נכסי ה-Meta של הלקוח (חשבון פרסום, עמוד) לא יימחקו — רק ההרשאה שלנו לנהל אותם. במקרה הרגיל עדיף להשבית ולא למחוק.",
      deleteConfirmLabel: "הקלידו את שם העסק לאישור:",
      deleteConfirmMismatch: "השם שהוקלד אינו תואם.",
      confirmDelete: "מחיקה לצמיתות",
      auditTitle: "יומן פעולות",
      auditEmpty: "אין פעולות רשומות עדיין.",
      leadQualityWeek: "שבוע",
      leadQualityRelevant: "רלוונטיות",
      leadQualityWon: "לקוחות שנסגרו",
      historyTitle: "היסטוריית פעולות בקמפיין",
      historyAutomated: "(אוטומטי)",
      historyFailed: "· נכשל",
      auditActionLabels: {
        "customer.create": "נוצר",
        "customer.edit": "נערך",
        "customer.deactivate": "הושבת",
        "customer.reactivate": "הופעל מחדש",
        "customer.delete": "נמחק",
      } as Record<string, string>,
      // Per-account overrides for the recommendation engine's thresholds
      // (AIC-77a). Blank field = no override (falls back to the resolved
      // default shown in the placeholder — account override → budget-relative
      // formula for the two spend gates → global default).
      thresholds: {
        title: "סף רגישות המנוע (מתקדם)",
        hint: "שדה ריק = אין חריגה, המנוע משתמש בערך המחושב (המוצג כטקסט עזר).",
        groupEvidence: "סף נתונים מינימלי",
        groupCreative: "כלל מודעה חלשה",
        groupAudience: "כלל קהל חלש",
        groupBudget: "שינויי תקציב",
        MIN_DAYS_DATA: "ימי נתונים מינימליים",
        MIN_DELIVERY_DAYS: "ימי הפצה מינימליים",
        MIN_CAMPAIGN_LEADS: "פניות מינימליות בקמפיין",
        MIN_CREATIVE_SPEND_AGOROT: "הוצאה מינימלית למודעה (אגורות)",
        PAUSE_MIN_PEERS: "מודעות מקבילות נדרשות להשוואה",
        PAUSE_WEAK_CPL_MULTIPLIER: "מכפיל עלות-פנייה לזיהוי מודעה חלשה",
        REPLACE_DECAY_MULTIPLIER: "מכפיל התדרדרות להחלפת מודעה",
        AUDIENCE_MIN_SPEND_AGOROT: "הוצאה מינימלית לקהל (אגורות)",
        AUDIENCE_MIN_LEADS: "פניות מינימליות לקהל המוביל",
        AUDIENCE_CPL_MULTIPLIER: "מכפיל עלות-פנייה לזיהוי קהל חלש",
        BUDGET_CPL_RISE_PCT: "עליית עלות-פנייה להורדת תקציב (%, לדוגמה 0.25 = 25%)",
        BUDGET_INCREASE_STEP: "אחוז הגדלת תקציב (לדוגמה 0.15 = 15%)",
        BUDGET_DECREASE_STEP: "אחוז הפחתת תקציב (לדוגמה 0.2 = 20%)",
        summaryNone: "אין חריגות — המנוע פועל לפי ברירת המחדל.",
        summaryActive: (n: number) => `${n} חריגות פעילות מברירת המחדל.`,
      },
    },

    // Full Meta data explorer (AIC-45) — the unrestricted internal deep view.
    metaExplorer: {
      title: "נתוני Meta",
      subtitle: "העץ המלא כפי שמטא מדווח — כל מדד, כולל אלה שמוסתרים מהלקוח.",
      pickCampaign: "בחירת קמפיין",
      noCampaigns: "אין קמפיין מנוהל עדיין.",
      refresh: "רענון מ-Meta",
      refreshing: "מרענן…",
      fetchedAt: "נשלף",
      period: "תקופה",
      noMetaCampaign: "הקמפיין הזה עוד לא מקושר לקמפיין ב-Meta.",
      noToken: "החיבור ל-Meta אינו מוגדר כרגע — אי אפשר לשלוף נתונים חיים.",
      metaError: "שגיאה בשליפה מ-Meta:",
      campaignLevel: "רמת קמפיין",
      adSets: "קבוצות מודעות",
      ads: "מודעות",
      budget: "תקציב",
      dailyBudget: "תקציב יומי",
      lifetimeBudget: "תקציב כולל",
      bidStrategy: "אסטרטגיית הצעה",
      targeting: "טירגוט",
      age: "גיל",
      gender: "מגדר",
      geo: "אזור",
      interests: "תחומי עניין",
      issues: "בעיות",
      flexibleCreative: "קריאייטיב גמיש (דינמי)",
      flexibleImages: "תמונות",
      flexibleVideos: "סרטונים",
      flexibleBodies: "טקסטים",
      flexibleTitles: "כותרות",
      noCreative: "אין קריאייטיב מקושר.",
      pageLabel: "עמוד",
      // AIC-66 operator controls. Archive is the default destructive action
      // (recoverable); delete is the deliberate harder one.
      controls: {
        pause: "השהיה",
        resume: "הפעלה",
        archive: "העברה לארכיון",
        delete: "מחיקה",
        working: "מבצע…",
        failed: "הפעולה נכשלה",
        confirmTitle: "פעולה בלתי הפיכה",
        confirmArchive: "העברה לארכיון ניתנת לשחזור, אבל האובייקט יפסיק לרוץ ויוסר מהדוחות. להמשך, הקלידו את המזהה:",
        confirmDelete: "מחיקה היא לצמיתות ואי אפשר לשחזר אותה. להמשך, הקלידו את המזהה:",
        confirmCta: "אישור",
        cancel: "ביטול",
      },
      // AIC-65: a deleted/never-published ad set — shown clearly as such, not
      // as a normal active ad set and never as a problem.
      deletedBadge: "נמחק / לא פורסם",
      metrics: {
        spend: "הוצאה", impressions: "חשיפות", reach: "הגעה", frequency: "תדירות",
        cpm: "CPM", ctr: "CTR", cpc: "CPC", leads: "פניות", cpl: "עלות לפנייה",
        qualityRanking: "דירוג איכות", engagementRateRanking: "דירוג מעורבות", conversionRateRanking: "דירוג המרה",
      },
      noAdSets: "אין קבוצות מודעות.",
      noAds: "אין מודעות.",
    },

    // Recommendations oversight (AIC-46) — every rec, every customer.
    recsOversight: {
      title: "המלצות",
      subtitle: "כל המלצה שהמנוע הפיק, בכל הלקוחות — הראיות והסטטוס המלא.",
      filterState: "סטטוס",
      filterType: "סוג",
      filterCustomer: "לקוח",
      all: "הכל",
      noResults: "אין המלצות התואמות את הסינון.",
      business: "לקוח",
      type: "סוג",
      state: "סטטוס",
      impact: "השפעה מקסימלית",
      created: "נוצרה",
      flagged: "מסומנת",
      evidence: "ראיות",
      rationale: "נימוק",
      currentBudget: "תקציב נוכחי",
      proposedBudget: "תקציב מוצע",
      approvedBy: "אושרה ע\"י",
      executedAt: "בוצעה",
      executionResult: "תוצאת ביצוע",
      viewActionHistory: "→ צפייה בהיסטוריית הפעולות של הלקוח",
      flagButton: "סימון לבדיקה",
      unflagButton: "ביטול סימון",
      flagNotePlaceholder: "למה זה נראה חשוד? (רשות)",
      flagNoteLabel: "הערת סימון",
      stateLabels: {
        proposed: "הוצעה", approved: "אושרה", executing: "בביצוע", executed: "בוצעה",
        failed: "נכשלה", dismissed: "נדחתה", expired: "פגה",
      } as Record<string, string>,
      typeLabels: {
        pause_creative: "עצירת מודעה", pause_adset: "עצירת קהל", increase_budget: "העלאת תקציב",
        decrease_budget: "הורדת תקציב", replace_creative: "החלפת קריאייטיב", no_action: "ללא פעולה",
        add_creatives_for_comparison: "הוספת מודעות להשוואה", // AIC-86
      } as Record<string, string>,

      // AIC-76: did the change actually help? Correlation, never causation —
      // every label here describes what CPL DID, not what the change DID.
      outcome: {
        sectionTitle: "תוצאה",
        disclaimer: "השוואת מחיר-לליד בין החלון שלפני הביצוע לחלון שאחריו — מתאם, לא הוכחת סיבתיות.",
        notYetMeasured: "טרם נמדד — יימדד אוטומטית בתום חלון ההמתנה.",
        cplBefore: "מחיר לליד — לפני",
        cplAfter: "מחיר לליד — אחרי",
        delta: "שינוי",
        window: "חלון המדידה",
        measuredAt: "נמדד בתאריך",
        confoundTitle: "גורם מתערב",
        confoundOtherAction: "פעולה נוספת באותו חלון",
        confoundZeroSpend: "יום ללא הוצאה בחלון שאחרי",
        verdictLabels: {
          improved: "מחיר לליד ירד", degraded: "מחיר לליד עלה", neutral: "ללא שינוי משמעותי",
          confounded: "לא ניתן לייחוס", insufficient_data: "נתונים לא מספיקים", not_measurable: "לא ניתן למדידה",
        } as Record<string, string>,
      },
      // AIC-76: fleet-wide "is the engine actually helping?" summary, above
      // the filtered list — its own query, not a rollup of the visible rows.
      outcomeSummary: {
        title: "סיכום תוצאות לפי סוג המלצה",
        disclaimer: "מבוסס על השוואת מחיר-לליד לפני/אחרי כל ביצוע — מתאם, לא סיבתיות מוכחת.",
        colType: "סוג",
        colExecuted: "בוצעו",
        empty: "עדיין אין תוצאות מדודות.",
      },
    },

    // Operator accounts + admin action audit log (AIC-47).
    operators: {
      title: "מפעילים",
      subtitle: "מי יכול לגשת לקונסולה, ומה נעשה בה.",
      sectionOperators: "חשבונות מפעילים",
      sectionAudit: "יומן פעולות מלא",
      email: "אימייל",
      name: "שם",
      role: "תפקיד",
      created: "נוצר",
      roleFullAdmin: "מנהל מלא",
      roleOperator: "מפעיל",
      addOperator: "הוספת מפעיל",
      addEmailPlaceholder: "אימייל של משתמש קיים…",
      addNote: "אפשר להוסיף רק משתמש שכבר נרשם למערכת (אין עדיין שליחת הזמנות במייל).",
      add: "הוספה",
      addError: "ההוספה נכשלה — ודאו שהאימייל שייך למשתמש קיים ושאינו כבר מפעיל.",
      remove: "הסרת גישה",
      removeConfirm: "להסיר את הגישה לקונסולה? הכניסה של המשתמש למערכת עצמה לא נמחקת.",
      removeError: "ההסרה נכשלה.",
      roleChangeError: "שינוי התפקיד נכשל.",
      onlyFullAdminNote: "רק מנהל מלא יכול להוסיף, להסיר או לשנות תפקיד של מפעילים.",
      filterActor: "מפעיל",
      filterEntityType: "סוג ישות",
      all: "הכל",
      noEntries: "אין רשומות התואמות את הסינון.",
      entityTypeLabels: {
        customer: "לקוח", recommendation: "המלצה", operator: "מפעיל", campaign: "קמפיין",
      } as Record<string, string>,
    },

    // AIC-101 — the guided, live-verified onboarding call. Replaces an
    // operator reading docs/META_SETUP.md aloud off a second screen. Every
    // step's script is readable aloud (short sentences, one instruction per
    // line — this is spoken on a live call, not skimmed), and every check
    // hits the real Graph API rather than trusting what the Business
    // Settings UI shows (META_SETUP.md: "the UI can look completely correct
    // while the backend still has zero access").
    //
    // Step 1's actual click-by-click script is NOT duplicated here — it
    // reads directly from `app.connect.steps`/`fixSteps`, the same strings
    // the customer's own Connect screen shows. One definition: the operator
    // and the customer are describing the identical clicks, and Meta has
    // already changed this flow under us once (2026-08-15) — two copies
    // would mean the next change silently rotting whichever one nobody
    // notices.
    onboardingWizard: {
      title: "אשף חיבור Meta",
      subtitle: "תסריט לשיחה עם הלקוח, עם אימות חי בכל שלב — לא רק הוראות.",
      backToCustomer: "חזרה לכרטיס הלקוח",
      resumedNote: "ממשיכים מהשלב האחרון שנשמר.",
      stepOf: "שלב {n} מתוך 5",

      step1Title: "שלב 1 — הלקוח משתף גישה",
      step1Sub: "בשיחה, עם הלקוח מול המסך שלו.",
      // Both of these are prerequisites Meta enforces on ITS side, invisible
      // to every check this wizard runs — the access checks can all pass and
      // the build still fails (or worse, succeeds and never spends).
      // Added after both bit a real onboarding call on 2026-08-19:
      //   * the WhatsApp number was connected in the WhatsApp Business APP but
      //     never linked to the Facebook PAGE, so Meta refused the ad set with
      //     "Your Page is not linked to a WhatsApp account" — at the very end,
      //     after the whole builder wizard had been filled in;
      //   * a missing payment method also refuses the create, with its own
      //     clear message ("Update payment method: Visit the Billing and
      //     payment center to add a valid payment method").
      //     CORRECTION 2026-08-19: this comment previously claimed a missing
      //     payment method fails SILENTLY — campaign accepted, ACTIVE, never
      //     delivers. That was asserted without verifying and is wrong; the
      //     operator hit the real error. Both prerequisites fail loudly, and
      //     both fail LATE, which is the actual cost.
      // Deliberately placed at step 1, while the customer is still on the call
      // with their own screen open — that is the only moment either is cheap
      // to fix.
      step1PrereqTitle: "לפני שממשיכים — שני דברים שחייבים להיות מוכנים אצל הלקוח",
      step1PrereqWhatsapp: "מספר וואטסאפ עסקי (WhatsApp Business) מחובר לעמוד הפייסבוק עצמו — לא רק מותקן בטלפון. בעמוד: הגדרות ← וואטסאפ ← חיבור מספר ואימות בקוד. בלי זה Meta תסרב ליצור את הקמפיין.",
      step1PrereqPayment: "אמצעי תשלום פעיל בחשבון הפרסום. בלי זה Meta תסרב ליצור את הקמפיין (\"Update payment method\") — וכמו בוואטסאפ, רק בסוף, אחרי שכל האשף כבר מולא.",
      fieldPaymentLabel: "אמצעי תשלום",
      step1PrereqFooter: "שתי הבדיקות האלה לא נבדקות אוטומטית באשף. שווה לוודא מול הלקוח עכשיו, בזמן שהוא מול המסך.",
      step2Title: "שלב 2 — אנחנו מקצים למשתמש המערכת",
      step2Sub: "אצלנו, בהגדרות העסק.",
      step2Script: [
        "הנכסים המשותפים מופיעים עכשיו תחת שותפים (Partners) בפורטפוליו שלנו.",
        "משתמשים (Users) ← משתמשי מערכת (System Users) ← \"AdPilot backend\" ← הקצאת נכסים (Assign Assets).",
        "בוחרים את חשבון הפרסום ואת העמוד, נותנים הרשאות, שומרים.",
      ],
      step2Warning: "זה שלב נפרד משלב 1. עמוד ששותף אבל לא הוקצה למשתמש המערכת בלתי נראה מבחינתנו.",
      // AIC-101 follow-up: found live — the operator had nowhere to check
      // whether step 2 actually worked without scrolling back up to step 1's
      // button. Same check, same result, surfaced again right where the
      // operator's attention already is after doing the assignment.
      step2VerifyIntro: "בודקים שוב, אחרי ההקצאה — אותה בדיקה כמו בשלב 1.",
      step3Title: "שלב 3 — בדיקת הרשאות הטוקן",
      step3Sub: "אם הבדיקות למעלה נכשלות למרות ששלבים 1–2 בוצעו, זה כמעט תמיד כאן.",
      step4Title: "שלב 4 — הקמת הרשומות",
      step4Sub: "יוצרים את החיבור, חשבון הפרסום והקמפיין במערכת. בלי SQL.",
      step5Title: "שלב 5 — אימות סופי",
      step5Sub: "אותה בדיקה שהמנוע עצמו מריץ.",

      // AIC-105: the "act_…" prefix is now a fixed, non-typed chip in front
      // of the input (see AdminOnboarding.tsx) — the label no longer needs to
      // remind the operator to type it themselves.
      fieldAdAccountIdStep1: "מזהה חשבון פרסום",
      checkAdAccount: "בדיקת חשבון פרסום",
      checkPage: "בדיקת עמוד",
      checking: "בודקים…",
      checkTokenCta: "בדיקת טוקן",
      lastChecked: "נבדק לאחרונה:",
      neverChecked: "עדיין לא נבדק",

      // Every diagnosis needs distinct copy — same house rule as AIC-98's
      // state-copy.ts, applied here because this is the exact shape it
      // exists for: three failures that look identical from the Business
      // Settings UI, and collapsing them destroys the only actionable part.
      diagnosisOk: { title: "תקין", body: "הגישה מאומתת ונקראת בהצלחה עכשיו." },
      diagnosisNotShared: {
        title: "הלקוח עדיין לא שיתף",
        body: "הנכס לא מופיע תחת הפורטפוליו שלנו. חוזרים על שלב 1 עם הלקוח.",
      },
      diagnosisNotAssigned: {
        title: "שותף, אבל לא הוקצה אצלנו",
        body: "הלקוח שיתף נכון, אבל משתמש המערכת שלנו עדיין לא רואה את זה. מריצים את שלב 2.",
      },
      diagnosisTokenMissingScopes: {
        title: "לטוקן חסרות הרשאות — הקצאה לא תעזור",
        body: "שלבים 1–2 תקינים, אבל הטוקן נוצר לפני שהורשה הזה נוסף. הרשאות טוקן קפואות בזמן היצירה — הפתרון היחיד הוא יצירת טוקן חדש (שלב 3) וסיבוב הסוד ב-Railway.",
      },
      diagnosisUnreadableUnknown: {
        title: "כל שלושת השלבים תקינים, ועדיין לא נקרא",
        body: "לא נמצא הסבר באחד משלושת השלבים. לא ממציאים סיבה — פרטים טכניים למטה, ואפשר לנסות שוב בעוד רגע.",
      },
      diagnosisUnknown: { title: "עדיין לא נבדק", body: "לוחצים על בדיקה כדי לדעת." },
      technicalDetail: "פרטים טכניים",

      // Step 4 — provisioning (AIC-68).
      provisionTitle: "פרטי החיבור",
      fieldInstagramId: "חשבון אינסטגרם (לא חובה)",
      fieldCampaignName: "שם הקמפיין",
      // AIC-106: this is the AGREED ceiling (agreed_budget_agorot), typed by
      // the operator — deliberately never auto-filled from Meta's live
      // number below. Auto-filling one from the other is exactly the
      // circularity that made agreed_budget_agorot no real ceiling at all.
      fieldBudget: "תקציב יומי שסוכם עם הלקוח (₪)",
      // {amount} — replaced with the live ₪/day figure. Shown only when an
      // existing campaign is picked; read-only, informational, never the
      // source of the field above.
      fieldLiveBudgetNote: "כרגע רץ ב-Meta: ₪{amount} ליום (מידע בלבד — לא נשמר כתקציב המוסכם).",
      // AIC-103: asked explicitly — "where should someone land after clicking
      // your ad?" — rather than left to infer, since which fields below are
      // actually required depends on the answer.
      fieldDestinationType: "לאן מגיעה פנייה שלוחצים על המודעה?",
      destinationWhatsapp: "הודעת וואטסאפ (מומלץ)",
      destinationWebsite: "אתר / דף נחיתה",
      fieldWhatsappDestination: "מספר וואטסאפ ליצירת קשר",
      fieldLeadEventTypes: "סוג האירוע שנספר כפנייה",
      fieldPixelId: "מזהה Pixel",
      // AIC-102: the additions/creative flow's website-destination fix needs
      // a real landing-page URL on file for a Pixel campaign to add content.
      fieldWebsiteUrl: "כתובת אתר היעד",
      // AIC-103: a URL without UTM parameters produces a working ad but no
      // way to attribute a resulting lead back to this specific campaign —
      // a silent gap that looks fine until someone asks "which channel
      // brought this lead." (Note: this reminds the operator to ask for a
      // tracked link; it does not describe an attribution mechanism that
      // exists elsewhere in this codebase today.)
      fieldWebsiteUrlUtmNote: "חשוב: הכתובת צריכה לכלול UTM (utm_source/utm_medium/utm_campaign) — בלעדיהם הפנייה תיווצר אבל לא נדע מאיפה היא הגיעה.",

      // AIC-105 Branch B — "pick, don't type". Replaces free-text ad-account
      // and campaign id fields in step 4 with live-fetched pickers.
      pickAdAccountLabel: "חשבון פרסום",
      pickAdAccountPlaceholder: "בחרו חשבון פרסום…",
      pickAdAccountLoading: "טוענים חשבונות פרסום…",
      pickAdAccountEmpty: "לא נמצאו חשבונות פרסום שהמערכת יכולה לנהל כרגע. בודקים ששלבים 1–3 הושלמו.",
      pickAdAccountError: "לא הצלחנו לטעון את רשימת חשבונות הפרסום.",
      // {name} — the OTHER customer's business name; informational only
      // (AIC-87's migration 038 deliberately allows one Meta ad account to
      // back more than one customer), never a reason not to pick it.
      pickAdAccountUsedBy: "בשימוש גם עבור {name}",
      pickCampaignLabel: "קמפיין",
      pickCampaignPlaceholder: "בחרו קמפיין…",
      pickCampaignLoading: "טוענים קמפיינים…",
      // The Page picker (user request) — the Page-side sibling of the
      // ad-account picker, backed by the same "what can the System User
      // actually manage" read. Replaces a free-text id field in both step 1
      // and step 4.
      pickPageLabel: "עמוד פייסבוק",
      pickPagePlaceholder: "בחרו עמוד…",
      pickPageLoading: "טוענים עמודים…",
      // Scoped per ad account, so "empty" is a precise statement about THIS
      // account — not "we found no Pages anywhere".
      pickPageEmpty: "לחשבון הפרסום הזה אין עמודים שאפשר לפרסם דרכם. משלימים את שלבים 1–2 עבור העמוד, או בוחרים חשבון פרסום אחר.",
      pickPageNeedsAccount: "בוחרים קודם חשבון פרסום — רשימת העמודים תלויה בו.",
      pickPageError: "לא הצלחנו לטעון את רשימת העמודים.",
      // The honest answer to "so is it required or not" — it depends on
      // which of the two paths this call is on, and saying only "לא חובה"
      // (its old label) was misleading for the build-a-new-campaign path.
      pageRequirementNote: "לחיבור קמפיין קיים — לא חובה. לבניית קמפיין חדש — חובה, כי כל מודעה רצה דרך עמוד.",
      pickCampaignEmpty: "לא נמצאו קמפיינים בחשבון הפרסום הזה.",
      // AIC-107: engagement is DETECTED from Meta's own objective, never
      // chosen by hand here — so it is stated, not offered as a radio the
      // operator could set against what Meta actually reports.
      destinationEngagement: "מעורבות",
      destinationEngagementDetected: "זוהה קמפיין מעורבות. אין יעד פנייה להגדיר — האינטראקציה קורית על הפוסט עצמו, ולכן גם אין מספר וואטסאפ, כתובת אתר או פיקסל.",
      pickCampaignError: "לא הצלחנו לטעון את רשימת הקמפיינים.",
      pickRetry: "ניסיון נוסף",
      // AIC-105 Branch A: the customer's ad account has zero campaigns —
      // connects the account alone, then hands off to the guided builder
      // (the same wizard a self-serve customer uses) to create their first
      // campaign, operator acting on their behalf.
      startNewCampaignCta: "צור קמפיין חדש",
      startNewCampaignBusy: "מחברים את החשבון…",
      // AIC-106 gap, found live 2026-08-19: an operator could complete the
      // ENTIRE builder wizard (goal, budget, audience, placements, ads) and
      // only discover there was no agreed ceiling on the final click — this
      // field is what was missing. Deliberately distinct from the wizard's
      // own budget step: THIS is what the operator agreed with the customer,
      // set once, here, before the builder ever opens.
      newCampaignBudgetLabel: "תקציב יומי שסוכם עם הלקוח (₪)",
      newCampaignBudgetNote: "חובה למלא לפני בניית קמפיין ראשון — זו התקרה שתגביל כל תקציב שיוצע בהמשך, כולל בתוך אשף הבנייה.",
      errorNewCampaignBudgetRequired: "צריך למלא תקציב יומי שסוכם עם הלקוח לפני בניית קמפיין ראשון.",
      // Found live: מזהה עמוד is labeled "לא חובה" (optional) because
      // that's true for CONNECTING an existing campaign — but building a
      // first one from scratch always needs a Page, so skipping it here
      // used to lead to a confusing "not ready" screen one click later
      // instead of a clear reason on this one.
      // AIC-108: instagram_id feeds the SAME connection-health fold as the
      // Page, so an unverified one silently stops the engine. Optional to
      // fill; mandatory to verify once filled.
      checkInstagram: "בדיקת אינסטגרם",
      // AIC-108 follow-up, confirmed live 2026-08-19: the Meta App has no
      // Instagram use case configured, so `instagram_basic` is not offered
      // when minting a System User token — the permission list simply does
      // not contain it. Without that scope we cannot read (let alone list)
      // an IG account, so ANY id typed here fails at layer 3 and is refused
      // by the gate below. A field nobody can complete is a trap on a live
      // call, so it is disabled with the real reason (AIC-98) rather than
      // left enabled to fail at the end.
      pickInstagramPlaceholder: "בחרו חשבון…",
      pickInstagramLoading: "טוען חשבונות אינסטגרם…",
      pickInstagramEmpty: "אין חשבון אינסטגרם המקושר לחשבון המודעות הזה. מקשרים אותו בהגדרות העסק ב-Meta, ואז רועננו.",
      pickInstagramError: "טעינת חשבונות האינסטגרם נכשלה",
      instagramGateNote: "אפשר להשאיר ריק. אם ממלאים — חייבים לאמת: מזהה שלא נקרא בהצלחה יהפוך את כל החיבור ל־revoked ויעצור את מנוע ההמלצות בשקט, בדיוק כמו מזהה עמוד.",
      errorInstagramNotVerified: "מזהה האינסטגרם שהוקלד לא אומת. מריצים \"בדיקת אינסטגרם\" עם המזהה הזה בדיוק, או משאירים ריק.",
      errorPageRequiredForNewCampaign: "לבניית קמפיין ראשון צריך קודם למלא ולאמת מזהה עמוד (למעלה, שלב 1 או 2).",
      // Shown once a supported campaign is picked — the destination below
      // was DETECTED from Meta's own ad-set configuration, not guessed.
      pickCampaignDetectedNote: "היעד זוהה אוטומטית מהגדרות הקמפיין ב-Meta.",
      // AIC-98: every disabled-picker reason gets its own copy, never a bare
      // "not supported" — same discipline as the diagnosis copy above.
      campaignUnsupportedNoAdSets: "אין עדיין מודעות בקמפיין הזה, כך שאין ממה לזהות יעד",
      campaignUnsupportedUnrecognizedObjective: "המטרה של הקמפיין הזה לא נתמכת עדיין (לא לידים)",
      campaignUnsupportedMixedAdSets: "קבוצות המודעות בקמפיין הזה מוגדרות ליעדים שונים — לא נתמך עדיין",

      provisionSubmit: "יצירת הרשומות",
      provisionSuccess: "נוצר בהצלחה.",
      // AIC-69: the hard constraint the wizard enforces, not just documents.
      pageGateNote: "אי אפשר לשמור מזהה עמוד שלא נקרא בהצלחה — מזהה כזה יהפוך את כל החיבור ל־revoked ויעצור את מנוע ההמלצות בשקט.",
      pageGateBlocked: "לא ניתן לשמור — בדיקת העמוד לא עברה. בודקים שוב או ממשיכים בלי עמוד.",

      finalizeCta: "אימות והשלמה",
      finalizing: "מאמתים…",
      finalizeOk: "החיבור אומת ותקין. האשף הושלם.",
      finalizeNotOk: "עדיין לא תקין — חוזרים לשלב שנכשל.",
      finalizeNeedsProvision: "יוצרים קודם את הרשומות בשלב 4.",

      errorTokenNotConfigured: "META_SYSTEM_USER_TOKEN לא מוגדר בשרת — זו בעיה אצלנו, לא אצל הלקוח.",
      errorGeneric: "הפעולה נכשלה. אפשר לנסות שוב.",
      // AIC-103: distinct from errorGeneric — names exactly which fields are
      // missing (appended by the caller) rather than a generic failure.
      errorIncompleteConfig: "חסרים שדות חובה לסוג היעד שנבחר",
      // AIC-69's rule, made load-bearing on the client, not just the ⚠️
      // banner: a page_id the backend hasn't just verified must never reach
      // the save request — the server already refuses it, but this stops
      // the round trip before it starts.
      errorPageNotVerified: "מזהה העמוד שהוקלד לא אומת. מריצים \"בדיקת עמוד\" עם המזהה הזה בדיוק לפני השמירה.",
    },

    // Fleet-wide overview (AIC-43) — the operator's landing snapshot.
    fleet: {
      title: "סקירה כללית",
      subtitle: "מצב כל התיק במבט אחד.",
      campaignsByStatus: "קמפיינים לפי סטטוס",
      delivering: "מתפרסמים",
      needsAttention: "דורשים טיפול",
      spendThisPeriod: "הוצאה בתקופה הנוכחית",
      leadsThisPeriod: "פניות בתקופה הנוכחית",
      openQueue: "פריטים פתוחים בתור",
      viewQueue: "למעבר לתור",
      billingTitle: "לקוחות משלמים",
      realCustomers: "לקוחות אמיתיים",
      setupPaid: "שילמו הקמה",
      subscribed: "מנויים פעילים",
      conversionRate: "שיעור המרה",
      noRealCustomers: "אין עדיין לקוחות משלמים אמיתיים — התיק כרגע כולל רק חשבונות פנימיים/דוגמנות.",
      viewCustomers: "לצפייה בלקוחות",
      statusLabels: {
        under_review: "בבדיקה",
        active: "פעיל",
        paused: "מושהה",
        needs_attention: "דורש טיפול",
        connection_problem: "בעיית חיבור",
        unmanaged: "לא מנוהל",
      },
    },

    // Customer app (P0.5). All screen copy lives here — never hard-code Hebrew in
    // a component. Frontend built on mock data; backend wiring lands per ticket.
    app: {
      brandTag: "ניהול קמפיינים פשוט יותר לעסקים קטנים.",
      talkWa: "דברו איתנו בוואטסאפ",
      talk: "דברו איתנו",
      back: "חזרה",
      save: "שמירה",
      approve: "אישור",
      notNow: "לא עכשיו",
      help: "עזרה",
      logout: "יציאה",
      loading: "טוען…",
      loadError: "לא הצלחנו לטעון את הנתונים.",
      retry: "לניסיון חוזר",
      nav: { menu: "תפריט" },
      auth: {
        signupTitle: "פותחים חשבון ומתחילים",
        signupSub: "אחרי ההרשמה נקבע שיחת היכרות קצרה ונתחיל בהקמה.",
        name: "שם מלא",
        email: "אימייל",
        password: "סיסמה",
        // Split so the checkbox label can render real links to /terms.html
        // and /privacy.html (Auth.tsx) instead of plain unlinked text.
        terms: { pre: "אני מאשר/ת את ", tos: "תנאי השירות", mid: " ואת ", privacy: "מדיניות הפרטיות", post: "." },
        createAccount: "יצירת חשבון",
        haveAccount: "כבר יש לכם חשבון?",
        login: "כניסה",
        loginTitle: "ברוכים שחזרתם",
        loginSub: "הקמפיין ממשיך לעבוד גם כשאתם לא כאן.",
        forgotLink: "שכחתי סיסמה",
        noAccount: "אין לכם עדיין חשבון?",
        signup: "הרשמה",
        forgotTitle: "איפוס סיסמה",
        forgotSub: "הזינו את כתובת המייל ונשלח לכם קישור לאיפוס.",
        sendLink: "שלחו לי קישור",
        backToLogin: "← חזרה לכניסה",
        forgotSentTitle: "שלחנו קישור",
        forgotSent: "הקישור תקף לשעה. לא הגיע? בדקו בספאם או שלחו שוב.",
        resend: "שליחה חוזרת",
        resetTitle: "סיסמה חדשה",
        resetSub: "בחרו סיסמה חדשה לחשבון.",
        savePassword: "שמירת הסיסמה",
        resetDoneTitle: "הסיסמה עודכנה.",
        resetDoneSub: "אפשר להיכנס לחשבון עם הסיסמה החדשה.",
        loginToAccount: "כניסה לחשבון",
        preQuestion: "יש שאלה לפני שמתחילים?",
        afterSignup: "מה קורה אחרי ההרשמה",
        steps: ["שיחת היכרות עם בן אדם", "חיבור חשבון הפרסום", "אנחנו מתחילים לנהל"],
        previewNote: "אנחנו עוקבים אחרי הקמפיין, מציעים שיפורים ומבצעים רק מה שאישרתם.",
      },
      checkout: {
        title: "מצטרפים לניהול הקמפיין",
        sub: "תוכנית אחת, מחיר אחד. אחרי התשלום נקבע את שיחת ההיכרות.",
        plan: "התוכנית",
        perMonth: "לחודש",
        setupOnce: "הקמה חד־פעמית",
        metaNote: "תקציב הפרסום עצמו משולם ישירות למטא ואינו כלול במחיר.",
        included: "מה כלול",
        includes: ["ניהול קמפיין אחד", "מעקב שוטף", "המלצות לשיפור", "ביצוע שינויים שאישרתם", "תמיכה בוואטסאפ", "שיחות כשצריך"],
        payDetails: "פרטי תשלום",
        payNow: "לתשלום עכשיו",
        firstCharge: "הקמה + חודש ראשון",
        proceed: "המשך לתשלום",
        cancelNote: "אפשר לבטל את השירות בהתאם לתנאי השירות.",
        payQuestion: "שאלה על התשלום?",
      },
      onboarding: {
        eyebrow: "סטטוס ההקמה",
        greeting: "אנחנו מקימים את הניהול",
        greetingHi: "שלום",
        steps: ["החשבון נפתח", "שיחת היכרות", "חיבור Meta", "בדיקת הקמפיין", "מוכנים לניהול"],
        done: "הושלם",
        now: "עכשיו",
        later: "בהמשך",
        needHelpTitle: "צריכים עזרה?",
        needHelp: "אנחנו כאן. אפשר לכתוב לנו בוואטסאפ ונעבור על זה יחד.",
        callTitle: "מתחילים בשיחת היכרות",
        callSub: "נכיר את העסק, נעבור על הקמפיין הקיים ונעזור לחבר את חשבון Meta.",
        bookCall: "קביעת שיחה",
        bookedTitle: "השיחה שלכם נקבעה",
        bookedBadge: "נקבעה שיחה",
        date: "תאריך", time: "שעה", length: "אורך", how: "איך",
        bookedNote: "בשיחה נעבור יחד על העסק ועל הקמפיין הקיים.",
        reschedule: "שינוי מועד",
        connectTitle: "עכשיו מחברים את חשבון Meta",
        connectSub: "כדי שנוכל לעקוב ולנהל את הקמפיין, צריך לתת לנו גישה לחשבון הפרסום.",
        connectCta: "לחיבור Meta",
        connectHelp: "צריכים עזרה? נעשה את זה יחד בשיחה.",
        reviewBadge: "בתהליך",
        reviewTitle: "אנחנו עוברים על הקמפיין",
        reviewSub: "בודקים שהמבנה, התקציב והמודעות מתאימים לניהול דרך השירות.",
        metaConnected: "חשבון Meta מחובר",
        campaignFound: "הקמפיין נמצא",
        inReview: "בבדיקה",
        nothingToDo: "אין צורך לעשות דבר כרגע.",
        approveBadge: "מחכים לכם",
        approveTitle: "צריך אישור קטן לפני שמתחילים",
        approveSub: "עברנו על הקמפיין וממליצים לעצור מודעה אחת ולהשאיר את התקציב על ₪80 ביום. צריך את האישור שלכם כדי לבצע.",
        viewChange: "לצפייה בשינוי",
        wantToTalk: "אני רוצה לדבר על זה",
        readyTitle: "הכל מוכן",
        readySub: "הקמפיין מחובר ואנחנו מתחילים לעקוב אחריו.",
        goToAccount: "מעבר לחשבון",
      },
      connect: {
        backToStatus: "← חזרה לסטטוס ההקמה",
        title: "חיבור חשבון Meta",
        sub: "צריך לתת לנו גישה לחשבון הפרסום שבו נמצא הקמפיין שננהל.",
        noPassword: "אנחנו לא צריכים את הסיסמה שלכם לפייסבוק.",
        howTitle: "איך עושים את זה",
        // Verified against the real Meta Business Settings UI (2026-08-15):
        // partners are granted per-asset (Accounts → the asset → Assign
        // Partner), not through a single global "Partners → Add" flow — the
        // earlier version of these steps described a path that doesn't
        // match what Meta actually shows.
        steps: [
          "פותחים את הגדרות העסק ב־Meta (Business Settings)",
          "עוברים לחשבונות (Accounts) ← חשבונות של מודעות (Ad Accounts), בוחרים את חשבון הפרסום שלכם ולוחצים על הקצאת שותף (Assign Partner)",
          "בוחרים שותף עסקי (Business Partner), מזינים את המזהה העסקי שלנו (Business ID) — מופיע למטה — ומסמנים הרשאת פרסום (Advertise)",
          "אם נדרש, חוזרים על אותו תהליך עבור עמוד הפייסבוק (Page) / אינסטגרם (Instagram) תחת דפים",
          "חוזרים לכאן ואנחנו בודקים שהכול מחובר",
        ],
        openMeta: "פתיחת Meta Business Settings ↗",
        businessId: "BUSINESS ID",
        copy: "העתקה",
        copied: "הועתק",
        whenNeeded: "מתי זה נדרש?",
        whenNeededBody: "אם המודעות מוצגות מהעמוד או מהאינסטגרם שלכם, נצטרך גם אותם כדי לפרסם ולעצור מודעות.",
        checkCta: "בדיקת החיבור",
        checking: "בודקים את החיבור…",
        checkingSub: "זה לוקח כמה שניות. אפשר להישאר בעמוד.",
        connectedTitle: "החשבון מחובר",
        adAccount: "חשבון פרסום", fbPage: "עמוד פייסבוק", instagram: "אינסטגרם",
        technical: "פרטים טכניים",
        continue: "המשך",
        missingTitle: "חסרה גישה",
        missingBody: "חשבון הפרסום מחובר, אבל חסרה גישה לעמוד הפייסבוק (Facebook Page). בלי גישה לעמוד לא נוכל לפרסם או לעצור מודעות בשמכם. זה תיקון קצר בהגדרות העסק ב־Meta (Meta Business Settings).",
        connected: "מחובר", missing: "חסר",
        howToFix: "איך מתקנים?",
        // Verified against the real Meta Business Settings UI (2026-08-15):
        // partners are granted per-asset (Accounts → Pages → the page →
        // Assign Partner), not through a global "Partners → Add" flow.
        fixSteps: [
          "בהגדרות העסק ב־Meta (Business Settings) עוברים לחשבונות (Accounts) ← עמודים (Pages).",
          "בוחרים את עמוד הפייסבוק שלכם ולוחצים על הקצאת שותף (Assign Partner).",
          "בוחרים שותף עסקי (Business Partner) ומזינים את המזהה העסקי שלנו (Business ID) — מופיע למטה.",
          "מסמנים הרשאת פרסום (Advertise) ולוחצים על מתן הרשאה (Give Access).",
        ],
        recheck: "בדיקה מחדש",
        notVerifiedTitle: "לא הצלחנו לאמת את החיבור",
        notVerifiedBody: "אפשר לנסות שוב או לדבר איתנו ונעבור על זה יחד. הקמפיין שלכם ממשיך לרוץ כרגיל בזמן הזה.",
        retry: "נסה שוב",
      },
      review: {
        title: "אנחנו ממליצים על כמה התאמות לפני שמתחילים",
        sub: "זה הקמפיין שננהל. עברנו עליו וכתבנו מה כדאי לשנות — הכל יבוצע רק אחרי שתאשרו.",
        campaign: "קמפיין WhatsApp", active: "פעיל",
        budget: "תקציב", area: "אזור", ads: "מודעות", goal: "מטרה",
        budgetVal: "₪80 ביום", areaVal: "ראשון לציון והסביבה", adsVal: "4 מודעות", goalVal: "פניות ב־WhatsApp",
        running: "המודעות שרצות",
        keep: "נשארת", pauseRec: "מומלץ לעצור", isNew: "חדשה",
        proposalsTitle: "מה אנחנו מציעים",
        proposals: [
          { t: "לעצור מודעה אחת", d: "המודעה הזאת כמעט לא מביאה פניות לעומת האחרות." },
          { t: "לפשט את מבנה הקמפיין", d: "הקמפיין הקיים מפוצל למספר קבוצות שלא נותנות מספיק מידע בתקציב הנוכחי." },
          { t: "להישאר על ₪80 ביום", d: "התקציב המקסימלי לאחר השינוי: ₪80 ביום." },
        ],
        approveStart: "מאשר להתחיל",
        confirmedTitle: "קיבלנו את האישור",
        confirmedSub: "אנחנו משלימים את ההגדרה ומתחילים לעקוב.",
        backToStatus: "חזרה לסטטוס ההקמה",
      },
      home: {
        title: "הקמפיין שלך",
        navHome: "ראשי", navRecs: "המלצות", navSettings: "עזרה והגדרות",
        periods: { month: "החודש", days7: "7 ימים", prev: "חודש קודם" },
        // Every KPI states its own window. "הוצאה החודש" used to sit on a
        // 7-day value — a label claiming something the number isn't, the same
        // class of small lie as a false "פעיל". The window is stated once
        // above the group (kpiWindow) rather than repeated three times.
        kpiCpl: "עלות לפנייה", kpiLeads: "פניות", kpiSpend: "הוצאה",
        // AIC-107: the same three KPIs for an engagement campaign, where
        // "פניות" would be simply false — there are no leads to count.
        kpiCplEngagement: "עלות למעורבות", kpiLeadsEngagement: "מעורבות",
        graphTitleEngagement: "מעורבות לפי שבוע",
        // AIC-98: the lead-quality card is meaningless here ("how many were
        // relevant?" has no subject), so it is replaced by a statement of
        // what the engine does and does not do for this type — never an
        // empty slot the customer has to interpret.
        engagementScopeTitle: "מה נמדד בקמפיין הזה",
        engagementScopeBody: "אנחנו משווים בין המודעות לפי עלות למעורבות ומזהים איזה תוכן עובד. אין כאן שאלת איכות פניות — הקמפיין לא אוסף פניות — ולא נמליץ על הגדלת תקציב.",
        // One explicit range switcher replaced the old "today card + 7-day
        // KPIs" split, which read as two contradictory sets of numbers. Now
        // there's one set and the customer picks the window.
        ranges: { day: "היום", week: "שבוע", month: "חודש", allTime: "הכל" },
        // Only "היום" is a partial, still-updating window.
        provisional: "נתוני היום עדיין מתעדכנים ועשויים לעלות.",
        // Honest thin-data note: a new campaign shouldn't imply a flat empty
        // month of bad performance.
        newCampaignPrefix: "הקמפיין רץ מאז",
        newCampaignSuffix: "— לטווחים ארוכים יותר עדיין אין נתונים מלאים.",
        graphTitle: "פניות לפי שבוע",
        graphEmpty: "עדיין אין מספיק נתונים לגרף.",
        graphWeekPrefix: "שבוע",
        graphTotalSuffix: "סה״כ",
        states: {
          // Bug fix, 2026-08-14: "ok"/"collecting" no longer carry their own
          // fixed title/body — hero() now sources both from noRecCard(), the
          // same engine-reason copy the pending-rec card always used, so the
          // hero and "why (not)" reasoning can never again disagree. Only the
          // badge stays fixed (still an honest "is the campaign active" fact,
          // independent of what the engine currently recommends).
          ok: { badge: "פעיל" },
          collecting: { badge: "אוספים נתונים" },
          paused: { badge: "מושהה", title: "הקמפיין כרגע מושהה", body: "הקמפיין מושהה ואינו מוציא תקציב או מביא פניות עד שנחזיר אותו לפעילות. לחידוש הפעילות דברו איתנו.", cta: "" },
          attention: { badge: "צריך טיפול", title: "איבדנו גישה לחשבון Meta", body: "הקמפיין עשוי להמשיך לרוץ, אבל לא נוכל לנהל אותו עד לחיבור מחדש.", cta: "חיבור מחדש" },
          setup: { badge: "בהקמה", title: "אנחנו מקימים את החשבון", body: "החשבון נפתח. אחרי שיחת ההיכרות וחיבור Meta נתחיל לנהל את הקמפיין ותוכלו לראות כאן נתונים.", cta: "לסטטוס ההקמה" },
          // AIC-52: connected + ready, but the customer hasn't built their first
          // campaign yet — distinct from "setup" (still onboarding/connecting).
          createCampaign: { badge: "מוכן להתחיל", title: "בואו ניצור את הקמפיין הראשון שלכם", body: "כמה שאלות קצרות וממליצים לכם על ברירת מחדל בכל שלב — אפשר תמיד לשנות.", cta: "בניית הקמפיין" },
          // AIC-53: built + review-approved, PAUSED on Meta, waiting for the
          // customer's explicit go-live approval — nothing spends until they click.
          readyToLaunch: { badge: "מוכן להפעלה", title: "הקמפיין מוכן — נותר רק לאשר הפעלה", body: "בנינו את הקמפיין והוא עבר בדיקה, אבל הוא עדיין מושהה ולא מוציא כסף. ההפעלה מתבצעת רק באישור שלכם.", cta: "אישור והפעלה" },
          // Bug fix, 2026-08-14: the copy above claims "we built it, it passed
          // review" — both false for a campaign connected from outside the app
          // (confirmed live on the real free_beta campaign). Same badge/cta,
          // an honest body that doesn't claim work we didn't do.
          readyToLaunchConnected: { title: "הקמפיין ממתין לאישור הפעלה", body: "מצאנו את הקמפיין שלכם ב-Meta, אבל הוא עדיין מושהה ולא מוציא כסף. ההפעלה מתבצעת רק באישור שלכם." },
          // AIC-39: a not-delivering ad set — distinct from a lost Meta connection.
          // AIC-88: the conversions ARE happening; we are not counting them.
          // Never phrased as the campaign failing — the fault is ours, and
          // the honest thing is to say the numbers on screen are incomplete.
          tracking: { badge: "צריך טיפול", title: "מספרי הפניות כאן אינם מלאים", body: "יש אי-התאמה בהגדרת מדידת הפניות בקמפיין, כך שפניות שמגיעות אינן נספרות. אנחנו כבר על זה, ולא נמליץ על שינויים עד שנתקן — כדי לא להסתמך על נתון שגוי.", cta: "" },
          delivery: { badge: "צריך טיפול", title: "חלק מהקמפיין לא מתפרסם כרגע", body: "אחת מקבוצות הפרסום נתקלה בבעיה ואינה מציגה מודעות. אנחנו כבר על זה — ניצור קשר אם נצטרך משהו מכם. שאר הקמפיין ממשיך לרוץ.", cta: "" },
          // AIC-71: nothing is currently delivering (usually the customer's own
          // pause via the audience controls below) — not an error (that's
          // `delivery` above) and not an operator management-pause (`paused`
          // above, which needs us to resume). Distinct badge text from `paused`
          // on purpose — same underlying "nothing running" fact, but this one
          // the customer can undo themselves, right here.
          stopped: { badge: "לא מתפרסם", title: "אין כרגע מודעות שמוצגות ללקוחות", body: "כל קבוצות הפרסום מושהות, כך שאין כרגע חשיפה או פניות. אפשר להפעיל מחדש בלחיצה — פתחו את פירוט הקהלים למטה.", cta: "" },
        },
        // AIC-97: the compact "מצב" badge in the rail (unlike the hero card
        // above, which already carries a title+body) shows a bare pill with
        // no explanation. Three of the seven HomeState values share צריך
        // טיפול with different causes, and none say whether money is being
        // spent right now or who needs to act — both real, currently
        // invisible facts a customer paying for ads actually has. Every
        // entry answers the same three questions, in the same order, so the
        // popover is scannable instead of ten bespoke paragraphs. Ten
        // entries, not seven: `attention` gets its 3 causes, `no_campaign`
        // its 2 (still onboarding vs. connected-and-ready) — see
        // state-copy.ts's `statusTooltipKey`.
        statusTooltip: {
          infoLabel: "מידע על סטטוס הקמפיין",
          spendQuestion: "מוציא תקציב?",
          whoActsQuestion: "מי פועל?",
          ok: { meaning: "הקמפיין רץ ואנחנו רואים נתונים.", spend: "מוציא תקציב", whoActs: "אנחנו עוקבים" },
          collecting: { meaning: "המודעות רצות, אבל עדיין לא נרשמו הוצאה או פניות. זה נורמלי בשעות הראשונות.", spend: "מוציא תקציב", whoActs: "אף אחד — צריך זמן" },
          paused: { meaning: "השהינו את הקמפיין. הסיבה מופיעה ב״מה קרה לאחרונה״.", spend: "לא מוציא תקציב", whoActs: "אנחנו" },
          stopped: { meaning: "כל קבוצות המודעות מושהות, ולכן אף מודעה לא מוצגת.", spend: "לא מוציא תקציב", whoActs: "אתם" },
          readyToLaunch: { meaning: "הקמפיין מוכן אבל עדיין לא הופעל.", spend: "לא מוציא תקציב", whoActs: "אתם — צריך אישור" },
          noCampaignSetup: { meaning: "אנחנו עדיין מחברים את החשבון.", spend: "לא מוציא תקציב", whoActs: "אנחנו" },
          noCampaignReadyToBuild: { meaning: "החשבון מחובר, אפשר לבנות קמפיין.", spend: "לא מוציא תקציב", whoActs: "אנחנו" },
          attentionConnection: { meaning: "איבדנו גישה לחשבון המודעות ולא נוכל לנהל את הקמפיין.", spend: "ייתכן שכן", whoActs: "אתם — צריך לחדש הרשאה" },
          attentionTracking: { meaning: "יש פער בין מה שאנחנו סופרים כפנייה להגדרות במטא. המספרים כאן עלולים להיות לא מדויקים.", spend: "מוציא תקציב", whoActs: "אנחנו" },
          attentionDelivery: { meaning: "אחת מקבוצות המודעות לא מצליחה להתפרסם.", spend: "חלקית", whoActs: "אנחנו" },
        },
        live: {
          vsPrev: "מהתקופה הקודמת",
          noCompare: "אין תקופה קודמת להשוואה",
          noActivity: "עדיין לא בוצעו שינויים בקמפיין.",
          adsActive: "מודעות פעילות",
          perDay: "ביום",
          perMonth: "בחודש",
          none: "—",
          automated: "בוצע אוטומטית",
          byUs: "בוצע על ידינו",
        },
        // AIC-37: opt-in per-audience / per-creative details — collapsed by
        // default, never the landing view.
        // AIC-66: the customer's own pause/resume. Pausing your own ad is
        // itself the authorization — no approval step, unlike an engine
        // recommendation. Deliberately no delete on this surface.
        controls: {
          pauseAd: "השהיית המודעה",
          resumeAd: "הפעלת המודעה",
          pauseAdSet: "השהיית הקהל",
          resumeAdSet: "הפעלת הקהל",
          pausedBadge: "מושהה",
          working: "רגע…",
          failed: "לא הצלחנו לבצע את השינוי. נסו שוב.",
          // An ad set carries every ad under it — say so plainly before they click.
          adSetNote: "השהיית קהל עוצרת את כל המודעות שרצות אליו.",
          resumeNote: "הפעלה מחדש מחזירה את ההוצאה על האובייקט הזה.",
          // AIC-70: a successful pause/resume used to produce silence — the row
          // still looked untouched, which invited a second click. Shown inline,
          // right where the change happened, not a global toast.
          pausedNow: "הושהה",
          resumedNow: "הופעל",
          // Bug fix, 2026-08-15: GET /state and /media used to fail silently
          // (a bare .catch(() => {})) — the pause button and creative images
          // just never appeared, with nothing explaining why, indistinguishable
          // from "this feature doesn't exist". Shown whenever either read 409s
          // with a reason (missing_page/connection_issue/not_launched) — same
          // house rule as the empty-window copy above: never blank without
          // saying why.
          readUnavailable: "אי אפשר כרגע להציג תמונות מודעות או לעצור/להפעיל אותן — יש בעיה בחיבור לחשבון הפרסום.",
          goToSettings: "לבדיקה בהגדרות",
          // AIC-100: השהיית המודעה on an ad that's already not delivering
          // isn't a no-op — it sets the ad's own intent so it stays paused
          // once the parent resumes — but nothing on screen said so before,
          // reading as an action with no effect. Shown as the button's title
          // tooltip in that exact case.
          pauseBlockedNote: "המודעה כבר לא מוצגת כרגע. השהיה תשמור אותה מושהית גם אחרי שהקהל יחזור לפעול.",
        },
        details: {
          show: "הצג פירוט",
          hide: "הסתר פירוט",
          // AIC-95: this panel now follows the same day/week/month/הכל
          // switcher the KPI cards above it use — the old windowNote existed
          // ONLY because it silently didn't, and disagreed with the numbers
          // above it as a result. Removed rather than made more precise, per
          // the ticket's own instruction: the fix is to actually follow the
          // switcher, not to explain more clearly that it doesn't.
          //
          // Never a bare "no data" — every empty case states why, reusing the
          // house rule this ticket is the origin of.
          emptyStartedToday: "הקמפיין התחיל לרוץ היום. נסו לבחור \"היום\" למעלה כדי לראות את הנתונים.",
          emptyNoDataInRange: "אין נתונים לתקופה שנבחרה. הנתונים האחרונים שיש לנו הם מ־",
          empty: "עדיין אין מספיק נתונים לפירוט לפי קהל.",
          audienceCol: "קהל",
          spendCol: "הוצאה",
          leadsCol: "פניות",
          cplCol: "עלות לפנייה",
          creativesCol: "מודעות",
          // AIC-73: collapsed-state preview, built from the count Home already
          // has (deliveringAdCount) — no prefetch, keeps AIC-37's opt-in
          // principle intact (nothing about audiences is fetched until opened).
          previewAds: "מודעות פעילות",
          noCreatives: "אין עדיין מודעות בקהל הזה.",
          // AIC-95 followup, real live bug: the campaign card counted an ACTIVE
          // ad Meta still lists, but this breakdown — scoped to the selected
          // window — had nothing for it, so it just silently disappeared. This
          // note is a DB-only fact (creative has data outside this window),
          // never a claim about whether the ad is actually still delivering.
          moreCreativesOne: "עוד מודעה אחת עם נתונים מתקופה אחרת.",
          moreCreativesManyPrefix: "עוד",
          moreCreativesManySuffix: "מודעות עם נתונים מתקופה אחרת.",
          // AIC-73 round 2: per-row state, so "is this running?" is readable
          // without inferring it from which direction the action button points.
          statusRunning: "מפרסם",
          statusPausedByYou: "מושהה על ידך",
          // AIC-100, real live bug: an ad showed מפרסם while its own ad set
          // was מושהה — the ad's own switch is on, but nothing delivers,
          // because its parent is off. Two distinct causes, two distinct
          // fixes: the customer can resume the ad set themselves; a
          // campaign-level pause is ours to lift, so no CTA is offered for
          // it (same "who acts next" reasoning as h.states.paused).
          statusBlockedByAdSet: "לא מתפרסם · הקהל מושהה",
          statusBlockedByCampaign: "לא מתפרסם · הקמפיין מושהה",
          // Ad-level heading. `assetCount` comes from what Meta actually
          // reports for the creative — NOT from splitting the ad's name (the
          // real ad is named "almond green, french, video, pink lines" but has
          // exactly one creative; claiming 4 would invent data).
          adOne: "מודעה אחת",
          adCreativesSuffix: "קרייטיבים",
          // Actions are demoted to a quiet link — secondary and mildly
          // destructive, so they must not out-rank the audience label.
          moreActions: "עוד",
        },
        // Bug fix, 2026-08-14: recWaiting used to be one fixed headline
        // ("worth pausing an ad") shown for ANY pending recommendation type —
        // wrong the moment a genuinely different type (add creatives) could
        // be pending. The teaser headline now comes from recDetail.titles[type]
        // (the same source the detail screen itself uses), so the two can
        // never say different things. The CTA is neutral — "view", never
        // "view and approve" — since not every type has an approval step.
        recWaitingTitle: "המלצה שמחכה לך",
        view: "לצפייה",
        noActionTitle: "אין כרגע משהו שצריך לעשות",
        noAction: "אנחנו ממשיכים לעקוב אחר הקמפיין.",
        // AIC-64: WHY there's no recommendation — distinct, honest copy per
        // engine reason, so "stable" and "still collecting data" never look
        // the same. Falls back to noActionTitle/noAction above when the
        // engine hasn't classified a reason yet (e.g. before its first tick).
        noRec: {
          stable: { title: "אין כרגע משהו שצריך לעשות", body: "הקמפיין יציב, אין כרגע צורך בשינוי." },
          collecting: { title: "עדיין אוספים נתונים", body: "עוד קצת פעילות ונוכל להמליץ בביטחון." },
          budgetBelowThreshold: {
            title: "התקציב לא מספיק כדי לזהות מגמות",
            body: "בתקציב הנוכחי אנחנו לא יכולים לזהות מה עובד ומה לא. שווה לשקול להעלות אותו.",
            cta: "לבקשת העלאת תקציב",
          },
          noComparableAudiences: {
            title: "אין כרגע משהו שצריך לעשות",
            body: "יש לכם כרגע קהל פרסום אחד פעיל — אין עדיין עם מה להשוות כדי להמליץ על שינוי קהל.",
          },
          // AIC-85: comparable creatives/audiences exist, just not enough
          // data on each yet — genuinely different from "nothing to compare
          // at all" (above), and from "everything's fine" (stable).
          belowObjectEvidenceFloor: {
            title: "כמעט מוכנים להשוות",
            body: "יש לנו כמה עיצובים או קהלים להשוות, אבל עדיין לא מספיק נתונים על כל אחד כדי לדעת מה עובד טוב יותר. נמשיך לעקוב.",
          },
          // Defensive — see rules.ts's classifyNoAction comment: in practice
          // a pending add_creatives_for_comparison recommendation already
          // outranks this card before it would ever render.
          noComparableCreatives: {
            title: "כדאי להוסיף עוד מודעות",
            body: "יש לכם כרגע מודעה אחת פעילה — אין עדיין עם מה להשוות כדי להמליץ על שינוי עיצוב.",
          },
          // AIC-98: both of these route the campaign to the "צריך טיפול" hero
          // before this card renders — but the rule is that every reason owns
          // its copy, because "unreachable today" is a routing detail a future
          // refactor can change silently. Framed as "why no recommendation",
          // which is a different question from the hero's "what is wrong".
          deliveryBlocked: {
            title: "לא נמליץ עד שהפרסום יחזור לרוץ",
            body: "אחת מקבוצות הפרסום לא מציגה מודעות כרגע, כך שהנתונים חלקיים. המלצה שתתבסס עליהם עלולה להיות שגויה — אנחנו מטפלים בזה קודם.",
          },
          trackingBroken: {
            title: "לא נמליץ על סמך מספרים שאינם מלאים",
            body: "יש אי-התאמה בהגדרת מדידת הפניות, כך שחלק מהפניות אינן נספרות. לא נציע שינויים עד שנתקן — המלצה שמסתמכת על מספר שגוי גרועה מלא להמליץ בכלל.",
          },
          // AIC-77b: after an executed change, the engine waits a few days
          // before proposing another change of the same kind — long enough
          // to actually see whether the last change worked. This is the
          // honest "we're watching" signal, not a placeholder — a real
          // reason the card renders (homeState is still "ok" here).
          coolingDown: {
            title: "עוקבים אחרי השינוי האחרון",
            body: "ביצענו שינוי בקמפיין לאחרונה ונותנים לו כמה ימים להשפיע לפני שנבדוק שוב אם צריך לשנות עוד.",
          },
          // Shown only when today already has activity but the engine hasn't
          // acted. Without it, seeing "3 פניות היום" next to "עדיין אוספים
          // נתונים" reads as the product contradicting itself — it isn't: we
          // deliberately evaluate on complete days so a half-finished day
          // never triggers a recommendation.
          completeDaysNote: "את ההמלצות אנחנו מחשבים על ימים מלאים בלבד, כך שהפעילות של היום עוד לא נכללת.",
        },
        // AIC-67: incremental delta review — only ever asks about NEW leads
        // since the last review (never a cumulative total the customer has
        // to do mental math against).
        weeklyTitle: "איכות הפניות",
        weeklyThanksTitle: "קיבלנו, תודה",
        weeklyThanks: "זה עוזר לנו להבין טוב יותר אילו פניות באמת שוות לעסק.",
        weeklyNoLeads: "עדיין לא התקבלו פניות. אנחנו ממשיכים לעקוב לפני שממליצים על שינוי.",
        pendingPrefix: "יש לך",
        pendingSuffix: "פניות חדשות מאז הפעם האחרונה",
        pendingQuestion: "כמה מהן היו רלוונטיות?",
        caughtUpBadge: "מעודכן",
        caughtUpBody: "אין כרגע פניות חדשות לדירוג.",
        toReviewBadge: "לדירוג",
        weeklyRunningLabel: "השבוע",
        relevantOfLeads: "רלוונטיות מתוך",
        recentTitle: "מה קרה לאחרונה", recentAll: "לכל השינויים",
        recent: [
          { d: "12 באוג׳", t: "עצרנו מודעה חלשה לאחר שאישרתם." },
          { d: "5 באוג׳", t: "התקציב עודכן מ־₪70 ל־₪80 ביום." },
          { d: "1 באוג׳", t: "התחיל ניהול הקמפיין." },
        ],
        summaryTitle: "קמפיין WhatsApp",
        sMode: "מצב", sBudget: "תקציב", sAds: "מודעות", sLeads: "פניות",
        sBudgetVal: "₪80 ביום", sAdsVal: "4 מודעות פעילות", sLeadsVal: "18 סה״כ",
      },
      // Launch gate (AIC-53) — the confirmation before a campaign goes live.
      launch: {
        title: "אישור הפעלת הקמפיין",
        intro: "ברגע שתאשרו, הקמפיין יתחיל לפעול ולהוציא תקציב לפי מה שמופיע כאן. עד אז הוא מושהה ולא מוציא כלום.",
        nameLine: "קמפיין",
        budgetLine: "תקציב יומי",
        maxSpendLine: "הוצאה מקסימלית מוערכת לחודש",
        adsLine: "מודעות",
        // Bug fix, 2026-08-14: this row was a single hardcoded "פניות אל
        // וואטסאפ" whose value was `whatsapp_destination` — '' for any
        // non-WhatsApp campaign, so a real Pixel campaign rendered a WhatsApp
        // label with a BLANK value on the screen where ₪600/month is approved.
        // The label now follows the campaign's actual lead destination.
        whatsappLine: "פניות אל וואטסאפ",
        websiteLine: "פניות מהאתר",
        // Which action on the site counts as a lead. Named in plain Hebrew,
        // not as the Meta event id — an SMB owner can't verify
        // "CompleteRegistration", and this screen exists to be verified. The
        // raw event name is the fallback for custom conversions, where we have
        // no standard name and inventing one would be a guess.
        leadEvent: {
          COMPLETE_REGISTRATION: "הרשמה",
          LEAD: "יצירת קשר",
          PURCHASE: "רכישה",
          ADD_TO_CART: "הוספה לעגלה",
          INITIATED_CHECKOUT: "התחלת תשלום",
          CONTENT_VIEW: "צפייה בתוכן",
          SUBMIT_APPLICATION: "שליחת טופס",
          CONTACT: "יצירת קשר",
          SCHEDULE: "קביעת תור",
          SUBSCRIBE: "הרשמה לרשימה",
          START_TRIAL: "התחלת ניסיון",
        } as Record<string, string>,
        // Approval is blocked. Each reason names the missing precondition
        // plainly — never a disabled button with no explanation.
        blocked: {
          no_ads: "אין מודעות פעילות בקמפיין, כך שהפעלה לא תציג כלום ולא תוציא תקציב. נטפל בזה ונעדכן.",
          unknown_destination: "לא הצלחנו לוודא לאן הפניות אמורות להגיע, ולכן לא נבקש מכם לאשר הפעלה. אנחנו בודקים.",
          verification_unavailable: "לא הצלחנו לבדוק מול Meta את מצב הקמפיין כרגע. נסו שוב בעוד רגע.",
        } as Record<string, string>,
        approveCta: "אישור והפעלה",
        approving: "מפעיל…",
        cancel: "לא עכשיו",
        successTitle: "הקמפיין פעיל",
        successBody: "הקמפיין הופעל ומתחיל לרוץ. נעקוב אחריו ונעדכן כשיהיה משהו ששווה לשנות.",
        failed: "לא הצלחנו להפעיל את הקמפיין כרגע. אפשר לנסות שוב בעוד רגע — שום דבר לא הופעל פעמיים.",
        perMonth: "לחודש",
      },
      recs: {
        title: "המלצות",
        emptyTitle: "אין עדיין המלצות",
        empty: "אנחנו ממשיכים לעקוב אחרי הקמפיין ונעדכן כשיהיה משהו ששווה לשנות.",
        waiting: "מחכה לאישור שלך",
        view: "לצפייה",
        doneTitle: "מה כבר עשינו",
        notSure: "לא בטוחים לגבי המלצה?",
      },
      recDetail: {
        back: "← חזרה להמלצות",
        createdAgo: "נוצרה לפני 2 ימים",
        pauseTitle: "כדאי לעצור את המודעה הזאת",
        whyTitle: "למה אנחנו ממליצים",
        pauseWhy: "המודעה הוציאה ₪184 ב־7 הימים האחרונים והביאה פנייה אחת. שתי המודעות האחרות מביאות פניות במחיר נמוך משמעותית.",
        whatChangesTitle: "מה ישתנה?",
        pauseChanges: ["המודעה הזאת תיעצר.", "הקמפיין ושאר המודעות ימשיכו לפעול.", "התקציב הכולל לא יגדל."],
        incTitle: "כדאי להגדיל מעט את התקציב",
        incWhy: "מחיר הפנייה נמוך מהיעד כבר מספר ימים ואנחנו רואים מקום להגדיל את הפעילות.",
        today: "היום", proposed: "מוצע",
        incFrom: "₪70 ביום", incTo: "₪80 ביום",
        maxImpact: "תוספת מקסימלית של ₪10 ביום.",
        incChange: "התקציב יעבור מ־₪70 ל־₪80 ביום. השינוי מתבצע מיד לאחר האישור.",
        replaceTitle: "הגיע הזמן להחליף מודעה",
        replaceWhy: "הביצועים שלה נחלשו משמעותית בשבוע האחרון.",
        replaceNote: "נבקש ממך קריאייטיב חדש לפני שנבצע שינוי.",
        wantToTalk: "רוצה לדבר על זה?",
        approvedTitle: "אישרתם את השינוי",
        approvedSub: "אנחנו מבצעים אותו עכשיו. נעדכן כאן כשזה יושלם.",
        executedTitle: "השינוי בוצע",
        whatWeDid: "מה נעשה", whenDone: "מתי",
        backToRecs: "חזרה להמלצות",
        dismissedTitle: "בחרתם לא לבצע את השינוי",
        dismissedSub: "הקמפיין ממשיך כרגיל. אם תשנו את דעתכם, אנחנו כאן.",
        expiredTitle: "ההמלצה כבר לא רלוונטית",
        expiredSub: "מאז שיצרנו אותה, ביצועי הקמפיין השתנו. אם נראה שוב מקום לשינוי, נעדכן.",
        failedTitle: "לא הצלחנו לבצע את השינוי",
        failedSub: "לא בוצע שינוי בקמפיין. אנחנו בודקים מה קרה ונחזור אליכם.",
        heldTitle: "השינוי לא בוצע כרגע",
        heldSub: "לא בוצע שינוי בקמפיין. אפשר לנסות שוב מאוחר יותר או לדבר איתנו.",
        unavailableSub: "השירות זמנית אינו זמין לביצוע שינויים. נסו שוב עוד מעט.",
        // Titles + "what changes" keyed by recommendation type (live data path).
        titles: {
          pause_creative: "כדאי לעצור את המודעה הזאת",
          pause_adset: "כדאי לעצור קהל שמבזבז תקציב",
          increase_budget: "כדאי להגדיל מעט את התקציב",
          decrease_budget: "כדאי להוריד זמנית את התקציב",
          replace_creative: "כדאי להחליף את הקריאייטיב",
          no_action: "אין כרגע שינוי מומלץ",
          add_creatives_for_comparison: "כדאי להוסיף עוד מודעות", // AIC-86
        },
        changesBudget: "השינוי מתבצע מיד לאחר האישור.",
        changesReplace: "החלפת הקריאייטיב מתבצעת יחד עם הצוות שלנו — ניצור קשר להמשך.",
        changesAudience: "הקהל הזה ייעצר; התקציב יופנה לקהל שמביא תוצאות טובות יותר. סך התקציב לא יגדל.",
        // AIC-86: advisory only — nothing is approved/executed here; the CTA
        // opens the existing add-ad screen, and no spend changes as a result
        // of THIS recommendation itself.
        changesAddCreatives: "לא מבצעים כאן שינוי בקמפיין — לוחצים על הכפתור ועוברים למסך הוספת מודעות. אין שינוי בתקציב.",
        addCreativesCta: "להוספת מודעות",
        maxImpactPrefix: "תוספת מקסימלית של",
      },
      settings: {
        title: "עזרה והגדרות",
        supportTitle: "צריכים עזרה?",
        support: "אפשר לדבר איתנו בוואטסאפ או לקבוע שיחה.",
        bookCall: "קביעת שיחה",
        budgetTitle: "תקציב פרסום",
        budgetReq: "בקשה לשינוי תקציב",
        budgetNote: "זהו התקציב של Meta ואינו כולל את דמי השירות.",
        metaTitle: "Meta",
        checkConn: "בדיקת חיבור",
        planTitle: "המסלול שלך",
        planLine: "ניהול קמפיין אחד",
        setupPaid: "ההקמה שולמה",
        nextCharge: "החיוב הבא", nextChargeVal: "1 בספטמבר 2026",
        payMethod: "אמצעי תשלום", payMethodVal: "Visa •••• 4417",
        payMethodManual: "חיוב ידני מול הצוות",
        setupPending: "ההקמה בתשלום",
        noSubTitle: "אין מנוי פעיל",
        noSubNote: "זהו חשבון ניהול פנימי. פרטי המסלול יופיעו כאן לאחר הצטרפות.",
        managePay: "ניהול תשלום",
        budgetReqSent: "בקשתך התקבלה. ניצור איתך קשר בקרוב.",
        checking: "בודקים את החיבור…",
        connOk: "החיבור תקין",
        connProblem: "יש בעיה בחיבור — נחזור אליך.",
        pwCurrent: "סיסמה נוכחית", pwNew: "סיסמה חדשה (לפחות 8 תווים)",
        pwSave: "עדכון סיסמה", pwCancel: "ביטול",
        pwDone: "הסיסמה עודכנה.",
        pwWrong: "הסיסמה הנוכחית שגויה.",
        pwTooShort: "הסיסמה החדשה חייבת להכיל לפחות 8 תווים.",
        accountTitle: "החשבון",
        nameLabel: "שם", emailLabel: "אימייל", changePw: "שינוי סיסמה",
        cancelNote: "ביטול השירות מתבצע בשיחה איתנו, כדי שנוכל לסגור נכון את הקמפיין ב־Meta.",
        cancelLink: "דברו איתנו על ביטול",
      },
      mock: { userName: "לילך ברקוביץ'", userInitials: "לב", email: "lilach@studio.co.il", businessId: "418 552 907 431" },
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

    // Guided campaign builder (AIC-52). The server validates and returns
    // error CODES only (see shared/creative-handling.ts); the actual Hebrew
    // shown to the customer lives here. Rationale text for each recommended
    // default is NOT duplicated here — it comes straight from
    // shared/recommended-defaults.ts (the single source of truth AIC-49 set
    // up), read directly by the step components.
    builder: {
      eyebrow: "קמפיין חדש",
      title: "בניית הקמפיין הראשון שלכם",
      recommended: "מומלץ",
      next: "הבא",
      back: "חזרה",
      stepNames: ["מטרה", "יעד הפנייה", "תקציב", "קטגוריה מיוחדת", "קהל", "מיקומים", "מודעות", "סיכום"],
      notReadyTitle: "עוד לא מוכנים להתחיל",
      notReadyBody: "צריך קודם לחבר חשבון פרסום ועמוד פעילים ב-Meta, או שכבר יש לכם קמפיין מנוהל.",
      backToAccount: "לדף הראשי",
      unavailable: "יצירת קמפיינים לא זמינה כרגע. נסו שוב בעוד כמה דקות.",

      goal: {
        title: "המטרה של הקמפיין",
        // AIC-107: the objective is a REAL choice now, not a disabled field.
        // The two options optimize for genuinely different things and the
        // engine treats them differently — so the copy says what each one
        // gets you, and (per AIC-98) what it does NOT.
        body: "מה הקמפיין הזה אמור להשיג? אפשר לשנות בהמשך רק על ידי יצירת קמפיין חדש.",
        objectiveLabel: "יעד הקמפיין",
        objectiveLeads: "פניות (Leads)",
        objectiveLeadsHint: "אנשים יפנו אליכם — בוואטסאפ או דרך האתר. בשלב הבא תבחרו איך.",
        objectiveEngagement: "מעורבות (Engagement)",
        objectiveEngagementHint: "אנשים יגיבו, ישתפו ויתייגו על פוסט בעמוד שלכם. מתאים לבדיקה מהירה איזה תוכן עובד — לא לאיסוף פניות.",
        // AIC-98: state what the engine does NOT do for this type, rather
        // than letting the customer discover a missing panel later.
        objectiveEngagementLimits: "בקמפיין מעורבות לא נמליץ על הגדלת תקציב, ואין שאלת איכות פניות — אין פניות למדוד.",
        fixedNote: "הגדרות הרכש (Auction) קבועות בשלב הזה ולא מוצגות כבחירה.",
      },
      // AIC-89: destination is a real choice now — WhatsApp remains the
      // recommended default (simplest for the customer, no website needed,
      // on-platform tracking that can't silently break); website is the
      // alternative for a business that already has a converting site.
      destination: {
        title: "לאן מגיעות הפניות?",
        body: "רוב העסקים בישראל בוחרים בוואטסאפ — הכי טבעי ללקוחות, ופשוט לנהל. יש לכם אתר עם טופס פנייה או הרשמה? אפשר לחבר גם את זה.",
        optionWhatsapp: "וואטסאפ",
        optionWebsite: "אתר / דף נחיתה",
        whatsappBody: "לקוחות שילחצו על המודעה ייצרו איתכם קשר במספר הזה.",
        whatsappLabel: "מספר וואטסאפ, עם קידומת מדינה",
        whatsappPlaceholder: "972501234567",
        whatsappInvalid: "מספר לא תקין — רק ספרות, כולל קידומת מדינה (למשל 972501234567).",
        // AIC-107 + AIC-98: an engagement campaign has no destination to
        // pick, and an empty step would look broken. Say why.
        engagementNoDestination: "בקמפיין מעורבות אין יעד לבחור — האינטראקציה קורית על הפוסט עצמו בעמוד שלכם. אפשר להמשיך.",
        websiteBody: "לקוחות שילחצו על המודעה יגיעו לכתובת הזו. חשוב שה-Pixel של מטא יהיה מותקן באתר כדי שנוכל לספור את הפניות.",
        urlLabel: "כתובת דף היעד",
        urlPlaceholder: "https://example.co.il/signup",
        urlInvalid: "כתובת לא תקינה — חייבת להתחיל ב-https://",
        pixelLabel: "Pixel לניטור",
        pixelLoading: "טוען Pixels…",
        pixelNone: "לא נמצאו Pixels בחשבון הפרסום. יש לוודא שה-Pixel מחובר לחשבון הפרסום שלכם ב-Meta.",
        pixelPlaceholder: "בחרו Pixel",
        eventLabel: "פעולה שנחשבת כפנייה",
        eventPlaceholder: "בחרו פעולה",
        eventOptions: {
          LEAD: "פנייה (Lead)",
          COMPLETE_REGISTRATION: "השלמת הרשמה",
          SUBMIT_APPLICATION: "שליחת טופס בקשה",
          SCHEDULE: "קביעת פגישה",
          CONTACT: "יצירת קשר",
        } as Record<string, string>,
        recencyChecking: "בודקים נתוני Pixel…",
        // AIC-89's build-time guardrail — never a confident "the Pixel is
        // dead," only "we haven't seen this event recently, double-check
        // the setup" (hasRecentEvents: null renders no warning at all).
        recencyWarning: "לא ראינו את הפעולה הזו ב-Pixel לאחרונה. כדאי לוודא שה-Pixel מותקן נכון באתר ושהאירוע אכן נשלח — אחרת הקמפיין ירוץ בלי לספור פניות.",
      },
      budget: {
        title: "תקציב יומי",
        label: "תקציב יומי (₪)",
        invalid: "התקציב חייב להיות מספר חיובי.",
        // AIC-106 follow-up, found live: an over-ceiling budget was accepted
        // here and only refused on the wizard's FINAL click. The refusal
        // belongs at the field, and it names the actual ceiling rather than
        // saying "invalid".
        overCeiling: "התקציב היומי חורג מהתקציב שסוכם עם הלקוח (₪{max} ליום). אפשר להקטין כאן, או לעדכן את התקציב המוסכם באשף החיבור.",
        rationale:
          "תקציב של כ־₪40 ליום נותן למנוע מספיק נתונים תוך כשבוע כדי להתחיל להשוות מודעות ולזהות מה מביא פניות בעלות טובה. אפשר להתחיל נמוך יותר ולהעלות בהמשך — זו נקודת פתיחה, לא מספר קבוע.",
      },
      specialCategory: {
        title: "קטגוריה מיוחדת",
        question: "האם העסק שלכם עוסק באשראי, תעסוקה/גיוס עובדים, נדל\"ן/דיור, או נושאים חברתיים/פוליטיים?",
        options: {
          NONE: "לא",
          CREDIT: "אשראי",
          EMPLOYMENT: "תעסוקה / גיוס עובדים",
          HOUSING: "נדל\"ן / דיור",
          ISSUES_ELECTIONS_POLITICS: "נושאים חברתיים / פוליטיים",
        },
      },
      audience: {
        title: "קהל היעד",
        // Business type drives the age/gender defaults — shown as an editable
        // control so the assumption is visible and correctable, not silently
        // read from an operator-typed field the customer never sees.
        businessTypeLabel: "סוג העסק",
        businessTypeHint: "לפי מה שסיפרתם לנו. לא מדויק? אפשר לשנות כאן.",
        businessTypes: {
          beautician: "יופי וטיפוח",
          fitness: "כושר ואימונים",
          tutor: "הוראה פרטית",
          restaurant: "מסעדנות ואוכל",
          home_services: "שירותים בבית (אינסטלציה, חשמל וכו')",
          retail: "חנות / קמעונאות",
          health_wellness: "בריאות ורווחה",
          professional_services: "שירותים מקצועיים",
          real_estate: "נדל\"ן",
          other: "אחר",
        },
        ageMinLabel: "גיל מינימום",
        ageMaxLabel: "גיל מקסימום",
        genderLabel: "מגדר",
        genderOptions: { all: "הכל", male: "גברים", female: "נשים" },
        // In P0 the campaign targets all of Israel by age + gender. Real
        // location/radius targeting is a separate future step (AIC-54) — so we
        // say that plainly rather than showing a radius control that does nothing.
        geoNote: "בשלב הזה הקמפיין מטרגט את כל ישראל, לפי גיל ומגדר. טירגוט לפי אזור או רדיוס מהעסק יתווסף בהמשך.",
        // Keyed by BusinessCategory (shared/recommended-defaults.ts) — every
        // key there must have a match here, kept in sync manually since
        // strings.ts stays free of a runtime dependency on @aic/shared. These
        // justify the age/gender recommendation only — NOT a local radius,
        // which P0 doesn't apply (see geoNote).
        categoryRationale: {
          beautician: "בעסקי יופי וטיפוח, נשים בגילי 18–45 הן בדרך כלל הקהל הרלוונטי ביותר.",
          fitness: "לכושר ואימונים מתאים קהל רחב משני המגדרים, בעיקר בגילי 20–45.",
          tutor: "בהוראה פרטית ההורים או התלמידים הבוגרים הם מקבלי ההחלטה — קהל רחב יחסית משני המגדרים.",
          restaurant: "מסעדות ובתי קפה פונים לקהל רחב מאוד — כל המגדרים וטווח גילים רחב.",
          home_services: "לשירותים בבית (אינסטלציה, חשמל, ניקיון) מתאים קהל בוגר רחב משני המגדרים.",
          retail: "לחנות מקומית מתאים קהל רחב — כל המגדרים וטווח גילים בינוני.",
          health_wellness: "טיפולי בריאות ורווחה מושכים קהל בוגר רחב יחסית.",
          professional_services: "לשירותים מקצועיים (ייעוץ, ראיית חשבון וכו') מתאים קהל בוגר, כל המגדרים.",
          real_estate: "נדל\"ן פונה לקהל בוגר רחב.",
          other: "אין לנו עדיין המלצה ספציפית לתחום הזה — התחלנו בטווח רחב שאפשר לצמצם לפי מה שתדעו על הלקוחות שלכם.",
        },
      },
      placements: {
        title: "מיקומים",
        body: "המיקומים נקבעים אוטומטית (Advantage+): מטא מציגה את המודעות בפיד, בסטוריז ובכל מקום שבו יש סיכוי טוב לפנייה, ומחפשת את העלות הזולה ביותר לכל פנייה.",
        // Presented as a FIXED choice (like the goal step), not a badged
        // recommendation — there's no code path to narrow placements in P0, so
        // we don't imply the customer has a lever they don't.
        fixedNote: "בשלב הזה המיקומים קבועים על אוטומטי ולא מוצגים כבחירה — זו בדרך כלל הגישה שנותנת את העלות הטובה ביותר לפנייה.",
      },
      creatives: {
        title: "מודעות",
        body: "אפשר להעלות תוכן חדש או לבחור פוסט קיים מהעמוד המחובר. מומלץ 3–5 מודעות נפרדות כדי שנוכל להשוות מה עובד הכי טוב.",
        responsibilityNotice:
          "התוכן שאתם מעלים (תמונות, טקסט, הבטחות) הוא באחריותכם — כולל דיוק ועמידה בדרישות החוק והמדיניות של מטא. אנחנו לא בודקים או עורכים את התוכן.",
        uploadTab: "העלאת תוכן",
        postTab: "פוסט קיים",
        // AIC-107 + AIC-98: in an engagement campaign there is no upload
        // option — the ad promotes an existing post, and a missing tab with
        // no explanation reads as a bug.
        postsOnlyNote: "בקמפיין מעורבות מקדמים פוסט שכבר קיים בעמוד — אין העלאת תוכן חדש כאן. בוחרים פוסט מהרשימה.",
        adTitle: "מודעה",
        addAd: "הוספת מודעה",
        removeAd: "הסרה",
        nameLabel: "שם פנימי למודעה",
        headlineLabel: "כותרת",
        headlinePlaceholder: "מבצע קיץ",
        primaryTextLabel: "טקסט ראשי",
        primaryTextPlaceholder: "20% הנחה על הטיפול הראשון",
        chooseFile: "בחירת קובץ",
        uploading: "מעלה…",
        noPosts: "לא נמצאו פוסטים בעמוד המחובר.",
        loadingPosts: "טוען פוסטים…",
        createAdCta: "יצירת המודעה",
        creatingAd: "יוצר…",
        adCreated: "המודעה נוצרה",
        countHint: "מומלץ 3–5 מודעות נפרדות",
      },
      review: {
        title: "סיכום לפני יצירה",
        // AIC-106 — this line still said the OLD thing (created PAUSED, no
        // spend until a separate approval) directly above the NEW confirm
        // card that says the opposite ("no separate approval step"). Missed
        // when the launch gate came out because this string sits in a
        // different part of the `review` block from createCta/successTitle,
        // which is exactly the kind of miss the CLAUDE.md spec-correction
        // rule exists to catch — found live, user report 2026-08-19.
        body: "בודקים הכול לפני שיוצאים לאוויר — ברגע שיוצרים, הקמפיין פעיל ומתחיל להוציא תקציב מיד.",
        goalLine: "יעד",
        // AIC-89: same label, destination-aware value — Builder.tsx shows
        // the phone number or the URL depending on what was chosen.
        destinationLine: "יעד הפנייה",
        budgetLine: "תקציב יומי",
        businessLine: "סוג העסק",
        audienceLine: "קהל",
        placementsLine: "מיקומים",
        placementsValue: "אוטומטי (Advantage+)",
        geoValue: "כל ישראל",
        adsLine: "מודעות",
        createCta: "יצירת הקמפיין והפעלה מיידית",
        creating: "יוצר…",
        // AIC-106 — the confirmation that replaces the launch gate. Three
        // facts, in this order: WHICH CUSTOMER, how much per day, and that it
        // starts now. The customer name is the load-bearing one — it is the
        // only thing that catches building against the wrong customer, and
        // it is exactly what an operator running several onboardings in one
        // session is most likely to have wrong.
        confirmTitle: "הקמפיין יתחיל לפעול מיד",
        confirmFor: "יצירת קמפיין עבור",
        confirmPerDay: "ליום",
        confirmStartsNow: "אין שלב אישור נוסף — ברגע שלוחצים, הקמפיין עולה לאוויר ומתחיל להוציא תקציב.",
        successTitle: "הקמפיין פעיל",
        successBody: "הקמפיין עלה לאוויר ומתחיל להגיע לאנשים. אפשר לעקוב אחרי התוצאות מהדף הראשי.",
        goHome: "למעבר לדף הראשי",
        errorGeneric: "משהו השתבש ביצירת הקמפיין. אפשר לנסות שוב — מה שכבר נוצר לא ייווצר פעמיים.",
      },

      creativeErrors: {
        missing_media: "צריך להעלות תמונה/וידאו או לבחור פוסט קיים לפני שממשיכים.",
        missing_headline: "חסרה כותרת למודעה.",
        headline_too_long: "הכותרת ארוכה מדי — היא עלולה להיחתך בחלק מהמיקומים.",
        missing_primary_text: "חסר טקסט ראשי למודעה.",
        primary_text_too_long: "הטקסט הראשי ארוך מדי.",
      },
    },

    // Add content to an existing campaign (AIC-63) — the everyday management
    // action, distinct from the builder (first campaign only).
    additions: {
      navLabel: "הוספת תוכן",
      eyebrow: "הקמפיין הקיים שלכם",
      title: "הוספת תוכן לקמפיין",
      // Three distinct reasons GET /context can 409 with — never collapsed
      // into one message. A customer with an active, spending campaign was
      // told "go build your first campaign," which is both false and a dead
      // end (the builder itself refuses to run once a campaign exists).
      notReadyTitle: "עוד אין קמפיין להוסיף לו תוכן",
      notReadyBody: "צריך קודם ליצור את הקמפיין הראשון שלכם.",
      goToBuilder: "ליצירת הקמפיין",
      notLaunchedTitle: "הקמפיין שלכם עדיין לא פעיל",
      notLaunchedBody: "יש לכם קמפיין, אבל הוא עדיין לא אושר להפעלה מול Meta. אשרו את ההפעלה בדף הבית לפני שמוסיפים תוכן.",
      goToHome: "לדף הבית",
      connectionIssueTitle: "יש בעיה בחיבור לחשבון הפרסום",
      connectionIssueBody: "הקמפיין שלכם קיים ופעיל, אבל כרגע אי אפשר להוסיף לו תוכן בגלל בעיה בחיבור ל-Meta. בדקו את החיבור בהגדרות, או דברו איתנו ונטפל בזה.",
      goToSettings: "להגדרות",
      unavailable: "הוספת תוכן לא זמינה כרגע. נסו שוב בעוד כמה דקות.",
      // AIC-103: shown as a banner on the READY screen (never a 409) when the
      // campaign is missing a piece of config only WE hold (website_url,
      // Pixel, conversion event) — found live when a customer filled out an
      // entire ad only to be refused at submit. Deliberately does NOT tell
      // them to do anything: unlike a missing Page, this isn't fixable on
      // their end, so the honest copy is "we're on it," not an instruction
      // they have no surface for. Existing-post additions are unaffected and
      // stay available, so the copy says so rather than implying the whole
      // screen is broken.
      incompleteConfigTitle: "עוד משהו קטן להשלים אצלנו",
      incompleteConfigBody: "יש לנו עוד כמה פרטים להשלים בקמפיין הזה לפני שאפשר להוסיף תוכן חדש (העלאת תמונה/וידאו). אנחנו כבר על זה — אין צורך לעשות כלום. אפשר בינתיים להוסיף מודעה מפוסט קיים בעמוד. דחוף? דברו איתנו.",
      modeAd: "הוספת מודעה",
      modeAdSet: "הוספת קבוצת מודעות",

      // add-ad mode
      pickAdSetTitle: "לאיזו קבוצת מודעות?",
      pickAdSetLoading: "טוען קבוצות מודעות…",
      noAdSets: "לא נמצאו קבוצות מודעות בקמפיין.",
      adSetPaused: "מושהית",
      adsTitle: "המודעה",

      // add-ad-set mode
      adSetNameLabel: "שם פנימי לקבוצת המודעות",
      adSetNamePlaceholder: "למשל: נשים 35-55",

      // AIC-106: creating content activates it immediately — no more "add it
      // paused, then separately approve it" two-step. The CTA says what
      // actually happens now.
      submitAdCta: "הוספת המודעה",
      submitAdSetCta: "הוספת קבוצת המודעות",
      submitting: "מוסיף…",
      submitSuccessTitle: "נוסף ופעיל",
      submitSuccessBody: "המודעה רצה עכשיו.",
      // Shown only in the rare case the create succeeded but going live
      // didn't (a Meta-side hiccup) — the item below still needs one retry.
      submitSuccessTitleRetry: "נוסף, אבל עדיין לא רץ",
      submitSuccessBodyRetry: "המודעה נוצרה בהצלחה, אבל היה קושי להפעיל אותה. אפשר לנסות שוב למטה.",
      submitAnother: "הוספת עוד",
      submitError: "משהו השתבש בהוספה. אפשר לנסות שוב — מה שכבר נוצר לא ייווצר פעמיים.",

      // AIC-106: this section is now the exception, not the norm — content
      // is live the moment it's created. It only ever shows something when
      // activation itself failed and needs a retry.
      pendingTitle: "דורש טיפול",
      pendingEmpty: "הכול פעיל — אין כרגע שום דבר שממתין.",
      pendingKindAd: "מודעה",
      pendingKindAdSet: "קבוצת מודעות",
      approveCta: "ניסיון נוסף להפעלה",
      approving: "מפעיל…",
      approveError: "ההפעלה נכשלה. אפשר לנסות שוב.",
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

// Map a creative-validation error code (shared/creative-handling.ts) to its
// Hebrew message. Codes cross the API untranslated; only the client displays copy.
export function creativeValidationMessage(code: keyof typeof strings.he.builder.creativeErrors): string {
  return strings.he.builder.creativeErrors[code];
}
