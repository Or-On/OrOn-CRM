import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import {
  listMessagePage,
  messageLocation,
  messageMedia,
  parseMessageCursor,
  templateSummary,
} from "./messaging.js";

describe("message history projections", () => {
  it("preserves PostgreSQL microseconds in a validated cursor", () => {
    const date = "2026-09-03T10:01:02.123456Z";
    const id = "20000000-0000-4000-8000-000000000001";
    expect(parseMessageCursor(date, id)).toEqual({ createdAt: date, id });
    expect(parseMessageCursor(null, null)).toBeUndefined();
    expect(() => parseMessageCursor(date, null)).toThrow("Invalid");
    expect(() => parseMessageCursor("2026-13-44T10:01:02.123Z", id)).toThrow(
      "Invalid",
    );
    expect(() => parseMessageCursor(date, "not-a-uuid")).toThrow("Invalid");
  });
  it("exposes only template display fields, never arbitrary payload metadata", () => {
    expect(
      templateSummary({
        templateName: "hello_world",
        language: "en_US",
        parameters: ["Fictional"],
        token: "never-forward",
      }),
    ).toEqual({
      name: "hello_world",
      language: "en_US",
      parameters: ["Fictional"],
    });
    expect(
      templateSummary({
        templateName: "hello",
        language: "he",
        parameters: [1],
      }),
    ).toBeNull();
    expect(templateSummary(null)).toBeNull();
  });

  it("projects safe inbound media only when a current object is available", () => {
    const structured = {
      retrievalStatus: "available",
      mimeType: "image/not-trusted",
      fileName: "customer.png",
      caption: "Front door",
      providerMediaId: "never-forward",
      sha256: "never-forward",
      retrievalError: "never-forward",
    };
    expect(messageMedia("image", structured)).toEqual({
      kind: "image",
      status: "unavailable",
      mimeType: "image/not-trusted",
      fileName: "customer.png",
      caption: "Front door",
    });
    expect(messageMedia("image", structured, "image/png")).toEqual({
      kind: "image",
      status: "available",
      mimeType: "image/png",
      fileName: "customer.png",
      caption: "Front door",
    });
    expect(messageMedia("text", structured, "image/png")).toBeNull();
  });

  it("accepts bounded location coordinates without raw provider metadata", () => {
    expect(
      messageLocation("location", {
        latitude: 32.0853,
        longitude: 34.7818,
        name: "Fictional location",
        address: "Example street",
        providerPayload: "never-forward",
      }),
    ).toEqual({
      latitude: 32.0853,
      longitude: 34.7818,
      name: "Fictional location",
      address: "Example street",
    });
    expect(
      messageLocation("location", { latitude: 91, longitude: 34.7818 }),
    ).toBeNull();
  });

  it("resolves actual media objects only for explicitly authorized projections", async () => {
    const row = {
      id: "30000000-0000-4000-8000-000000000001",
      conversation_id: "40000000-0000-4000-8000-000000000001",
      direction: "inbound",
      sender_type: "contact",
      content_type: "image",
      content_text: null,
      status: "received",
      provider_message_id: "fixture-provider-message",
      created_at: new Date("2026-09-15T10:00:00.123Z"),
      reactions: [],
      delivery_events: [],
      structured_content: {
        retrievalStatus: "available",
        mimeType: "image/not-trusted",
      },
      media_object_content_type: null,
      cursor_created_at: "2026-09-15T10:00:00.123456Z",
      outbound_error_code: null,
      outbound_diagnostic: null,
    };
    const baseQuery = vi.fn().mockResolvedValue([row]);
    const defaultPage = await listMessagePage(
      baseQuery as unknown as postgres.TransactionSql,
      row.conversation_id,
    );
    expect(baseQuery).toHaveBeenCalledOnce();
    expect(defaultPage.messages[0]?.media).toMatchObject({
      status: "unavailable",
      mimeType: "image/not-trusted",
    });

    const mediaQuery = vi
      .fn()
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([
        { message_id: row.id, content_type: "image/png" },
      ]);
    const authorizedPage = await listMessagePage(
      mediaQuery as unknown as postgres.TransactionSql,
      row.conversation_id,
      { includeMedia: true },
    );
    expect(mediaQuery).toHaveBeenCalledTimes(2);
    const mediaStatement = mediaQuery.mock
      .calls[1]?.[0] as TemplateStringsArray;
    expect(mediaStatement.join("?")).toContain(
      "messaging.current_tenant_message_media",
    );
    expect(authorizedPage.messages[0]?.media).toMatchObject({
      status: "available",
      mimeType: "image/png",
    });
  });
});
