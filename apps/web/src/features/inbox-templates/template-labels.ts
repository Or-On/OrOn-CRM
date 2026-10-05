import type { TemplateUnsupportedReason } from "./catalog";

/** Meta template language codes use underscores; BCP 47 uses hyphens. */
export function templateLanguageName(code: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(
      code.replace("_", "-"),
    );
    return name === undefined || name === code ? code : name;
  } catch {
    return code;
  }
}

const categories: Readonly<Record<string, readonly [string, string]>> = {
  MARKETING: ["Marketing", "שיווק"],
  UTILITY: ["Utility", "שירות"],
  AUTHENTICATION: ["Authentication", "אימות"],
};

export function templateCategoryName(category: string, he: boolean): string {
  const label = categories[category];
  return label === undefined ? category : label[he ? 1 : 0];
}

const statuses: Readonly<
  Record<
    string,
    readonly [string, string, "positive" | "warning" | "critical" | "neutral"]
  >
> = {
  APPROVED: ["Approved", "מאושרת", "positive"],
  PENDING: ["Pending review", "ממתינה לאישור", "warning"],
  IN_APPEAL: ["In appeal", "בערעור", "warning"],
  REJECTED: ["Rejected", "נדחתה", "critical"],
  PAUSED: ["Paused", "מושהית", "warning"],
  DISABLED: ["Disabled", "מושבתת", "critical"],
};

export function templateStatus(
  status: string,
  he: boolean,
): {
  readonly label: string;
  readonly tone: "positive" | "warning" | "critical" | "neutral";
} {
  const entry = statuses[status];
  return entry === undefined
    ? { label: status, tone: "neutral" }
    : { label: entry[he ? 1 : 0], tone: entry[2] };
}

const reasons: Readonly<
  Record<TemplateUnsupportedReason, readonly [string, string]>
> = {
  missing_body: [
    "This template has no message body.",
    "לתבנית הזו אין גוף הודעה.",
  ],
  named_parameters: [
    "Named variables are not supported yet. Use numbered variables such as {{1}}.",
    "משתנים בשם עדיין לא נתמכים. השתמשו במשתנים ממוספרים כמו {{1}}.",
  ],
  parameter_gaps: [
    "The template's numbered variables are not consecutive.",
    "המשתנים הממוספרים בתבנית אינם רציפים.",
  ],
  too_many_parameters: [
    "The template has more than 20 variables.",
    "בתבנית יש יותר מ-20 משתנים.",
  ],
  media_header: [
    "Templates with an image, video or document header can't be sent from the inbox yet.",
    "עדיין לא ניתן לשלוח מתיבת השיחות תבנית עם כותרת של תמונה, וידאו או מסמך.",
  ],
  header_parameters: [
    "Templates with a variable in the header can't be sent from the inbox yet.",
    "עדיין לא ניתן לשלוח מתיבת השיחות תבנית עם משתנה בכותרת.",
  ],
  button_parameters: [
    "Templates with a dynamic link button can't be sent from the inbox yet.",
    "עדיין לא ניתן לשלוח מתיבת השיחות תבנית עם כפתור קישור דינמי.",
  ],
  unsupported_component: [
    "This template uses a component the inbox can't send yet.",
    "התבנית משתמשת ברכיב שעדיין אי אפשר לשלוח מתיבת השיחות.",
  ],
};

export function templateUnsupportedReason(
  reason: TemplateUnsupportedReason | null | undefined,
  he: boolean,
): string {
  const entry = reasons[reason ?? "unsupported_component"];
  return entry[he ? 1 : 0];
}

/** Names are snake_case identifiers; show them as words. */
export function templateTitle(name: string): string {
  const words = name.replace(/_+/gu, " ").trim();
  return words === "" ? name : words;
}
