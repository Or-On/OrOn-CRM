import { localized } from "./localized";
// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary, Message, MessagePage } from "@or-on/crm";
import { NextIntlClientProvider } from "next-intl";

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

function mount(real = true, canOperate = true) {
  return render(
    localized(
      <InboxWorkspace
        conversations={conversations}
        initialMessages={messagesA}
        quickReplies={[]}
        teamMembers={[]}
        realWhatsAppEnabled={real}
        metaSenderId="fictional-sender-id"
        canOperate={canOperate}
      />,
    ),
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
  vi.unstubAllGlobals();
});

function sendMessage() {
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
}

describe("Inbox interaction safety (no provider network)", () => {
  function compactViewport() {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  }

  it("uses the persisted account avatar in the Inbox profile link", () => {
    const view = render(
      localized(
        <InboxWorkspace
          conversations={conversations}
          initialMessages={messagesA}
          quickReplies={[]}
          teamMembers={[
            {
              userId: "operator-current",
              email: "support@or-on.io",
              displayName: "Or-On Support",
              role: "owner",
            },
          ]}
          realWhatsAppEnabled
          metaSenderId="fictional-sender-id"
          canOperate
          currentUserId="operator-current"
        />,
      ),
    );

    const profile = screen.getByRole("link", { name: /Or-On Support/u });
    expect(profile.getAttribute("href")).toBe("/profile");
    expect(
      profile.querySelector<HTMLImageElement>(".identity-image__media")?.src,
    ).toContain("/api/account/avatar?v=0");
    expect(
      profile.querySelector(".identity-image__fallback")?.textContent,
    ).toBe("OR");
    expect(
      view.container.querySelector(".inbox-channel-profile__avatar"),
    ).not.toBeNull();
  });

  it("contains compact channel focus, makes the background inert and restores focus on every dismissal", () => {
    compactViewport();
    const view = mount();
    const trigger = view.container.querySelector<HTMLButtonElement>(
      ".inbox-channel-toggle",
    );
    if (!trigger) throw new Error("Channel trigger missing");
    const background = document.createElement("div");
    background.setAttribute("inert", "preexisting");
    document.body.append(background);
    const open = () => {
      trigger.focus();
      fireEvent.click(trigger);
      const panel = screen.getByRole("dialog", { name: "Inbox navigation" });
      expect(panel.getAttribute("aria-modal")).toBe("true");
      expect(
        view.container.querySelector(".inbox-navigator")?.hasAttribute("inert"),
      ).toBe(true);
      expect(
        view.container
          .querySelector(".inbox-conversation")
          ?.hasAttribute("inert"),
      ).toBe(true);
      expect(document.body.style.overflow).toBe("hidden");
      return panel;
    };
    const panel = open();
    const first = within(panel).getByRole("button", {
      name: "Close navigation",
    });
    const last = within(panel).getByRole("link", { name: /Account/ });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    trigger.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    expect(
      view.container.querySelector(".inbox-navigator")?.hasAttribute("inert"),
    ).toBe(false);
    expect(background.getAttribute("inert")).toBe("preexisting");
    expect(document.body.style.overflow).not.toBe("hidden");
    open();
    const scrim = view.container.querySelector<HTMLButtonElement>(
      ".inbox-channel-scrim",
    );
    if (!scrim) throw new Error("Channel scrim missing");
    fireEvent.click(scrim);
    expect(document.activeElement).toBe(trigger);
    const reopened = open();
    fireEvent.click(
      within(reopened).getByRole("button", {
        name: /Filter conversations: Unread/,
      }),
    );
    expect(document.activeElement).toBe(trigger);
    const finalPanel = open();
    fireEvent.click(
      within(finalPanel).getByRole("button", { name: "Close navigation" }),
    );
    expect(document.activeElement).toBe(trigger);
    background.remove();
    expect(transport.mutate).not.toHaveBeenCalled();
  });

  it("keeps the collapsed desktop channel navigation inert", () => {
    const view = mount();
    const trigger = view.container.querySelector<HTMLButtonElement>(
      ".inbox-channel-toggle",
    );
    if (!trigger) throw new Error("Channel trigger missing");
    fireEvent.click(trigger);
    expect(
      view.container
        .querySelector(".inbox-channel-sidebar")
        ?.hasAttribute("inert"),
    ).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(
      view.container
        .querySelector(".inbox-channel-sidebar")
        ?.hasAttribute("inert"),
    ).toBe(false);
  });

  it("transfers contact drawer focus, traps compact focus and restores its trigger with the draft intact", () => {
    compactViewport();
    mount();
    const draft = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Reply message",
    });
    fireEvent.change(draft, { target: { value: "Preserved context draft" } });
    const trigger = screen.getByRole("button", { name: "Contact details" });
    fireEvent.click(trigger);
    const panel = screen.getByRole("dialog", { name: "Details" });
    const close = within(panel).getByRole("button", { name: "Close" });
    const link = within(panel).getByRole("link", { name: "Open contact" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(link);
    fireEvent.keyDown(link, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    expect(draft.value).toBe("Preserved context draft");
    fireEvent.click(trigger);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Details" })).getByRole(
        "button",
        { name: "Close" },
      ),
    );
    expect(document.activeElement).toBe(trigger);
    expect(transport.mutate).not.toHaveBeenCalled();
  });

  it("labels actual channels and filters WhatsApp without exposing other channels to its send action", async () => {
    const email = {
      ...beta,
      channelKind: "email",
      provider: "meta",
      recipientAddress: "fixture@example.invalid",
    };
    transport.read.mockResolvedValue({ messages: messagesB, nextCursor: null });
    render(
      localized(
        <InboxWorkspace
          conversations={[alpha, email]}
          initialMessages={messagesB}
          initialConversationId="beta"
          quickReplies={[]}
          teamMembers={[]}
          realWhatsAppEnabled
          canOperate
        />,
      ),
    );
    await screen.findByText("Beta private fixture");
    const thread = screen.getByRole("region", { name: /Fictional Beta/ });
    expect(within(thread).getAllByText("Email").length).toBeGreaterThan(0);
    expect(
      within(thread).getByRole<HTMLButtonElement>("button", {
        name: "Send message",
      }).disabled,
    ).toBe(true);
    const composer = thread.querySelector("form");
    if (!composer) throw new Error("Composer missing");
    fireEvent.submit(composer);
    expect(
      screen.queryByRole("dialog", { name: "Send this message?" }),
    ).toBeNull();
    const channel = screen.getByRole("button", { name: /^WhatsApp\s*1$/ });
    fireEvent.click(channel);
    expect(channel.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByRole("button", { name: /Fictional Alpha/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Fictional Beta/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    expect(screen.getByRole("button", { name: /Fictional Beta/ })).toBeTruthy();
    expect(transport.mutate).not.toHaveBeenCalled();
  });

  it("uses the app timezone for thread dates, times and delivery history", async () => {
    const createdAt = "2026-09-11T01:30:00Z";
    const localizedMessage = {
      ...message("alpha", "Timezone fixture"),
      createdAt,
      deliveryEvents: [{ status: "delivered", occurredAt: createdAt }],
    };
    transport.read.mockResolvedValue({
      messages: [localizedMessage],
      nextCursor: null,
    });
    const view = render(
      localized(
        <NextIntlClientProvider locale="en" timeZone="America/Los_Angeles">
          <InboxWorkspace
            conversations={[{ ...alpha, lastMessageAt: createdAt }]}
            initialMessages={[localizedMessage]}
            quickReplies={[]}
            teamMembers={[]}
            realWhatsAppEnabled={false}
          />
        </NextIntlClientProvider>,
      ),
    );
    await screen.findByText("Timezone fixture");
    const thread = view.container.querySelector(".message-thread");
    expect(thread?.textContent).toContain("September 10, 2026");
    expect(thread?.textContent).toContain("06:30 PM");
    expect(thread?.textContent).toContain(
      new Date(createdAt).toLocaleString("en", {
        timeZone: "America/Los_Angeles",
      }),
    );
  });

  it("scrolls the already-selected mobile thread to latest when opened without losing its draft", async () => {
    const view = mount();
    await act(async () => {
      await Promise.resolve();
    });
    const thread = view.container.querySelector<HTMLElement>(".message-thread");
    if (!thread) throw new Error("Thread missing");
    Object.defineProperty(thread, "scrollHeight", {
      value: 1400,
      configurable: true,
    });
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollTo");
    scroll.mockClear();
    fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), {
      target: { value: "Retained mobile draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Fictional Alpha/ }));
    expect(scroll).toHaveBeenCalledWith({ top: 1400 });
    fireEvent.click(
      screen.getByRole("button", { name: "Back to conversations" }),
    );
    scroll.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Fictional Alpha/ }));
    expect(scroll).toHaveBeenCalledWith({ top: 1400 });
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Reply message",
      }).value,
    ).toBe("Retained mobile draft");
    expect(transport.mutate).not.toHaveBeenCalled();
  });

  it("does not reset mobile scroll or read cursors while earlier history is open", async () => {
    const cursor = { createdAt: "2026-09-03T10:00:00Z", id: "message-alpha" };
    const earlier = {
      ...message("alpha", "Earlier private fixture"),
      id: "older-alpha",
      createdAt: "2026-09-02T10:00:00Z",
    };
    transport.read.mockImplementation((url: string) =>
      Promise.resolve({
        messages: url.includes("before=") ? [earlier] : messagesA,
        nextCursor: url.includes("before=") ? null : cursor,
      }),
    );
    const view = render(
      localized(
        <InboxWorkspace
          conversations={conversations}
          initialMessages={messagesA}
          initialNextCursor={cursor}
          quickReplies={[]}
          teamMembers={[]}
          realWhatsAppEnabled={false}
          canOperate
        />,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: /Fictional Alpha/ }));
    fireEvent.click(screen.getByRole("button", { name: /earlier messages/i }));
    await screen.findByText("Earlier private fixture");
    const thread = view.container.querySelector<HTMLElement>(".message-thread");
    if (!thread) throw new Error("Thread missing");
    thread.scrollTop = 37;
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollTo");
    scroll.mockClear();
    transport.read.mockClear();
    fireEvent.click(
      screen.getByRole("button", { name: "Back to conversations" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Fictional Alpha/ }));
    expect(thread.scrollTop).toBe(37);
    expect(scroll).not.toHaveBeenCalled();
    expect(transport.read).not.toHaveBeenCalled();
    expect(
      screen.getByText("Viewing history · live updates paused"),
    ).toBeTruthy();
    expect(screen.getByText("Earlier private fixture")).toBeTruthy();
  });

  it("keeps failed status changes visible in the conversation controls dialog", async () => {
    transport.mutate.mockRejectedValueOnce(new Error("fixture failure"));
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Conversation controls" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Conversation controls",
    });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Status" }), {
      target: { value: "pending" },
    });
    expect((await within(dialog).findByRole("alert")).textContent).toBeTruthy();
    expect(transport.mutate).toHaveBeenCalledExactlyOnceWith(
      "/api/messaging/conversations/alpha",
      { status: "pending" },
      { method: "PATCH" },
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("requires confirmation before removing only the selected conversation", async () => {
    transport.read.mockImplementation((url: string) =>
      Promise.resolve(
        url === "/api/messaging/conversations"
          ? { conversations: [beta] }
          : { messages: messagesB, nextCursor: null },
      ),
    );
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Conversation controls" }),
    );
    const controls = screen.getByRole("dialog", {
      name: "Conversation controls",
    });
    fireEvent.click(
      within(controls).getByRole("button", { name: "Remove conversation" }),
    );
    const confirmation = screen.getByRole("dialog", {
      name: "Remove this conversation?",
    });
    expect(transport.mutate).not.toHaveBeenCalled();
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Cancel" }),
    );
    expect(transport.mutate).not.toHaveBeenCalled();

    fireEvent.click(
      within(controls).getByRole("button", { name: "Remove conversation" }),
    );
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Remove this conversation?" }),
      ).getByRole("button", { name: "Remove from Inbox" }),
    );

    await waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledExactlyOnceWith(
        "/api/messaging/conversations/alpha",
        {},
        { method: "DELETE" },
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "Fictional Beta" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Fictional Alpha/ }),
    ).toBeNull();
    expect(screen.getByText("Conversation deleted.")).toBeTruthy();
  });

  it("removes protected technician evidence from the Inbox with an honest notice", async () => {
    transport.read.mockImplementation((url: string) =>
      Promise.resolve(
        url === "/api/messaging/conversations"
          ? { conversations: [beta] }
          : { messages: messagesB, nextCursor: null },
      ),
    );
    transport.mutate.mockResolvedValueOnce({
      ok: true,
      retainedAsEvidence: true,
      storageCleanupPending: 0,
    });
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Conversation controls" }),
    );
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Conversation controls" }),
      ).getByRole("button", { name: "Remove conversation" }),
    );
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Remove this conversation?" }),
      ).getByRole("button", { name: "Remove from Inbox" }),
    );

    expect(
      await screen.findByText(
        "Conversation removed from the Inbox. Technician-case evidence was preserved in the case dossier.",
      ),
    ).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "Fictional Beta" }),
    ).toBeTruthy();
  });

  it("keeps the confirmation open when active messaging work blocks deletion", async () => {
    transport.mutate.mockRejectedValueOnce(
      new Error(
        "This conversation still has queued or in-progress work. Wait for it to finish before deleting.",
      ),
    );
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Conversation controls" }),
    );
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Conversation controls" }),
      ).getByRole("button", { name: "Remove conversation" }),
    );
    const confirmation = screen.getByRole("dialog", {
      name: "Remove this conversation?",
    });
    fireEvent.click(
      within(confirmation).getByRole("button", {
        name: "Remove from Inbox",
      }),
    );
    expect(
      await within(confirmation).findByText(
        "This conversation is still processing a message or AI reply. Wait for it to finish, then try again.",
      ),
    ).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: "Fictional Alpha" }),
    ).toBeTruthy();
  });

  it("does not expose conversation deletion to read-only users", () => {
    mount(true, false);
    fireEvent.click(
      screen.getByRole("button", { name: "Conversation controls" }),
    );
    expect(
      within(
        screen.getByRole("dialog", { name: "Conversation controls" }),
      ).queryByRole("button", { name: "Remove conversation" }),
    ).toBeNull();
  });

  // An agent whose newest version is an unpublished draft: the ordinary state
  // after editing one. The conversation must still be handed to the live
  // version, which is what the platform would actually run.
  const draftAheadAgent = {
    id: "agent",
    name: "Fictional support agent",
    description: null,
    version: 2,
    versionId: "00000000-0000-4000-8000-000000000092",
    channels: ["whatsapp"] as const,
    published: false,
    validationStatus: "valid" as const,
    capabilities: [],
    roleTitle: null,
    leadFieldSchemaId: null,
    publishedVersion: 1,
    publishedVersionId: "00000000-0000-4000-8000-000000000091",
    publishedChannels: ["whatsapp"] as const,
    leadFieldSchema: null,
    implicitTicketing: false,
    review: {
      enabledActions: [],
      leadFields: [],
      blocking: [],
      promptWarnings: [],
    },
    lifecycle: {
      draftVersion: 2,
      assignedConversations: 0,
      staleConversations: 0,
      assignedFlows: 0,
      runningCalls: 0,
    },
  };

  it("lets an operator explicitly switch between a published AI agent and human takeover", async () => {
    render(
      localized(
        <InboxWorkspace
          agentProfiles={[draftAheadAgent]}
          aiRepliesEnabled
          conversations={conversations}
          initialMessages={messagesA}
          quickReplies={[]}
          teamMembers={[]}
          realWhatsAppEnabled={false}
          canOperate
        />,
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Conversation controls" }),
    );
    const responder = screen.getByRole("combobox", {
      name: "Conversation responder",
    });
    fireEvent.change(responder, {
      target: { value: "00000000-0000-4000-8000-000000000091" },
    });
    await waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        "/api/messaging/conversations/alpha",
        {
          ownershipMode: "ai",
          agentProfileVersionId: "00000000-0000-4000-8000-000000000091",
        },
        { method: "PATCH" },
      ),
    );
    fireEvent.change(responder, { target: { value: "human" } });
    await waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        "/api/messaging/conversations/alpha",
        expect.objectContaining({ ownershipMode: "human" }),
        { method: "PATCH" },
      ),
    );
    expect(transport.mutate).not.toHaveBeenCalledWith(
      "/api/messaging/conversations/alpha",
      expect.objectContaining({
        agentProfileVersionId: "00000000-0000-4000-8000-000000000092",
      }),
      expect.anything(),
    );
  });

  it("tells an operator why an AI handover was refused instead of a generic failure", async () => {
    transport.mutate.mockRejectedValueOnce(
      new Error("WhatsApp AI is disabled by the platform operator"),
    );
    render(
      localized(
        <InboxWorkspace
          agentProfiles={[draftAheadAgent]}
          aiRepliesEnabled
          conversations={conversations}
          initialMessages={messagesA}
          quickReplies={[]}
          teamMembers={[]}
          realWhatsAppEnabled={false}
          canOperate
        />,
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Conversation controls" }),
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: "Conversation responder" }),
      { target: { value: "00000000-0000-4000-8000-000000000091" } },
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "WhatsApp AI is disabled by the platform operator",
    );
  });

  it("opens directly on the unread queue from a route-backed intent", () => {
    render(
      localized(
        <InboxWorkspace
          conversations={[alpha, { ...beta, unreadCount: 2 }]}
          initialFilter="unread"
          initialMessages={messagesA}
          quickReplies={[]}
          teamMembers={[]}
          realWhatsAppEnabled={false}
          canOperate
        />,
      ),
    );

    expect(
      screen
        .getByRole("button", { name: /^Unread/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: /Fictional Beta/ })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Fictional Alpha/ }),
    ).toBeNull();
  });

  it("initializes route search and applies truthful assignment/status filters", () => {
    const assignedAlpha: ConversationSummary = {
      ...alpha,
      assignedUserId: "operator-current",
    };
    const waitingBeta: ConversationSummary = {
      ...beta,
      status: "pending",
    };
    const resolvedGamma: ConversationSummary = {
      ...alpha,
      id: "gamma",
      contactId: "contact-c",
      contactName: "Fictional Gamma",
      assignedUserId: "operator-other",
      status: "resolved",
    };
    const initial = render(
      localized(
        <InboxWorkspace
          conversations={[assignedAlpha, waitingBeta, resolvedGamma]}
          currentUserId="operator-current"
          initialMessages={messagesA}
          initialSearch="Beta"
          quickReplies={[]}
          teamMembers={[]}
          realWhatsAppEnabled={false}
          canOperate
        />,
      ),
    );

    expect(screen.getByRole("button", { name: /Fictional Beta/ })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Fictional Alpha/ }),
    ).toBeNull();

    initial.unmount();
    render(
      localized(
        <InboxWorkspace
          conversations={[assignedAlpha, waitingBeta, resolvedGamma]}
          currentUserId="operator-current"
          initialMessages={messagesA}
          quickReplies={[]}
          teamMembers={[]}
          realWhatsAppEnabled={false}
          canOperate
        />,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Mine/ }));
    expect(
      screen.getByRole("button", { name: /Fictional Alpha/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Fictional Beta/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Waiting/ }));
    expect(screen.getByRole("button", { name: /Fictional Beta/ })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Fictional Alpha/ }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Closed/ }));
    expect(
      screen.getByRole("button", { name: /Fictional Gamma/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Fictional Beta/ })).toBeNull();
  });

  it("searches on the server and discovers conversations past the first page", async () => {
    const cursor = {
      lastMessageAt: "2026-09-15T10:00:00.123456Z",
      id: "30000000-0000-4000-8000-000000000001",
    };
    const later: ConversationSummary = {
      ...alpha,
      id: "later",
      contactId: "contact-later",
      contactName: "Fictional Later Page",
    };
    const searched: ConversationSummary = {
      ...alpha,
      id: "searched",
      contactId: "contact-searched",
      contactName: "Needle Customer",
    };
    transport.read.mockImplementation((url: string) => {
      if (url.includes("/messages"))
        return Promise.resolve({ messages: messagesA, nextCursor: null });
      if (url.includes("q=Needle"))
        return Promise.resolve({ conversations: [searched], nextCursor: null });
      if (url.includes("beforeId="))
        return Promise.resolve({ conversations: [later], nextCursor: null });
      return Promise.resolve({ conversations, nextCursor: cursor });
    });
    render(
      localized(
        <InboxWorkspace
          conversations={conversations}
          initialConversationNextCursor={cursor}
          initialMessages={messagesA}
          quickReplies={[]}
          teamMembers={[]}
          realWhatsAppEnabled={false}
          canOperate
        />,
      ),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Load more conversations" }),
    );
    expect(
      await screen.findByRole("button", { name: /Fictional Later Page/ }),
    ).toBeTruthy();
    expect(
      transport.read.mock.calls.some(
        ([url]) =>
          typeof url === "string" &&
          url.includes(`before=${encodeURIComponent(cursor.lastMessageAt)}`) &&
          url.includes(`beforeId=${cursor.id}`),
      ),
    ).toBe(true);

    const search = screen.getByRole("searchbox", {
      name: "Search conversations",
    });
    fireEvent.change(search, { target: { value: "Needle" } });
    const searchForm = search.closest("form");
    if (searchForm === null) throw new Error("search form unavailable");
    fireEvent.submit(searchForm);
    expect(
      await screen.findByRole("button", { name: /Needle Customer/ }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Fictional Later Page/ }),
    ).toBeNull();
    expect(
      transport.read.mock.calls.some(
        ([url]) => typeof url === "string" && url.includes("q=Needle"),
      ),
    ).toBe(true);
  });

  it("renders authorized inbound image, document, and location affordances", () => {
    const inbound: Message[] = [
      {
        ...message("alpha", ""),
        id: "media-image",
        contentType: "image",
        contentText: null,
        media: {
          kind: "image",
          status: "available",
          mimeType: "image/png",
          fileName: "door.png",
          caption: "Front door",
        },
      },
      {
        ...message("alpha", ""),
        id: "media-document",
        contentType: "document",
        contentText: null,
        media: {
          kind: "document",
          status: "available",
          mimeType: "application/pdf",
          fileName: "invoice.pdf",
          caption: null,
        },
      },
      {
        ...message("alpha", ""),
        id: "media-pending",
        contentType: "document",
        contentText: null,
        media: {
          kind: "document",
          status: "pending",
          mimeType: "application/pdf",
          fileName: null,
          caption: null,
        },
      },
      {
        ...message("alpha", ""),
        id: "shared-location",
        contentType: "location",
        contentText: null,
        location: {
          latitude: 32.0853,
          longitude: 34.7818,
          name: "Fictional location",
          address: "Example street",
        },
      },
    ];
    render(
      localized(
        <InboxWorkspace
          conversations={[alpha]}
          initialMessages={inbound}
          quickReplies={[]}
          teamMembers={[]}
          realWhatsAppEnabled={false}
          canOperate
        />,
      ),
    );

    expect(
      screen.getByRole("img", { name: "Front door" }).getAttribute("src"),
    ).toBe("/api/messaging/messages/media-image/media");
    const document = screen.getByRole("link", { name: "Download document" });
    expect(document.getAttribute("href")).toBe(
      "/api/messaging/messages/media-document/media",
    );
    expect(document.getAttribute("download")).toBe("invoice.pdf");
    expect(
      screen.getByText("Attachment is waiting for secure retrieval"),
    ).toBeTruthy();
    const map = screen.getByRole("link", { name: "Open in OpenStreetMap" });
    expect(map.getAttribute("href")).toContain(
      "openstreetmap.org/?mlat=32.0853&mlon=34.7818",
    );
    expect(screen.getByText("Example street")).toBeTruthy();
  });

  it("keeps the Mine filter unavailable without a current operator identity", () => {
    mount();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /^Mine/ }).disabled,
    ).toBe(true);
  });

  it("shows only available contact context and links to the canonical contact", () => {
    mount();
    expect(screen.queryByRole("complementary", { name: "Details" })).toBeNull();
    const trigger = screen.getByRole("button", { name: "Contact details" });
    fireEvent.click(trigger);
    expect(screen.getByRole("complementary", { name: "Details" })).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close" }),
    );
    expect(
      screen
        .getByRole<HTMLAnchorElement>("link", { name: "Open contact" })
        .getAttribute("href"),
    ).toBe("/contacts/contact-a");
    expect(screen.getAllByText("Unassigned").length).toBeGreaterThan(0);
    expect(screen.queryByText("Granted")).toBeNull();
    expect(screen.queryByText(/consent/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary", { name: "Details" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("renders a polled send failure in the actual thread without resubmitting", async () => {
    transport.read.mockResolvedValue({
      messages: [
        {
          ...message("alpha", "Fictional failed reply"),
          direction: "outbound",
          status: "failed",
          deliveryFailure: {
            code: "meta_100",
            diagnostic: {
              version: 1,
              httpStatus: 400,
              metaCode: 100,
              metaSubcode: 33,
              reason: "resource_access",
              retryable: false,
            },
          },
        },
      ],
      nextCursor: null,
    });
    mount();
    await screen.findByText("Delivery issue");
    expect(screen.getByText("meta_100")).toBeTruthy();
    expect(screen.getByText(/unavailable or inaccessible/)).toBeTruthy();
    expect(transport.mutate).not.toHaveBeenCalled();
  });
  it("preserves a draft when locale changes and localizes direct send in Hebrew", async () => {
    const content = () => (
      <InboxWorkspace
        conversations={conversations}
        initialMessages={messagesA}
        quickReplies={[]}
        teamMembers={[]}
        realWhatsAppEnabled
        canOperate
        metaSenderId="fictional-sender-id"
      />
    );
    const view = render(localized(content(), "en"));
    await screen.findByText("Alpha private fixture");
    fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), {
      target: { value: "Fictional bilingual draft" },
    });
    view.rerender(localized(content(), "he"));
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", { name: "הודעת תשובה" })
        .value,
    ).toBe("Fictional bilingual draft");
    expect(screen.queryByRole("combobox", { name: "מצב שליחה" })).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "שליחת הודעה" })
        .disabled,
    ).toBe(false);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(
      screen.queryByRole("dialog", { name: "לשלוח את ההודעה?" }),
    ).toBeNull();
    expect(transport.mutate).not.toHaveBeenCalled();
  });
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
    sendMessage();
    await screen.findByText(
      "Could not queue the message. Your draft is preserved.",
    );
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Reply message",
      }).value,
    ).toBe("Fictional reply");
    sendMessage();
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
    sendMessage();
    await screen.findByRole("heading", { name: "Fictional Beta" });
    expect(screen.queryByText("Alpha private fixture")).toBeNull();
  });

  it("uses the composer send action without a second confirmation dialog", async () => {
    mount(true);
    await screen.findByText("Alpha private fixture");
    fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), {
      target: { value: "Fictional direct content" },
    });
    expect(transport.mutate).not.toHaveBeenCalled();
    sendMessage();
    await waitFor(() => expect(transport.mutate).toHaveBeenCalledOnce());
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(
      screen.queryByRole("dialog", { name: "Send this message?" }),
    ).toBeNull();
  });

  it("does not expose write controls to a read-only operator", () => {
    mount(true, false);
    expect(screen.queryByRole("textbox", { name: "Reply message" })).toBeNull();
    expect(screen.getByText(/Read-only access/)).toBeTruthy();
    expect(screen.queryByText("Fictional demo tools")).toBeNull();
  });

  it("has no mode control or simulator fallback when delivery is disabled", async () => {
    mount(false);
    await screen.findByText("Alpha private fixture");
    fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), {
      target: { value: "Never sent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Delivery mode" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /simulator/i })).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Send message" })
        .disabled,
    ).toBe(true);
    expect(transport.mutate).not.toHaveBeenCalled();
  });

  it("queues a real-provider request from the explicit composer send action (mock transport)", async () => {
    mount(true);
    await screen.findByText("Alpha private fixture");
    fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), {
      target: { value: "Fictional reviewed content" },
    });
    expect(transport.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
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
    sendMessage();
    await screen.findByText(
      /Message queued, but the conversation list could not refresh/,
    );
    expect(transport.mutate).toHaveBeenCalledOnce();
    expect(
      screen.getByText("Message queued. Delivery is not yet confirmed."),
    ).toBeTruthy();
  });

  it("clears the unread badge after a reply and shows it again only for new inbound activity", async () => {
    let latest = [{ ...alpha, unreadCount: 8 }, beta];
    transport.read.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("/messages")
          ? { messages: messagesA, nextCursor: null }
          : { conversations: latest },
      ),
    );
    render(
      localized(
        <InboxWorkspace
          conversations={latest}
          initialMessages={messagesA}
          quickReplies={[]}
          teamMembers={[]}
          realWhatsAppEnabled
          canOperate
          metaSenderId="fictional-sender-id"
        />,
      ),
    );
    expect(screen.getByLabelText("8 unread messages")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), {
      target: { value: "Fictional operator response" },
    });
    latest = [{ ...alpha, unreadCount: 0 }, beta];
    sendMessage();
    await waitFor(() =>
      expect(screen.queryByLabelText(/unread message/)).toBeNull(),
    );

    latest = [
      {
        ...alpha,
        unreadCount: 1,
        lastMessageAt: "2026-09-12T12:01:00.000Z",
      },
      beta,
    ];
    fireEvent.click(
      screen.getByRole("button", { name: "Filter conversations" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Refresh conversations" }),
    );
    expect(await screen.findByLabelText("1 unread message")).toBeTruthy();
  });

  it("leaves cross-page message announcements to the shell notification center", async () => {
    let latest = conversations;
    transport.read.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("/messages")
          ? { messages: messagesA, nextCursor: null }
          : { conversations: latest },
      ),
    );
    mount();
    latest = [
      {
        ...alpha,
        unreadCount: 1,
        lastMessageAt: "2026-09-12T12:02:00.000Z",
      },
      beta,
    ];
    fireEvent.click(
      screen.getByRole("button", { name: "Filter conversations" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Refresh conversations" }),
    );
    await waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        "/api/messaging/conversations/alpha",
        { read: true },
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    expect(screen.queryByText("New message from Fictional Alpha")).toBeNull();
  });
});
