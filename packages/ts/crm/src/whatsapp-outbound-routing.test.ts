import { createHash } from "node:crypto";

import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import { queueWhatsAppOutbound } from "./whatsapp-outbound.js";

const actorId = "10000000-0000-4000-8000-000000000001";
const conversationId = "20000000-0000-4000-8000-000000000001";
const channelId = "30000000-0000-4000-8000-000000000002";
const latestSenderIdentityId = "40000000-0000-4000-8000-000000000002";
const latestSenderAddress = "+12025550198";

function transaction(results: readonly unknown[][]) {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const execute = vi.fn(
    (parts: TemplateStringsArray, ...parameters: unknown[]) => {
      statements.push(parts.join("?"));
      values.push(parameters);
      return Promise.resolve(results[statements.length - 1] ?? []);
    },
  );
  const sql = Object.assign(execute, {
    json: (value: unknown) => value,
  }) as unknown as postgres.TransactionSql;
  return { sql, statements, values };
}

const configuredFirstSender = {
  graphApiVersion: "v26.0",
  phoneNumberId: "111111111111111",
  wabaId: "333333333333333",
} as const;
const configuredSecondSender = {
  graphApiVersion: "v26.0",
  phoneNumberId: "222222222222222",
  wabaId: "333333333333333",
} as const;

function manualInput() {
  return {
    conversationId,
    explicitlyConfirmed: true,
    idempotencyKey: "manual-multi-number-reply",
    kind: "text" as const,
    provider: "meta" as const,
    realProviderEnabled: true,
    senderUserId: actorId,
    text: "Reply to the latest sender",
  };
}

describe("WhatsApp manual outbound routing", () => {
  it("does not expose an idempotent outbound result after Inbox removal", async () => {
    const fixture = transaction([[]]);

    await expect(
      queueWhatsAppOutbound(fixture.sql, manualInput(), configuredSecondSender),
    ).rejects.toThrow("conversation is no longer available in the Inbox");
    expect(fixture.statements).toHaveLength(1);
    expect(fixture.statements[0]).toContain("removed_from_inbox_at");
    expect(fixture.statements[0]).toContain("FOR UPDATE");
  });

  it("locks the available conversation before replaying an idempotent request", async () => {
    const input = manualInput();
    const requestFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          conversationId: input.conversationId,
          provider: input.provider,
          senderUserId: input.senderUserId,
          senderType: "user",
          delivery: { kind: "text", text: input.text },
        }),
      )
      .digest("hex");
    const fixture = transaction([
      [{ id: conversationId }],
      [],
      [
        {
          id: "60000000-0000-4000-8000-000000000001",
          message_id: "70000000-0000-4000-8000-000000000001",
          conversation_id: conversationId,
          provider: "meta",
          request_fingerprint: requestFingerprint,
          removed_from_inbox_at: null,
        },
      ],
    ]);

    await expect(
      queueWhatsAppOutbound(fixture.sql, input, configuredSecondSender),
    ).resolves.toEqual({
      requestId: "60000000-0000-4000-8000-000000000001",
      messageId: "70000000-0000-4000-8000-000000000001",
      conversationId,
      provider: "meta",
      queued: false,
    });
    expect(fixture.statements).toHaveLength(3);
    expect(fixture.statements[0]).toContain("FOR UPDATE");
    expect(fixture.statements[1]).toContain("pg_advisory_xact_lock");
    expect(fixture.statements[2]).toContain("messaging.outbound_requests");
  });

  it("binds a reply to the selected channel and latest inbound origin, never the primary identity", async () => {
    const fixture = transaction([
      [{ id: conversationId }],
      [],
      [],
      [
        {
          conversation_id: conversationId,
          channel_id: channelId,
          contact_id: "50000000-0000-4000-8000-000000000001",
          customer_service_window_expires_at: new Date(Date.now() + 60_000),
          ownership_epoch: "7",
          lifecycle_status: "active",
          whatsapp_consent: "granted",
          whatsapp_opted_out_at: null,
          // This deliberately represents the non-primary number from the
          // latest signed inbound message on a two-number contact.
          recipient_identity_id: latestSenderIdentityId,
          normalized_value: latestSenderAddress,
        },
      ],
      [{ id: "60000000-0000-4000-8000-000000000001" }],
      [{ id: "70000000-0000-4000-8000-000000000001" }],
      [],
      [],
      [],
    ]);

    await expect(
      queueWhatsAppOutbound(fixture.sql, manualInput(), configuredSecondSender),
    ).resolves.toMatchObject({
      conversationId,
      provider: "meta",
      queued: true,
    });

    const routing = fixture.statements[3] ?? "";
    expect(routing).toContain("messaging.inbound_message_origins");
    expect(routing).toContain("inbound.id DESC");
    expect(routing).toContain("channel.provider_account_id=?");
    expect(routing).not.toContain("candidate.is_primary");
    expect(fixture.values[3]).toContain(configuredSecondSender.phoneNumberId);
    expect(fixture.statements.join("\n")).not.toContain(
      "INSERT INTO messaging.conversations",
    );
    expect(fixture.values[5]).toContain(conversationId);
    expect(fixture.values[5]).toContain(channelId);
    expect(fixture.values[5]).toContain(latestSenderIdentityId);
    expect(fixture.values[5]).toContain(latestSenderAddress);
  });

  it("fails before writes when the selected conversation sender or latest origin does not match", async () => {
    const fixture = transaction([[{ id: conversationId }], [], [], []]);

    await expect(
      // The selected conversation belongs to the second sender channel, while
      // the process is configured for the first. Admission must fail instead
      // of silently creating/routing through the first channel.
      queueWhatsAppOutbound(fixture.sql, manualInput(), configuredFirstSender),
    ).rejects.toThrow("conversation has no valid WhatsApp recipient");

    expect(fixture.statements).toHaveLength(4);
    expect(
      fixture.statements.some((statement) =>
        /^\s*(?:INSERT|UPDATE|DELETE)\b/u.test(statement),
      ),
    ).toBe(false);
  });
});
