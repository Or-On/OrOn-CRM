import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { InboxWorkspace } from "../src/features/inbox";

describe("WhatsApp delivery surface", () => {
  it("defaults to simulator and labels real delivery unmistakably", () => {
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
    expect(markup).toContain("Simulator — no external delivery");
    expect(markup).toContain("REAL Meta WhatsApp delivery");
    expect(markup).toContain("Free-form text (24-hour window only)");
    expect(markup).toContain("Confirm real WhatsApp delivery");
    expect(markup).toContain("Queue simulator reply");
    expect(markup).toContain("Reply message");
  });
});
