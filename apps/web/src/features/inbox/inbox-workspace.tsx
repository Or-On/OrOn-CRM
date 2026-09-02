"use client";

import { MessageCircle, Send, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type SyntheticEvent } from "react";

import type {
  ConversationSummary,
  Message,
  QuickReply,
  TeamMember,
} from "@or-on/crm";
import { Badge, Button, EmptyState, Input, Surface } from "@or-on/ui";

import { crmMutation } from "../crm";

export function InboxWorkspace({
  conversations,
  initialMessages,
  quickReplies,
  realWhatsAppEnabled,
  teamMembers,
}: {
  readonly conversations: readonly ConversationSummary[];
  readonly initialMessages: readonly Message[];
  readonly quickReplies: readonly QuickReply[];
  readonly realWhatsAppEnabled: boolean;
  readonly teamMembers: readonly TeamMember[];
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(conversations[0]?.id);
  const [messages, setMessages] = useState(initialMessages);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [replyText, setReplyText] = useState("");
  const [provider, setProvider] = useState<"simulator" | "meta">("simulator");
  const [messageKind, setMessageKind] = useState<"text" | "template">("text");
  const selected = conversations.find(
    (conversation) => conversation.id === selectedId,
  );

  useEffect(() => {
    if (selectedId === undefined) return;
    const timer = window.setInterval(() => {
      void fetch(`/api/messaging/conversations/${selectedId}/messages`)
        .then((response) => response.json())
        .then((payload: { messages?: Message[] }) =>
          setMessages(payload.messages ?? []),
        )
        .catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [selectedId]);

  async function selectConversation(id: string) {
    setSelectedId(id);
    setError(undefined);
    const response = await fetch(`/api/messaging/conversations/${id}/messages`);
    const payload = (await response.json()) as { messages?: Message[] };
    setMessages(payload.messages ?? []);
  }

  function formText(data: FormData, key: string): string {
    const value = data.get(key);
    return typeof value === "string" ? value : "";
  }

  async function reply(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedId === undefined) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = formText(data, "text");
    const real = provider === "meta";
    if (
      real &&
      !window.confirm(
        "Send this message to the real recipient through Meta WhatsApp Cloud API? This cannot be undone.",
      )
    )
      return;
    setPending(true);
    setError(undefined);
    try {
      await crmMutation<{ queued: boolean }>(
        `/api/messaging/conversations/${selectedId}/messages`,
        {
          provider,
          kind: messageKind,
          text,
          templateName: formText(data, "templateName"),
          language: formText(data, "language"),
          parameters: formText(data, "parameters")
            .split("|")
            .map((value) => value.trim())
            .filter(Boolean),
          confirmReal: real && data.get("confirmReal") === "yes",
        },
        { idempotencyKey: crypto.randomUUID() },
      );
      setReplyText("");
      form.reset();
      router.refresh();
      await selectConversation(selectedId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Reply failed");
    } finally {
      setPending(false);
    }
  }

  async function simulate(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(undefined);
    try {
      const result = await crmMutation<{ conversationId: string }>(
        "/api/messaging/simulate/inbound",
        {
          from: formText(data, "from"),
          profileName: formText(data, "profileName"),
          text: formText(data, "text"),
        },
      );
      form.reset();
      router.refresh();
      await selectConversation(result.conversationId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Simulation failed");
    } finally {
      setPending(false);
    }
  }

  async function changeStatus(status: ConversationSummary["status"]) {
    if (selectedId === undefined) return;
    await crmMutation(
      `/api/messaging/conversations/${selectedId}`,
      { status },
      { method: "PATCH" },
    );
    router.refresh();
  }

  async function assign(userId: string) {
    if (selectedId === undefined) return;
    await crmMutation(
      `/api/messaging/conversations/${selectedId}`,
      { assignedUserId: userId || null },
      { method: "PATCH" },
    );
    router.refresh();
  }

  async function react(messageId: string, emoji: string) {
    await crmMutation(`/api/messaging/messages/${messageId}/reactions`, {
      emoji,
    });
    if (selectedId !== undefined) await selectConversation(selectedId);
  }

  return (
    <div className="inbox-layout">
      <Surface className="inbox-list">
        <div className="inbox-list__heading">
          <h2>Conversations</h2>
          <Badge
            label={
              realWhatsAppEnabled
                ? "Simulator + Meta enabled"
                : "Simulator default"
            }
            tone={realWhatsAppEnabled ? "warning" : "info"}
          />
        </div>
        {conversations.length === 0 ? (
          <EmptyState
            description="Inject the first fictional message below."
            title="Inbox is clear"
          />
        ) : (
          conversations.map((conversation) => (
            <button
              className={`conversation-row ${selectedId === conversation.id ? "conversation-row--active" : ""}`}
              key={conversation.id}
              onClick={() => void selectConversation(conversation.id)}
              type="button"
            >
              <span className="conversation-row__avatar" aria-hidden="true">
                <MessageCircle size={16} />
              </span>
              <span className="conversation-row__copy">
                <strong>{conversation.contactName}</strong>
                <small>
                  {conversation.lastMessagePreview ?? "No message preview"}
                </small>
              </span>
              {conversation.unreadCount > 0 ? (
                <span
                  className="unread-count"
                  aria-label={`${String(conversation.unreadCount)} unread`}
                >
                  {conversation.unreadCount}
                </span>
              ) : null}
            </button>
          ))
        )}
        <form
          className="simulator-form"
          onSubmit={(event) => void simulate(event)}
        >
          <div className="simulator-form__title">
            <Sparkles aria-hidden="true" size={15} /> Inject fictional inbound
          </div>
          <Input
            id="sim-name"
            label="Contact name"
            name="profileName"
            placeholder="Maya Cohen"
            required
          />
          <Input
            id="sim-from"
            label="E.164 number"
            name="from"
            placeholder="+972501234567"
            required
          />
          <Input
            id="sim-text"
            label="Message"
            name="text"
            placeholder="Can you help me?"
            required
          />
          <Button disabled={pending} type="submit" variant="secondary">
            Simulate inbound
          </Button>
        </form>
      </Surface>

      <Surface className="message-panel" level="raised">
        {selected === undefined ? (
          <EmptyState
            description="Select or simulate a conversation."
            title="No active conversation"
          />
        ) : (
          <>
            <header className="message-panel__heading">
              <div>
                <p className="eyebrow">
                  {selected.channelKind === "whatsapp"
                    ? "WhatsApp"
                    : selected.channelKind}
                </p>
                <h2>{selected.contactName}</h2>
              </div>
              <Badge
                label={selected.status}
                tone={selected.status === "open" ? "positive" : "neutral"}
              />
              <select
                aria-label="Conversation status"
                onChange={(event) =>
                  void changeStatus(
                    event.target.value as ConversationSummary["status"],
                  )
                }
                value={selected.status}
              >
                <option value="open">Open</option>
                <option value="pending">Pending</option>
                <option value="resolved">Resolved</option>
                <option value="closed">Closed</option>
              </select>
              <small>
                Real delivery requires the checkbox below and a final browser
                confirmation.
              </small>
              <select
                aria-label="Conversation assignee"
                onChange={(event) => void assign(event.target.value)}
                value={selected.assignedUserId ?? ""}
              >
                <option value="">Unassigned</option>
                {teamMembers.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.email} · {member.role}
                  </option>
                ))}
              </select>
            </header>
            <div aria-live="polite" className="message-thread">
              {messages.map((message) => (
                <div
                  className={`message-bubble message-bubble--${message.direction}`}
                  key={message.id}
                >
                  <p>{message.contentText ?? `[${message.contentType}]`}</p>
                  <small>
                    {message.direction} · {message.status}
                  </small>
                  {message.deliveryEvents.length === 0 ? null : (
                    <small aria-label="Delivery history">
                      {message.deliveryEvents
                        .map((event) => event.status)
                        .join(" → ")}
                    </small>
                  )}
                  <div className="reaction-row">
                    {message.reactions.map((reaction) => (
                      <span key={reaction}>{reaction}</span>
                    ))}
                    <button
                      aria-label="React with thumbs up"
                      onClick={() => void react(message.id, "👍")}
                      type="button"
                    >
                      ＋👍
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <form className="composer" onSubmit={(event) => void reply(event)}>
              <label htmlFor="delivery-provider">Delivery provider</label>
              <select
                id="delivery-provider"
                onChange={(event) =>
                  setProvider(event.target.value as "simulator" | "meta")
                }
                value={provider}
              >
                <option value="simulator">
                  Simulator — no external delivery
                </option>
                <option disabled={!realWhatsAppEnabled} value="meta">
                  REAL Meta WhatsApp delivery
                  {realWhatsAppEnabled ? "" : " — disabled"}
                </option>
              </select>
              <label htmlFor="message-kind">Message kind</label>
              <select
                id="message-kind"
                onChange={(event) =>
                  setMessageKind(event.target.value as "text" | "template")
                }
                value={messageKind}
              >
                <option value="text">
                  Free-form text (24-hour window only)
                </option>
                <option value="template">Approved template</option>
              </select>
              <div className="quick-reply-row">
                {quickReplies.map((quickReply) => (
                  <button
                    key={quickReply.id}
                    onClick={() => setReplyText(quickReply.body)}
                    type="button"
                  >
                    {quickReply.title}
                  </button>
                ))}
              </div>
              {messageKind === "template" ? (
                <div className="feature-form">
                  <Input
                    id="template-name"
                    label="Approved template name"
                    name="templateName"
                    required
                  />
                  <Input
                    id="template-language"
                    label="Template language"
                    name="language"
                    placeholder="he"
                    required
                  />
                  <Input
                    id="template-parameters"
                    label="Body parameters (separate with |)"
                    name="parameters"
                  />
                </div>
              ) : null}
              <div>
                <textarea
                  id="reply-text"
                  name="text"
                  onChange={(event) => setReplyText(event.target.value)}
                  placeholder="Write a reply"
                  required={messageKind === "text"}
                  rows={2}
                  value={replyText}
                />
                <Button
                  aria-label="Send reply"
                  disabled={pending}
                  type="submit"
                >
                  <Send aria-hidden="true" size={16} />
                </Button>
              </div>
              {provider === "meta" ? (
                <label className="real-provider-confirmation">
                  <input
                    name="confirmReal"
                    required
                    type="checkbox"
                    value="yes"
                  />
                  I understand this sends a real WhatsApp message to the
                  selected contact.
                </label>
              ) : null}
              {error === undefined ? null : (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
            </form>
          </>
        )}
      </Surface>
    </div>
  );
}
