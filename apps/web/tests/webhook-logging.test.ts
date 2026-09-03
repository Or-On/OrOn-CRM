import { describe, expect, it } from "vitest";

import config from "../next.config";

describe("webhook development logging", () => {
  it("omits verification URLs but preserves ordinary request diagnostics", () => {
    const logging = config.logging;
    if (!logging || typeof logging.incomingRequests !== "object") {
      throw new Error("Webhook request logging exclusion is required");
    }
    const ignored = (url: string) =>
      logging.incomingRequests &&
      typeof logging.incomingRequests === "object" &&
      logging.incomingRequests.ignore?.some((pattern) => pattern.test(url));
    expect(ignored("/api/webhooks/whatsapp")).toBe(true);
    expect(
      ignored("/api/webhooks/whatsapp?hub.verify_token=fictional-fixture"),
    ).toBe(true);
    expect(ignored("/api/webhooks/whatsapp/")).toBe(true);
    expect(ignored("/inbox")).toBe(false);
    expect(ignored("/api/webhooks/whatsapp-other")).toBe(false);
  });
});
