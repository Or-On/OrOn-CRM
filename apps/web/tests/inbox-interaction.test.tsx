// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary, Message, MessagePage } from "@or-on/crm";

const transport = vi.hoisted(() => ({ read: vi.fn(), mutate: vi.fn() }));
vi.mock("../src/features/crm", () => ({
  crmRead: transport.read,
  crmMutation: transport.mutate,
}));
import { InboxWorkspace } from "../src/features/inbox";

const alpha: ConversationSummary = {
  id: "alpha",
  contactId: "contact-a",
  contactName: "Fictional Alpha",
  status: "open",
  unreadCount: 0,
  lastMessageAt: null,
  lastMessagePreview: null,
  assignedUserId: null,
  channelKind: "whatsapp",
  provider: "simulator",
  senderAddress: "Simulator",
  providerAccountId: null,
  recipientAddress: "+972501234567",
  whatsAppConsent: "granted",
  whatsAppOptedOutAt: null,
  customerServiceWindowExpiresAt: null,
};
const beta: ConversationSummary = {
  ...alpha,
  id: "beta",
  contactId: "contact-b",
  contactName: "Fictional Beta",
};
function message(conversationId: string, contentText: string): Message {
  return {
    id: `message-${conversationId}`,
    conversationId,
    direction: "inbound",
    senderType: "contact",
    contentType: "text",
    contentText,
    status: "received",
    providerMessageId: null,
    createdAt: "2026-09-03T10:00:00Z",
    reactions: [],
    deliveryEvents: [],
  };
}
const messagesA = [message("alpha", "Alpha private fixture")];
const messagesB = [message("beta", "Beta private fixture")];
const conversations = [alpha, beta];

function mount(real = false, canOperate = true) {
  return render(
    <InboxWorkspace
      conversations={conversations}
      initialMessages={messagesA}
      quickReplies={[]}
      teamMembers={[]}
      realWhatsAppEnabled={real}
      metaSenderId="fictional-sender-id"
      canOperate={canOperate}
    />,
  );
}

