import { describe, expect, it } from "vitest";
import {
  greetingLanguage,
  parseWhatsAppAutoGreetingInput,
} from "./whatsapp-auto-greeting.js";

describe("automatic WhatsApp greeting", () => {
  it("answers in the script the customer wrote in", () => {
    const languages = ["en", "he"];
    expect(greetingLanguage("שלום, יש לי שאלה", languages, "en")).toBe("he");
    expect(greetingLanguage("Hi, I need help", languages, "he")).toBe("en");
    expect(greetingLanguage("hi שלום רב לכולם", languages, "en")).toBe("he");
  });

  it("uses the default when the message carries no clear language", () => {
    expect(greetingLanguage("", ["en", "he"], "he")).toBe("he");
    expect(greetingLanguage("👍 1234", ["en", "he"], "en")).toBe("en");
    expect(greetingLanguage("a", ["en", "he"], "he")).toBe("he");
  });

  it("matches a regional variant and never a language the template lacks", () => {
    expect(greetingLanguage("Hello there", ["en_US", "he"], "he")).toBe(
      "en_US",
    );
    expect(greetingLanguage("Здравствуйте", ["en", "he"], "he")).toBe("he");
    expect(greetingLanguage("مرحبا بكم", ["ar", "he"], "he")).toBe("ar");
  });

  it("accepts only an approved template name and its own languages", () => {
    expect(
      parseWhatsAppAutoGreetingInput({
        enabled: true,
        templateName: "conversation_start",
        languages: ["he", "en", "he"],
        fallbackLanguage: "he",
      }),
    ).toEqual({
      enabled: true,
      templateName: "conversation_start",
      languages: ["he", "en"],
      fallbackLanguage: "he",
    });
    for (const value of [
      null,
      {
        enabled: "yes",
        templateName: "a",
        languages: ["he"],
        fallbackLanguage: "he",
      },
      {
        enabled: true,
        templateName: "Bad Name",
        languages: ["he"],
        fallbackLanguage: "he",
      },
      {
        enabled: true,
        templateName: "a",
        languages: [],
        fallbackLanguage: "he",
      },
      {
        enabled: true,
        templateName: "a",
        languages: ["hebrew"],
        fallbackLanguage: "hebrew",
      },
      {
        enabled: true,
        templateName: "a",
        languages: ["he"],
        fallbackLanguage: "en",
      },
    ])
      expect(() => parseWhatsAppAutoGreetingInput(value)).toThrow(TypeError);
  });
});
