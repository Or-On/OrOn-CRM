export const supportedLocales = ["en", "he"] as const;
export type SupportedLocale = (typeof supportedLocales)[number];

export function resolveLocale(
  value: string | null | undefined,
): SupportedLocale {
  return value === "he" ? "he" : "en";
}

export function directionForLocale(locale: SupportedLocale): "ltr" | "rtl" {
  return locale === "he" ? "rtl" : "ltr";
}
