export const supportedLocales = ["en", "he"] as const;
export type SupportedLocale = (typeof supportedLocales)[number];

export function directionForLocale(locale: SupportedLocale): "ltr" | "rtl" {
  return locale === "he" ? "rtl" : "ltr";
}
