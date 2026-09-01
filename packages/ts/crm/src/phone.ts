const e164Pattern = /^\+[1-9][0-9]{7,14}$/u;

/**
 * Canonicalize a deliberately explicit international phone number.
 * Local/national inference belongs at a locale-aware UI boundary; this domain
 * helper never guesses a country code.
 */
export function normalizeE164(value: string): string | undefined {
  const trimmed = value.trim();
  const normalized = `+${trimmed.replace(/[^0-9]/gu, "")}`;
  if (!trimmed.startsWith("+") || !e164Pattern.test(normalized))
    return undefined;
  return normalized;
}

export function dedupeContactsByPhone<T extends { readonly phone: string }>(
  rows: readonly T[],
): { readonly unique: readonly T[]; readonly duplicates: number } {
  const seen = new Set<string>();
  const unique: T[] = [];
  let duplicates = 0;
  for (const row of rows) {
    const key = normalizeE164(row.phone);
    if (key === undefined || seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    unique.push(row);
  }
  return { unique, duplicates };
}
