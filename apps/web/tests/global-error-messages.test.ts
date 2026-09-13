import { describe, expect, it } from "vitest";

import { globalErrorMessages } from "../src/i18n/global-error-messages";
import en from "../src/i18n/messages/en.json";
import he from "../src/i18n/messages/he.json";

describe("self-contained global error copy", () => {
  for (const [locale, messages] of Object.entries({ en, he })) {
    it(`keeps only the exact authoritative ${locale} fallback strings`, () => {
      expect(globalErrorMessages[locale as "en" | "he"]).toEqual({
        feedback: {
          errorTitle: messages.feedback.errorTitle,
          errorDescription: messages.feedback.errorDescription,
        },
        common: { retry: messages.common.retry },
      });
    });
  }
});
