import { describe, expect, it } from "vitest";
import { messageContextText } from "./message-context.js";

describe("multimodal message context", () => {
  it("preserves a caption and distinguishes it from unseen image contents", () => {
    expect(
      messageContextText({
        content_type: "image",
        content_text: "המסך לא נדלק",
        structured_content: { providerMediaId: "private-provider-id" },
      }),
    ).toBe(
      "[Customer shared image; attachment content is not available to this text model] המסך לא נדלק",
    );
  });
  it("represents a captionless document without dropping the turn", () => {
    expect(
      messageContextText({
        content_type: "document",
        content_text: null,
        structured_content: {
          fileName: "invoice.pdf",
          retrievalStatus: "failed",
        },
      }),
    ).toContain("invoice.pdf");
  });
  it("preserves sent-template parameters without inventing the approved body", () => {
    expect(
      messageContextText({
        content_type: "template",
        content_text: null,
        structured_content: {
          templateName: "appointment",
          language: "he",
          parameters: ["יום רביעי"],
          accessToken: "must-not-copy",
        },
      }),
    ).toBe(
      "[Sent template; body unavailable unless included below] appointment he יום רביעי",
    );
  });
  it("retains validated location data and does not serialize arbitrary payload fields", () => {
    const text = messageContextText({
      content_type: "location",
      content_text: null,
      structured_content: {
        latitude: 32.1,
        longitude: 34.8,
        address: "Fictional street",
        providerSecret: "must-not-copy",
      },
    });
    expect(text).toContain("Fictional street 32.1, 34.8");
    expect(text).not.toContain("must-not-copy");
  });
});
