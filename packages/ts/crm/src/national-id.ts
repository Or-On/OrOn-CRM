/** Shared syntax validation; it does not establish customer identity. */
export function normalizeNationalId(value: string): string {
  const normalized = value.replace(/[\s-]/gu, "");
  if (!/^\d{4,32}$/u.test(normalized))
    throw new TypeError("National ID must contain 4 to 32 digits");
  return normalized;
}
