import { describe, expect, it } from "vitest";
import {
  messageDeliveryFailure,
  parseWhatsAppSendDiagnostic,
  metaErrorNumber,
} from "./whatsapp-diagnostics.js";

describe("safe WhatsApp diagnostic projection", () => {
  it("drops arbitrary stored fields and rejects unsafe codes", () => {
    const diagnostic = {
      version: 1,
      httpStatus: 400,
      metaCode: 100,
      metaSubcode: 33,
      reason: "resource_access",
      retryable: false,
      message: "private body",
      token: "fixture-secret",
      recipient: "+972501234567",
      rawResponse: { password: "private" },
    };
    const result = messageDeliveryFailure("meta_100", diagnostic);
    expect(result).toEqual({
      code: "meta_100",
      diagnostic: {
        version: 1,
        httpStatus: 400,
        metaCode: 100,
        metaSubcode: 33,
        reason: "resource_access",
        retryable: false,
      },
    });
    for (const value of [
      "private body",
      "fixture-secret",
      "+972501234567",
      "rawResponse",
    ])
      expect(JSON.stringify(result)).not.toContain(value);
    expect(messageDeliveryFailure("meta_secret-token", diagnostic)?.code).toBe(
      "outbound_processing_failed",
    );
    expect(messageDeliveryFailure(null, diagnostic)).toBeNull();
    expect(messageDeliveryFailure("meta_100", undefined)).toEqual({
      code: "meta_100",
      diagnostic: null,
    });
  });
  it.each([
    null,
    [],
    { version: 2 },
    { version: 1, httpStatus: 400, reason: "secret", retryable: false },
  ])("fails closed on malformed or future diagnostics", (value) => {
    expect(parseWhatsAppSendDiagnostic(value)).toBeNull();
  });
  it.each(["secret", "+972501234567", 972501234567, -1, 3.5, {}, Infinity])(
    "does not treat arbitrary values as numeric Meta codes",
    (value) => {
      expect(metaErrorNumber(value)).toBeNull();
    },
  );
  it("accepts bounded numeric code strings", () => {
    expect(metaErrorNumber("100")).toBe(100);
    expect(metaErrorNumber(33)).toBe(33);
  });
});
