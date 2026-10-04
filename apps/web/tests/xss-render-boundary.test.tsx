import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConversationSummary, Message } from "@or-on/crm";
import { localized } from "./localized";
vi.mock("../src/features/crm", () => ({
  crmRead: vi.fn(),
  crmMutation: vi.fn(),
}));
import { InboxWorkspace } from "../src/features/inbox";

const attack =
  '<img src=x onerror="window.__xss=1"><svg onload="window.__xss=2"></svg><script>window.__xss=3</script>[open](javascript:window.__xss=4)';
const conversation: ConversationSummary = {
  id: "owned-xss",
  contactId: "owned-contact",
  contactName: attack,
  status: "open",
  unreadCount: 0,
  lastMessageAt: null,
  lastMessagePreview: attack,
  assignedUserId: null,
  channelKind: "whatsapp",
  provider: "simulator",
  senderAddress: "Simulator",
  providerAccountId: null,
  recipientAddress: "+12025550100",
  whatsAppConsent: "granted",
  whatsAppOptedOutAt: null,
  customerServiceWindowExpiresAt: null,
};
function message(id: string, direction: "inbound" | "outbound"): Message {
  return {
    id,
    conversationId: conversation.id,
    direction,
    senderType: direction === "inbound" ? "contact" : "agent",
    contentType: "text",
    contentText: attack,
    status: direction === "inbound" ? "received" : "sent",
    providerMessageId: null,
    createdAt: "2026-09-03T10:00:00Z",
    reactions: [],
    deliveryEvents: [],
  };
}
describe("customer and model content XSS boundary", () => {
  it("renders stored names, customer messages and model replies as literal text", () => {
    const html = renderToStaticMarkup(
      localized(
        <InboxWorkspace
          conversations={[conversation]}
          initialMessages={[
            message("customer", "inbound"),
            message("model", "outbound"),
          ]}
          quickReplies={[]}
          teamMembers={[]}
          realWhatsAppEnabled={false}
          canOperate={false}
        />,
      ),
    );
    expect(html).toContain("&lt;img src=x onerror=");
    expect(html).toContain("&lt;script&gt;window.__xss=3&lt;/script&gt;");
    expect(html).not.toContain('<img src="x"');
    expect(html).not.toContain("<script>window.__xss");
    expect(html).not.toContain('href="javascript:');
    const directory = mkdtempSync(join(tmpdir(), "oron-xss-render-"));
    try {
      const artifact = join(directory, "xss-inbox-render.html");
      writeFileSync(artifact, html);
      expect(readFileSync(artifact, "utf8")).toBe(html);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
