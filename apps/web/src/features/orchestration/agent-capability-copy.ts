const en = {
  actionsTitle: "What this version can do",
  noActions:
    "No business actions. This agent converses only; it cannot save, book or send anything.",
  fieldsTitle: "Reviewed lead fields",
  required: "Required",
  optional: "Optional",
  blockingTitle: "Cannot run as configured",
  blocking: {
    lead_schema_missing:
      "Lead actions are enabled but no reviewed field list is pinned.",
    lead_schema_without_capability:
      "A field list is pinned but no lead action is enabled.",
  },
  warningsTitle: "The instructions promise things no enabled action can do",
  warningsHint:
    "These are hints from reading the prompt, not a proof. An empty list does not mean every sentence is executable.",
  warnings: {
    lead_saving:
      "The prompt asks the agent to save information, but this version holds no lead-saving action.",
    booking:
      "The prompt mentions booking or scheduling. No enabled action can book anything; the agent must not promise an appointment.",
    payment:
      "The prompt mentions payments. No enabled action can take or refund a payment.",
    outbound_message:
      "The prompt mentions sending the customer something. The agent cannot send messages on its own.",
  },
  lifecycleTitle: "Lifecycle",
  draft: (version: number) => `Draft v${String(version)} (not running)`,
  published: (version: number) => `Published v${String(version)}`,
  unpublished: "Not published",
  assigned: (conversations: number, flows: number) =>
    `Assigned: ${String(conversations)} AI conversations · ${String(flows)} flows`,
  running: (calls: number) => `Running now: ${String(calls)} calls`,
  stale: (count: number, version: number) =>
    `${String(count)} conversations still run an older version. v${String(version)} is published; they keep their version until you rebind them.`,
  rebind: (version: number) => `Rebind to v${String(version)}`,
  rebindHint:
    "Human-owned conversations are not touched. Calls in progress keep the version they started with.",
  reviseTitle: "Edit as a new draft",
  revise: "Edit as new draft",
  reviseHint:
    "Saving creates the next version as a draft. Nothing that is running changes until you publish it and rebind.",
  capabilitiesTitle: "Business actions",
  capabilitiesHint:
    "A prompt describes behaviour. Only the actions ticked here are granted, on both voice and WhatsApp. Escalating to a person is always possible.",
  capability: {
    "lead.write": "Save lead details the customer gives",
    "lead.finalize": "Hand a completed enquiry to a person for review",
    "lead.follow_up": "Record that a person should follow up",
    "lead.read": "Read what was already collected",
    "ticket.open":
      "Open or update a support ticket when escalating to a person",
  },
  roleTitle: "Role title (how the agent names its role)",
  schemaChoice: "Field list",
  schemaNew: "Define a new field list",
  schemaLoading: "Loading field lists…",
  schemaFailed: "Could not load field lists. You can still define a new one.",
  schemaName: "Field list name",
  presets: "Start from",
  presetBusiness: "Business software enquiry",
  presetProperty: "Property viewing request",
  addField: "Add field",
  removeField: "Remove",
  fieldLabel: "Label",
  fieldKey: "Key",
  fieldType: "Type",
  fieldRequired: "Required",
  fieldChoices: "Choices (comma separated)",
  types: {
    text: "Text",
    number: "Number",
    currency: "Amount + currency",
    date: "Exact date",
    email: "Email",
    phone: "Phone",
    boolean: "Yes / no",
    choice: "Choice",
  },
  failed: "Could not save. Nothing was changed.",
} as const;

type Copy = {
  readonly [Key in keyof typeof en]: (typeof en)[Key] extends (
    ...args: infer A
  ) => string
    ? (...args: A) => string
    : (typeof en)[Key] extends Readonly<Record<string, string>>
      ? { readonly [Inner in keyof (typeof en)[Key]]: string }
      : string;
};

