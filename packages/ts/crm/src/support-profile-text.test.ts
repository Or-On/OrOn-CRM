import { describe, expect, it } from "vitest";
import {
  tenantSupportTextLimits,
  validateTenantSupportText,
} from "./support-profile-text.js";

describe("tenant-authored business facts", () => {
  it("accepts natural paragraphs and multiline Hebrew without rewriting or truncating facts", () => {
    const profile = {
      businessDescription: "החברה מספקת תמיכה וייעוץ לעסקים.\n".repeat(80),
      productsAndServices: [
        "Long-form service description, including scope and limitations. ".repeat(
          20,
        ),
        "הקמה, הדרכה וליווי לצוותי הלקוח.".repeat(20),
      ],
    };
    const original = JSON.stringify(profile);
    expect(() => validateTenantSupportText(profile)).not.toThrow();
    expect(JSON.stringify(profile)).toBe(original);
  });

  it("bounds individual descriptions and services with distinct actionable errors", () => {
    expect(() =>
      validateTenantSupportText({
        businessDescription: "x".repeat(
          tenantSupportTextLimits.businessDescription,
        ),
      }),
    ).not.toThrow();
    expect(() =>
      validateTenantSupportText({
        businessDescription: "x".repeat(
          tenantSupportTextLimits.businessDescription + 1,
        ),
      }),
    ).toThrow("tenant business description exceeds text limits");
    expect(() =>
      validateTenantSupportText({
        productsAndServices: [
          "x".repeat(tenantSupportTextLimits.productOrService),
        ],
      }),
    ).not.toThrow();
    expect(() =>
      validateTenantSupportText({
        productsAndServices: [
          "x".repeat(tenantSupportTextLimits.productOrService + 1),
        ],
      }),
    ).toThrow("tenant products and services exceed text limits");
    expect(() =>
      validateTenantSupportText({
        productsAndServices: Array.from({ length: 65 }, () => "Service"),
      }),
    ).toThrow("tenant products and services exceed text limits");
  });

  it("bounds the complete UTF-8 payload even when each freeform field is individually valid", () => {
    expect(() =>
      validateTenantSupportText({
        productsAndServices: Array.from({ length: 9 }, () => "א".repeat(4_000)),
      }),
    ).toThrow("tenant support profile exceeds total text limit");
  });

  it.each(["unstructured API string", [null], ["   "], [42]])(
    "rejects malformed service-list payloads without invoking AI: %j",
    (productsAndServices) => {
      expect(() => validateTenantSupportText({ productsAndServices })).toThrow(
        "tenant products and services exceed text limits",
      );
    },
  );
});
