"use client";

import { MessageCircle, Search, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type {
  ConversationSummary,
  Message,
  MessageCursor,
  QueuedWhatsAppOutbound,
  QuickReply,
  TeamMember,
} from "@or-on/crm";
import { Badge, Button, EmptyState, Input, Surface } from "@or-on/ui";
import { crmMutation, crmRead } from "../crm";
import { ConversationThread } from "./conversation-thread";
import { emptyReply, ReplyIntentKeys, type ReplyDraft } from "./reply-intent";

export function InboxWorkspace({
  conversations,
  initialMessages,
  initialConversationId,
  initialNextCursor = null,
  quickReplies,
  realWhatsAppEnabled,
  metaSenderId,
  teamMembers,
  canOperate = false,
}: {
  readonly conversations: readonly ConversationSummary[];
  readonly initialMessages: readonly Message[];
  readonly initialConversationId?: string | undefined;
  readonly initialNextCursor?: MessageCursor | null;
  readonly quickReplies: readonly QuickReply[];
  readonly realWhatsAppEnabled: boolean;
  readonly metaSenderId?: string | undefined;
  readonly teamMembers: readonly TeamMember[];
  readonly canOperate?: boolean;
}) {
  const initialId = initialConversationId ?? conversations[0]?.id;
  const [items, setItems] = useState(conversations);
  const [selectedId, setSelectedId] = useState(initialId);
  const [mobileThread, setMobileThread] = useState(false);
  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState<Readonly<Record<string, ReplyDraft>>>(
    {},
  );
  const [keys] = useState(() => new ReplyIntentKeys());
  const [listError, setListError] = useState<string>();
  const [simulationError, setSimulationError] = useState<string>();
  const [simulating, setSimulating] = useState(false);
  const [notice, setNotice] = useState<string>();
  const selected = items.find((item) => item.id === selectedId);
  const alive = useRef(true);
  const refreshRevision = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      refreshRevision.current += 1;
    };
  }, []);
  // Route/tenant refreshes reconcile server data without discarding local drafts.
  useEffect(() => setItems(conversations), [conversations]);

  async function refreshItems(ensureId?: string) {
    const revision = ++refreshRevision.current;
    const result = await crmRead<{ conversations: ConversationSummary[] }>(
      "/api/messaging/conversations",
    );
    if (!Array.isArray(result.conversations))
      throw new Error("Conversation list could not be read.");
    let next = result.conversations;
    if (ensureId && !next.some((item) => item.id === ensureId)) {
      const specific = await crmRead<{ conversations: ConversationSummary[] }>(
        `/api/messaging/conversations?id=${encodeURIComponent(ensureId)}`,
      );
      next = [...specific.conversations, ...next];
    }
    if (alive.current && revision === refreshRevision.current) {
      setItems(next);
      setListError(undefined);
    }
  }

  async function queued(result: QueuedWhatsAppOutbound, originId: string) {
    setNotice(
      result.queued
        ? "Message queued. Follow its status in the destination conversation."
        : "Existing request found. No duplicate message was queued.",
    );
    // Queue success must not become a send failure just because refresh failed.
    try {
      await refreshItems(result.conversationId);
      if (alive.current)
        setSelectedId((current) =>
          current === originId ? result.conversationId : current,
        );
    } catch {
      if (alive.current)
        setListError(
          "Message queued, but the conversation list could not refresh. Refresh the page; do not send it again.",
        );
    }
  }

  async function simulate(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canOperate || simulating) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setSimulating(true);
    setSimulationError(undefined);
    try {
      const result = await crmMutation<{ conversationId: string }>(
        "/api/messaging/simulate/inbound",
        {
          from: data.get("from"),
          profileName: data.get("profileName"),
          text: data.get("text"),
        },
      );
      form.reset();
      setNotice(
        "Fictional inbound message created. No external provider was contacted.",
      );
      try {
        await refreshItems(result.conversationId);
        setSelectedId(result.conversationId);
        setMobileThread(true);
      } catch {
        setListError(
          "Fictional message created, but the list could not refresh. Refresh the page; do not create it again.",
        );
      }
    } catch (error) {
      setSimulationError(
        error instanceof Error
          ? error.message
          : "Could not create the fictional message.",
      );
    } finally {
      setSimulating(false);
    }
  }

  const filtered = items.filter((item) =>
    `${item.contactName} ${item.recipientAddress ?? ""} ${item.provider}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase().trim()),
  );
  return (
    <div
      className={`inbox-layout ${mobileThread ? "inbox-layout--thread" : ""}`}
    >
      <Surface className="inbox-list">
        <div className="inbox-list__heading">
          <h2>
            Conversations <span>{items.length}</span>
          </h2>
          <Button
            aria-label="Refresh conversations"
            variant="quiet"
            onClick={() =>
              void refreshItems(selectedId).catch(() =>
                setListError(
                  "Could not refresh conversations. Please try again.",
                ),
              )
            }
          >
            ↻
          </Button>
        </div>
        <label className="inbox-search">
          <Search aria-hidden="true" size={16} />
          <span className="or-visually-hidden">
            Search loaded conversations
          </span>
          <input
            placeholder="Search conversations…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {listError ? (
          <p className="form-error" role="alert">
            {listError}
          </p>
        ) : null}
        <div className="conversation-list" aria-label="Conversations">
          {filtered.length === 0 ? (
            <div className="list-empty">
              <MessageCircle aria-hidden="true" size={24} />
              <h3>
                {query ? "No matching conversations" : "Your Inbox is clear"}
              </h3>
              <p>
                {query
                  ? "Try another name or clear the search."
                  : "New customer conversations will appear here."}
              </p>
            </div>
          ) : (
            filtered.map((conversation) => (
              <button
                className={`conversation-row ${selectedId === conversation.id ? "conversation-row--active" : ""}`}
                aria-current={
                  selectedId === conversation.id ? "true" : undefined
                }
                key={conversation.id}
                onClick={() => {
                  setSelectedId(conversation.id);
                  setMobileThread(true);
                  setNotice(undefined);
                }}
                type="button"
              >
                <span className="contact-avatar" aria-hidden="true">
                  {conversation.contactName.slice(0, 1)}
                </span>
                <span className="conversation-row__copy">
                  <strong>{conversation.contactName}</strong>
                  <small>
                    {conversation.lastMessagePreview ??
                      "No text preview available"}
                  </small>
                  <span className="conversation-row__channel">
                    {conversation.provider === "meta"
                      ? "Meta WhatsApp"
                      : conversation.provider === "simulator"
                        ? "Simulator"
                        : conversation.channelKind}
                  </span>
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
        </div>
        <div className="inbox-list__footer">
          <Badge
            label={
              realWhatsAppEnabled ? "Real delivery available" : "Simulator only"
            }
            tone={realWhatsAppEnabled ? "warning" : "info"}
          />
          <small>
            Latest {Math.min(items.length, 100)} conversations · search covers
            this list
          </small>
        </div>
        {canOperate ? (
          <details className="demo-tools">
            <summary>
              <Sparkles aria-hidden="true" size={14} /> Fictional demo tools
            </summary>
            <form
              className="simulator-form"
              onSubmit={(event) => void simulate(event)}
            >
              <p>
                Local fixture only. This does not open a real Meta
                customer-service window.
              </p>
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
                dir="ltr"
              />
              <Input
                id="sim-text"
                label="Fictional message"
                name="text"
                placeholder="Can you help me?"
                required
              />
              {simulationError ? (
                <p className="form-error" role="alert">
                  {simulationError}
                </p>
              ) : null}
              <Button disabled={simulating} type="submit" variant="secondary">
                {simulating ? "Creating…" : "Simulate inbound"}
              </Button>
            </form>
          </details>
        ) : null}
      </Surface>
      <Surface className="message-panel" level="raised">
        {selected === undefined ? (
          <EmptyState
            description="Select a conversation to see its history and customer context."
            title="A little context goes a long way"
          />
        ) : (
          <ConversationThread
            key={selected.id}
            conversation={selected}
            initialPage={
              selected.id === initialId
                ? {
                    messages: initialMessages.filter(
                      (message) => message.conversationId === selected.id,
                    ),
                    nextCursor: initialNextCursor,
                  }
                : undefined
            }
            draft={drafts[selected.id] ?? emptyReply}
            setDraft={(draft) =>
              setDrafts((current) => ({ ...current, [selected.id]: draft }))
            }
            keys={keys}
            canOperate={canOperate}
            realWhatsAppEnabled={realWhatsAppEnabled}
            metaSenderId={metaSenderId}
            quickReplies={quickReplies}
            teamMembers={teamMembers}
            onBack={() => setMobileThread(false)}
            onQueued={(result) => queued(result, selected.id)}
            onChanged={() => refreshItems(selected.id)}
          />
        )}
      </Surface>
      {notice ? (
        <div className="inbox-notice" role="status">
          {notice}
        </div>
      ) : null}
    </div>
  );
}
