"use client";

import { errorMessage } from "../../i18n/error-message";
import { useTranslations, useLocale } from "next-intl";

import { MessageCircle, Search, FlaskConical, RefreshCw } from "lucide-react";
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
  const t = useTranslations();
  const locale = useLocale();
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
      throw new Error(t("inbox.listInvalid"));
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
    setNotice(result.queued ? t("inbox.queued") : t("inbox.duplicate"));
    // Queue success must not become a send failure just because refresh failed.
    try {
      await refreshItems(result.conversationId);
      if (alive.current)
        setSelectedId((current) =>
          current === originId ? result.conversationId : current,
        );
    } catch {
      if (alive.current) setListError(t("inbox.queuedRefresh"));
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
      setNotice(t("inbox.fictionalCreated"));
      try {
        await refreshItems(result.conversationId);
        setSelectedId(result.conversationId);
        setMobileThread(true);
      } catch {
        setListError(t("inbox.fictionalRefresh"));
      }
    } catch (error) {
      setSimulationError(errorMessage(error, t, "inbox.fictionalFailed"));
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
            {t("inbox.conversations")} <span>{items.length}</span>
          </h2>
          <Button
            aria-label={t("inbox.refresh")}
            variant="quiet"
            onClick={() =>
              void refreshItems(selectedId).catch(() =>
                setListError(t("inbox.refreshFailed")),
              )
            }
          >
            <RefreshCw aria-hidden="true" size={16} />
          </Button>
        </div>
        <label className="inbox-search">
          <Search aria-hidden="true" size={16} />
          <span className="or-visually-hidden">{t("inbox.search")}</span>
          <input
            placeholder={t("inbox.searchHint")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {listError ? (
          <p className="form-error" role="alert">
            {listError}
          </p>
        ) : null}
        <div
          className="conversation-list"
          aria-label={t("inbox.conversations")}
        >
          {filtered.length === 0 ? (
            <div className="list-empty">
              <MessageCircle aria-hidden="true" size={24} />
              <h3>{query ? t("inbox.noMatches") : t("inbox.empty")}</h3>
              <p>{query ? t("inbox.searchHelp") : t("inbox.emptyHelp")}</p>
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
                  <strong>
                    <bdi>{conversation.contactName}</bdi>
                  </strong>
                  <small dir="auto">
                    {conversation.lastMessagePreview ?? t("common.noText")}
                  </small>
                  <span className="conversation-row__channel">
                    {conversation.provider === "meta"
                      ? "Meta WhatsApp"
                      : conversation.provider === "simulator"
                        ? t("common.simulator")
                        : conversation.channelKind}
                  </span>
                </span>
                {conversation.unreadCount > 0 ? (
                  <span
                    className="unread-count"
                    aria-label={t("inbox.unread", {
                      count: conversation.unreadCount,
                    })}
                  >
                    {conversation.unreadCount.toLocaleString(locale)}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
        <div className="inbox-list__footer">
          <Badge
            label={
              realWhatsAppEnabled
                ? t("inbox.realAvailable")
                : t("inbox.simulatorOnly")
            }
            tone={realWhatsAppEnabled ? "warning" : "info"}
          />
          <small>{t("inbox.loaded", { count: items.length })}</small>
        </div>
        {canOperate ? (
          <details className="demo-tools">
            <summary>
              <FlaskConical aria-hidden="true" size={14} />
              {t("inbox.demo")}
            </summary>
            <form
              className="simulator-form"
              onSubmit={(event) => void simulate(event)}
            >
              <p>{t("inbox.demoHint")}</p>
              <Input
                id="sim-name"
                label={t("inbox.contactName")}
                name="profileName"
                placeholder={t("inbox.fictionalName")}
                required
              />
              <Input
                id="sim-from"
                label={t("inbox.phone")}
                name="from"
                placeholder="+972501234567"
                required
                dir="ltr"
              />
              <Input
                id="sim-text"
                label={t("inbox.fictionalMessage")}
                name="text"
                placeholder={t("inbox.fictionalHint")}
                required
              />
              {simulationError ? (
                <p className="form-error" role="alert">
                  {simulationError}
                </p>
              ) : null}
              <Button disabled={simulating} type="submit" variant="secondary">
                {simulating ? t("inbox.creating") : t("inbox.simulate")}
              </Button>
            </form>
          </details>
        ) : null}
      </Surface>
      <Surface className="message-panel" level="raised">
        {selected === undefined ? (
          <EmptyState
            description={t("inbox.select")}
            title={t("inbox.context")}
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
