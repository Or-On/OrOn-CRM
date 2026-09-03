import english from "./messages/en.json";
import hebrew from "./messages/he.json";

type Translate = (key: string) => string;
const knownErrors: Readonly<Record<string, string>> = {
  "invalid custom field value": "validation.format",
  Unauthenticated: "errors.session",
  Forbidden: "errors.permission",
  "Your session expired. Sign in again.": "errors.session",
  "A matching record already exists": "errors.duplicate",
  "The CRM operation is temporarily unavailable": "errors.unavailable",
  "The server returned an unexpected response. Refresh and try again; your draft has been kept.":
    "errors.response",
  "The server response could not be read. Your draft has been kept.":
    "errors.response",
  "WhatsApp consent is required": "errors.consent",
  "recipient has opted out of WhatsApp messaging": "errors.optOut",
  "real WhatsApp provider is disabled": "errors.disabled",
  "real WhatsApp delivery requires explicit confirmation": "errors.confirm",
  "real WhatsApp channel is not configured": "errors.configuration",
  "conversation has no valid WhatsApp recipient": "errors.phone",
  "recipient must be strict E.164": "errors.phone",
  "text must contain 1-4096 characters": "errors.length",
  "invalid template name": "errors.templateName",
  "invalid template language": "errors.templateLanguage",
  "invalid template parameters": "errors.templateParameters",
};

/** Never render arbitrary backend error text: it may contain PII or untranslated details. */
export function errorMessage(
  error: unknown,
  t: Translate,
  fallback: string,
): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const key = knownErrors[message];
  if (key) return t(key);
  if (/customer.service window|24.hour/iu.test(message))
    return t("errors.window");
  // Already localized local UI errors, including state retained across locale switches.
  for (const catalog of [english, hebrew]) {
    for (const [namespace, entries] of Object.entries(catalog)) {
      for (const [name, value] of Object.entries(entries)) {
        if (message === value && !value.includes("{"))
          return t(`${namespace}.${name}`);
      }
    }
  }
  return t(fallback);
}
