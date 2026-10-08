/** Lint agent-authored first-person Hebrew, not the customer's quoted speech. */
export function masculineAgentPhrases(prompt: string): readonly string[] {
  const ownSpeech = prompt
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(
      /(?:הלקוח(?:ה)?|לקוח(?:ה)?|customer)\s*(?:אמר(?:ה)?|כתב(?:ה)?|אומר(?:ת)?|said|says)?\s*[:：]?\s*["״“][^"״”]*["״”]/giu,
      "",
    );
  return [
    ...ownSpeech.matchAll(
      /(?:^|[^\p{L}\p{N}_])(אני\s+(?:נציג|יכול|מוכן|שמח|מבין|בודק|מעביר|חוזר|מציע|צריך))(?![\p{L}\p{N}_])/gu,
    ),
  ].map((match) => match[1] ?? "");
}
