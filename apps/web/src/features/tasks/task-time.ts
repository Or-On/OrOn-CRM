import { dateTimeLocalInTimeZone, instantFromDateTimeLocal } from "../calendar";

/** Convert a stored task instant to the tenant wall clock shown by datetime-local. */
export function taskDueAtInput(
  value: string | null,
  tenantTimeZone: string,
): string {
  if (!value) return "";
  return dateTimeLocalInTimeZone(value, tenantTimeZone);
}

/** Convert the tenant wall clock entered by an operator to a stable UTC instant. */
export function taskDueAtInstant(
  value: string,
  tenantTimeZone: string,
): string {
  return instantFromDateTimeLocal(value, tenantTimeZone);
}