const he: Copy = {
  actionsTitle: "מה הגרסה הזו יכולה לעשות",
  noActions:
    "אין פעולות עסקיות. הסוכן רק משוחח; הוא לא יכול לשמור, לקבוע או לשלוח דבר.",
  fieldsTitle: "שדות ליד שנבדקו",
  required: "חובה",
  optional: "רשות",
  blockingTitle: "לא יכול לפעול בהגדרה הנוכחית",
  blocking: {
    lead_schema_missing: "פעולות ליד מופעלות אך לא הוצמדה רשימת שדות שנבדקה.",
    lead_schema_without_capability:
      "הוצמדה רשימת שדות אך לא הופעלה אף פעולת ליד.",
  },
  warningsTitle: "ההנחיות מבטיחות דברים שאף פעולה מופעלת לא מבצעת",
  warningsHint:
    "אלה רמזים מקריאת ההנחיות, לא הוכחה. רשימה ריקה אינה אומרת שכל משפט ניתן לביצוע.",
  warnings: {
    lead_saving:
      "ההנחיות מבקשות מהסוכן לשמור מידע, אך לגרסה הזו אין פעולת שמירת ליד.",
    booking:
      "ההנחיות מזכירות קביעת פגישות. אין פעולה מופעלת שיכולה לקבוע דבר; אסור לסוכן להבטיח פגישה.",
    payment: "ההנחיות מזכירות תשלומים. אין פעולה מופעלת שגובה או מחזירה תשלום.",
    outbound_message:
      "ההנחיות מזכירות שליחת משהו ללקוח. הסוכן אינו יכול לשלוח הודעות בעצמו.",
  },
  lifecycleTitle: "מחזור חיים",
  draft: (version) => `טיוטה v${String(version)} (לא פעילה)`,
  published: (version) => `פורסמה v${String(version)}`,
  unpublished: "לא פורסם",
  assigned: (conversations, flows) =>
    `משויך: ${String(conversations)} שיחות AI · ${String(flows)} תהליכים`,
  running: (calls) => `פעיל כעת: ${String(calls)} שיחות טלפון`,
  stale: (count, version) =>
    `${String(count)} שיחות עדיין פועלות בגרסה קודמת. v${String(version)} פורסמה; הן נשארות בגרסתן עד שתשייכו אותן מחדש.`,
  rebind: (version) => `שיוך מחדש ל-v${String(version)}`,
  rebindHint:
    "שיחות בבעלות אנושית לא משתנות. שיחות טלפון פעילות נשארות בגרסה שבה התחילו.",
  reviseTitle: "עריכה כטיוטה חדשה",
  revise: "עריכה כטיוטה חדשה",
  reviseHint:
    "השמירה יוצרת את הגרסה הבאה כטיוטה. שום דבר פעיל לא משתנה עד שתפרסמו ותשייכו מחדש.",
  capabilitiesTitle: "פעולות עסקיות",
  capabilitiesHint:
    "ההנחיות מתארות התנהגות. רק הפעולות המסומנות כאן ניתנות, בקול ובוואטסאפ. העברה לאדם אפשרית תמיד.",
  capability: {
    "lead.write": "שמירת פרטי ליד שהלקוח מסר",
    "lead.finalize": "העברת פנייה שהושלמה לבדיקה של אדם",
    "lead.follow_up": "תיעוד שאדם צריך לחזור ללקוח",
    "lead.read": "קריאת מה שכבר נאסף",
    "ticket.open": "פתיחה או עדכון של קריאת שירות בעת העברה לאדם",
  },
  roleTitle: "כינוי תפקיד (כיצד הסוכן מציג את תפקידו)",
  schemaChoice: "רשימת שדות",
  schemaNew: "הגדרת רשימת שדות חדשה",
  schemaLoading: "טוען רשימות שדות…",
  schemaFailed: "לא ניתן לטעון רשימות שדות. עדיין אפשר להגדיר רשימה חדשה.",
  schemaName: "שם רשימת השדות",
  presets: "להתחיל מ",
  presetBusiness: "פנייה לתוכנה עסקית",
  presetProperty: "בקשה לצפייה בנכס",
  addField: "הוספת שדה",
  removeField: "הסרה",
  fieldLabel: "תווית",
  fieldKey: "מפתח",
  fieldType: "סוג",
  fieldRequired: "חובה",
  fieldChoices: "אפשרויות (מופרדות בפסיקים)",
  types: {
    text: "טקסט",
    number: "מספר",
    currency: "סכום + מטבע",
    date: "תאריך מדויק",
    email: "דוא״ל",
    phone: "טלפון",
    boolean: "כן / לא",
    choice: "בחירה",
  },
  failed: "השמירה נכשלה. שום דבר לא השתנה.",
};

export function capabilityCopy(locale: string): Copy {
  return locale.startsWith("he") ? he : en;
}
