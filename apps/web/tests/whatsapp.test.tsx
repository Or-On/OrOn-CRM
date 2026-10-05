import { renderMarkup as renderToStaticMarkup } from "./localized";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { InboxWorkspace } from "../src/features/inbox";

describe("WhatsApp delivery surface", () => {
  it.each([
    { provider: "simulator" as const, senderAddress: "WhatsApp simulator" },
    { provider: "meta" as const, senderAddress: "+972501110000" },
  ])(
    "shows the configured $provider sender without delivery-mode or permission controls",
    ({ provider, senderAddress }) => {
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
              templatesEnabled: true,
              provider,
              senderAddress,
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
      expect(markup).toContain(senderAddress);
      expect(markup).not.toContain("Delivery mode");
      expect(markup).not.toContain("delivery mode");
      expect(markup).not.toContain("Consent");
      expect(markup).toContain('aria-label="Compose"');
      expect(markup).toContain("Template");
      expect(markup).toContain("Send message");
      expect(markup).not.toContain("Send this message?");
      expect(markup).toContain("Reply message");
    },
  );
});