beforeEach(() => {
  transport.read.mockReset().mockImplementation((url: string) =>
    Promise.resolve(
      url.includes("/messages")
        ? {
            messages: url.includes("alpha") ? messagesA : messagesB,
            nextCursor: null,
          }
        : { conversations },
    ),
  );
  transport.mutate.mockReset().mockResolvedValue({
    conversationId: "alpha",
    messageId: "queued",
    provider: "simulator",
    queued: true,
    requestId: "request",
  });
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  HTMLElement.prototype.scrollTo = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Inbox interaction safety (no provider network)", () => {
  it("ignores delayed Alpha results after selecting Beta and aborts the obsolete read", async () => {
    let resolveAlpha: ((value: MessagePage) => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    transport.read.mockImplementation((url: string, signal: AbortSignal) => {
      if (url.includes("alpha")) {
        oldSignal = signal;
        return new Promise<MessagePage>((resolve) => {
          resolveAlpha = resolve;
        });
      }
      return Promise.resolve({ messages: messagesB, nextCursor: null });
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Fictional Beta/ }));
    expect(screen.queryByText("Alpha private fixture")).toBeNull();
    await screen.findByText("Beta private fixture");
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => {
      resolveAlpha?.({ messages: messagesA, nextCursor: null });
      await Promise.resolve();
    });
    expect(screen.queryByText("Alpha private fixture")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Fictional Beta" }),
    ).toBeTruthy();
  });

  it("keeps drafts isolated per conversation", async () => {
    mount();
    await waitFor(() =>
      expect(screen.queryByText("Loading conversation…")).toBeNull(),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), {
      target: { value: "Draft for Alpha" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Fictional Beta/ }));
    await screen.findByText("Beta private fixture");
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Reply message",
      }).value,
    ).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /Fictional Alpha/ }));
    await screen.findByText("Alpha private fixture");
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Reply message",
      }).value,
    ).toBe("Draft for Alpha");
  });

  it("preserves failed drafts and reuses the idempotency key on retry", async () => {
    transport.mutate.mockRejectedValueOnce(
      new Error("Queue temporarily unavailable"),
    );
    mount();
    await screen.findByText("Alpha private fixture");
    fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), {
      target: { value: "Fictional reply" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Queue simulator reply" }),
    );
    await screen.findByText("Queue temporarily unavailable");
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Reply message",
      }).value,
    ).toBe("Fictional reply");
    fireEvent.click(
      screen.getByRole("button", { name: "Queue simulator reply" }),
    );
    await waitFor(() => expect(transport.mutate).toHaveBeenCalledTimes(2));
    expect(transport.mutate.mock.calls[0]?.[2]).toEqual(
      transport.mutate.mock.calls[1]?.[2],
    );
    await screen.findByText("Message queued. Delivery is not yet confirmed.");
  });

  it("follows the actual destination conversation returned by admission", async () => {
    transport.mutate.mockResolvedValue({
      conversationId: "beta",
      messageId: "queued",
      provider: "simulator",
      queued: true,
      requestId: "request",
    });
    mount();
    await screen.findByText("Alpha private fixture");
    fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), {
      target: { value: "Fictional routed reply" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Queue simulator reply" }),
    );
    await screen.findByRole("heading", { name: "Fictional Beta" });
    expect(screen.queryByText("Alpha private fixture")).toBeNull();
  });

  it("requires both confirmation stages and clears consent to send when the draft changes", async () => {
    mount(true);
    await screen.findByText("Alpha private fixture");
    fireEvent.change(screen.getByRole("combobox", { name: "Delivery mode" }), {
      target: { value: "meta" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), {
      target: { value: "Fictional confirmed content" },
    });
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Review real message",
      }).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Review real message" }),
    );
    await screen.findByRole("dialog", {
      name: "Confirm real WhatsApp delivery",
    });
    expect(transport.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), {
      target: { value: "Changed content" },
    });
    expect(screen.getByRole<HTMLInputElement>("checkbox").checked).toBe(false);
    expect(transport.mutate).not.toHaveBeenCalled();
  });

  it("does not expose write controls to a read-only operator", () => {
    mount(true, false);
    expect(screen.queryByRole("textbox", { name: "Reply message" })).toBeNull();
    expect(screen.getByText(/Read-only access/)).toBeTruthy();
    expect(screen.queryByText("Fictional demo tools")).toBeNull();
  });

  it("refuses real delivery when the flag is disabled, even after a forced selection", async () => {
    mount(false);
    await screen.findByText("Alpha private fixture");
    fireEvent.change(screen.getByRole("combobox", { name: "Delivery mode" }), {
      target: { value: "meta" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), {
      target: { value: "Never sent" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Review real message" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(transport.mutate).not.toHaveBeenCalled();
  });

  it("queues a real-provider request only after the final review confirmation (mock transport)", async () => {
    mount(true);
    await screen.findByText("Alpha private fixture");
    fireEvent.change(screen.getByRole("combobox", { name: "Delivery mode" }), {
      target: { value: "meta" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), {
      target: { value: "Fictional reviewed content" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Review real message" }),
    );
    await screen.findByRole("dialog", {
      name: "Confirm real WhatsApp delivery",
    });
    expect(transport.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send real WhatsApp" }));
    await waitFor(() => expect(transport.mutate).toHaveBeenCalledOnce());
    expect(transport.mutate.mock.calls[0]?.[1]).toMatchObject({
      provider: "meta",
      confirmReal: true,
      text: "Fictional reviewed content",
    });
  });

  it("reports queue success independently of a failed list refresh", async () => {
    transport.read.mockImplementation((url: string) =>
      url.includes("/messages")
        ? Promise.resolve({ messages: messagesA, nextCursor: null })
        : Promise.reject(new Error("Refresh failed")),
    );
    mount();
    await screen.findByText("Alpha private fixture");
    fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), {
      target: { value: "Fictional queued content" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Queue simulator reply" }),
    );
    await screen.findByText(
      /Message queued, but the conversation list could not refresh/,
    );
    expect(transport.mutate).toHaveBeenCalledOnce();
    expect(
      screen.getByText("Message queued. Delivery is not yet confirmed."),
    ).toBeTruthy();
  });
});
