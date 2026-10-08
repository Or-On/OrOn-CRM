import { expect, it } from "vitest";
import { masculineAgentPhrases } from "./agent-voice-lint.js";

it("flags complete first-person masculine words, including spoken greetings", () => {
  expect(
    masculineAgentPhrases('פתיחה: "אני נציג של החברה, אני יכול לעזור"'),
  ).toEqual(["אני נציג", "אני יכול"]);
  expect(
    masculineAgentPhrases("אני יכולה לעזור, אני נציגה ואני מבינה"),
  ).toEqual([]);
});

it("does not flag attributed customer quotes, third-person people or substrings", () => {
  expect(
    masculineAgentPhrases(
      'הלקוח אמר: "אני צריך נציג, אני יכול לחכות". אמרי: "אני מוכנה לעזור". נציג אנושי יחזור.',
    ),
  ).toEqual([]);
  expect(masculineAgentPhrases("הלקוח צריך עזרה. אני מציעה שיחה.")).toEqual([]);
});
