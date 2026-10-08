import { describe, expect, it } from "vitest";
import {
  latestMessageLocale,
  groundAiReply,
  conversationLocale,
  explicitlyRequestsImmediateCall,
} from "./ai-grounding.js";

describe("task 8 stable conversation language", () => {
  it.each([
    "Dana",
    "dana",
    "hi",
    "hello hi hello",
    "Dana Mary Cohen",
    "050",
    "https://example.com/help",
    "dana@example.com",
    "HDMI",
  ])("keeps Hebrew for neutral input %s", (text) => {
    expect(latestMessageLocale("he", text)).toBe("he");
  });
  it.each(["English please", "אפשר באנגלית?", "I need help"])(
    "accepts a genuine English choice %s",
    (text) => expect(latestMessageLocale("he", text)).toBe("en"),
  );
  it("retains explicit English across a neutral name and phone", () =>
    expect(
      latestMessageLocale("he", "0501234567", ["Dana", "English please"]),
    ).toBe("en"));
  it("does not turn a historical name into English", () =>
    expect(
      latestMessageLocale("he", "0501234567", ["Dana", "שלום, צריך מידע"]),
    ).toBe("he"));
  it("keeps Hebrew around a Latin name", () =>
    expect(
      groundAiReply(
        { action: "reply", text: "Dana, מה מספר הטלפון לחזרה?" },
        [],
        "he",
      ).text,
    ).toBe("Dana, מה מספר הטלפון לחזרה?"));
});

it("uses name-collection context without treating assistant English as language", () => {
  expect(
    conversationLocale("he", [
      { role: "assistant", text: "What is your full name?" },
      { role: "user", text: "Will May Need" },
      { role: "assistant", text: "Phone?" },
      { role: "user", text: "0501234567" },
    ]),
  ).toBe("he");
});
it.each([
  "Please have the AI agent call me now.",
  "שהסוכן AI יתקשר אליי עכשיו",
])("requires explicit AI-call wording %s", (text) =>
  expect(explicitlyRequestsImmediateCall(text)).toBe(true),
);
it.each(["English please", "אפשר באנגלית?", "I need help"])(
  "retains choice through names and phone %s",
  (text) => {
    expect(
      conversationLocale("he", [
        { role: "user", text },
        { role: "assistant", text: "What is your name?" },
        { role: "user", text: "Dana Mary Cohen" },
        { role: "user", text: "0501234567" },
      ]),
    ).toBe("en");
  },
);
it("explicit Hebrew returns from English", () =>
  expect(latestMessageLocale("he", "עברית בבקשה", ["I need help"])).toBe("he"));
