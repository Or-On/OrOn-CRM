import { renderMarkup as renderToStaticMarkup } from "./localized";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { InboxWorkspace } from "../src/features/inbox";

describe("WhatsApp delivery surface", () => {
  it("presents one delivery workflow without exposing internal routing or permission controls", () => {
    const markup = renderToStaticMarkup(
      <InboxWorkspace
        conversations={[
          {
            id: "conversation",
            contactId: "contact",
            contactName: "Fictional Contact",
            status: "open",
            unreadCount: 0,
            lastMessageAt: null,
            lastMessagePreview: null,
            assignedUserId: null,
            channelKind: "whatsapp",
            provider: "simulator",
            senderAddress: "WhatsApp simulator",
            providerAccountId: null,
            recipientAddress: "+972501234567",
            whatsAppConsent: "unknown",
            whatsAppOptedOutAt: null,
            customerServiceWindowExpiresAt: null,
          },
        ]}
        initialMessages={[]}
        quickReplies={[]}
        realWhatsAppEnabled
        canOperate
        teamMembers={[]}
      />,
    );
    expect(markup).not.toContain("Simulator — no external delivery");
    expect(markup).not.toContain("REAL Meta WhatsApp delivery");
    expect(markup).not.toContain("WhatsApp simulator");
    expect(markup).not.toContain("Delivery mode");
    expect(markup).not.toContain("delivery mode");
    expect(markup).not.toContain("Consent");
    expect(markup).toContain('aria-label="Compose"');
    expect(markup).toContain("Template");
    expect(markup).toContain("Send message");
    expect(markup).not.toContain("Send this message?");
    expect(markup).toContain("Reply message");
  });
});
