/**
 * Self-contained fallback copy: the global error boundary cannot depend on the
 * normal locale/provider tree. Tests keep these six strings synchronized with
 * the authoritative dictionaries without bundling those dictionaries here.
 */
export const globalErrorMessages = {
  en: {
    feedback: {
      errorTitle: "This view is temporarily unavailable",
      errorDescription:
        "Reload this view. If a message was being submitted, check its status before sending again.",
    },
    common: { retry: "Try again" },
  },
  he: {
    feedback: {
      errorTitle: "התצוגה אינה זמינה כרגע",
      errorDescription:
        "נסו לטעון שוב את התצוגה. אם שלחתם הודעה, בדקו את מצבה לפני שליחה חוזרת.",
    },
    common: { retry: "ניסיון נוסף" },
  },
} as const;
