import { describe, expect, it } from "vitest";
import type { ConversationSummary } from "@or-on/crm";

import { findInboundConversationAlerts } from "./inbox-notifications";

const conversation: ConversationSummary = {
  id: "conversation-a",
  contactId: "contact-a",
  contactName: "Fictional Customer",
  status: "open",
  unreadCount: 0,
  lastMessageAt: "2026-09-12T10:00:00.000Z",
  lastMessagePreview: "Fixture",
  assignedUserId: null,
  channelKind: "whatsapp",
  provider: "meta",
  senderAddress: null,
  providerAccountId: "fixture-account",
  recipientAddress: "+12025550123",
  whatsAppConsent: "granted",
  whatsAppOptedOutAt: null,
  customerServiceWindowExpiresAt: "2026-09-13T10:00:00.000Z",
};

describe("inbox notification detection", () => {
  it("alerts only when unread inbound activity increases", () => {
    expect(
      findInboundConversationAlerts(
        [conversation],
        [
          {
            ...conversation,
            unreadCount: 2,
            lastMessageAt: "2026-09-12T10:01:00.000Z",
          },
        ],
      ),
    ).toEqual([
      expect.objectContaining({
        conversationId: "conversation-a",
        newMessageCount: 2,
      }),
    ]);
  });

  it("stays silent when a reply clears unread state or a refresh is unchanged", () => {
    expect(
      findInboundConversationAlerts(
        [{ ...conversation, unreadCount: 3 }],
        [{ ...conversation, unreadCount: 0 }],
      ),
    ).toEqual([]);
    expect(
      findInboundConversationAlerts(
        [{ ...conversation, unreadCount: 1 }],
        [{ ...conversation, unreadCount: 1 }],
      ),
    ).toEqual([]);
  });

  it("detects a newly arrived conversation after an established empty baseline", () => {
    expect(
      findInboundConversationAlerts([], [{ ...conversation, unreadCount: 1 }]),
    ).toHaveLength(1);
  });
});
