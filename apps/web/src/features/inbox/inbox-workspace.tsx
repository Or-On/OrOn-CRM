"use client";

import { MessageCircle, Send, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

import type { ConversationSummary, Message, QuickReply } from "@or-on/crm";
import { Badge, Button, EmptyState, Input, Surface } from "@or-on/ui";

import { crmMutation } from "../crm";

export function InboxWorkspace({
  conversations,
  initialMessages,
  quickReplies,
}: {
  readonly conversations: readonly ConversationSummary[];
  readonly initialMessages: readonly Message[];
  readonly quickReplies: readonly QuickReply[];
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(conversations[0]?.id);
  const [messages, setMessages] = useState(initialMessages);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [replyText, setReplyText] = useState("");
  const selected = conversations.find(
    (conversation) => conversation.id === selectedId,
  );

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
    setPending(true);
    setError(undefined);
    try {
      const payload = await crmMutation<{ message: Message }>(
        `/api/messaging/conversations/${selectedId}/messages`,
        { text },
        { idempotencyKey: crypto.randomUUID() },
      );
      setMessages((current) => [...current, payload.message]);
      setReplyText("");
      form.reset();
      router.refresh();
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
          <Badge label="Simulator" tone="info" />
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
                <p className="eyebrow">WhatsApp simulator</p>
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
              <label htmlFor="reply-text">Reply through simulator</label>
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
              <div>
                <textarea
                  id="reply-text"
                  name="text"
                  onChange={(event) => setReplyText(event.target.value)}
                  placeholder="Write a reply"
                  required
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
