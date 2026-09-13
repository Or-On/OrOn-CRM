"use client";

import { DeliveryFailure } from "./delivery-failure";

import { errorMessage } from "../../i18n/error-message";
import { useTranslations, useLocale, useTimeZone } from "next-intl";

import {
  ArrowLeft,
  ArrowUp,
  CircleAlert,
  MessageCircle,
  MessageSquareText,
  MoreHorizontal,
  Send,
  ThumbsUp,
  Trash2,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type {
  AgentProfileSummary,
  ConversationSummary,
  Message,
  MessageCursor,
  MessagePage,
  QueuedWhatsAppOutbound,
  QuickReply,
  TeamMember,
} from "@or-on/crm";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  IconButton,
  Input,
  LoadingSkeleton,
  Popover,
  Select,
  Textarea,
} from "@or-on/ui";
import { crmMutation, crmRead } from "../crm";
import {
  conversationChannelKey,
  conversationDayKey,
} from "./conversation-presentation";
import {
  templateParameters,
  type ReplyDraft,
  type ReplyIntentKeys,
} from "./reply-intent";

function historyUrl(id: string, before?: MessageCursor | null): string {
  const base = `/api/messaging/conversations/${encodeURIComponent(id)}/messages`;
  return before
    ? `${base}?${new URLSearchParams({ before: before.createdAt, beforeId: before.id })}`
    : base;
}

function messageDay(value: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    timeZone,
    weekday: "short",
    year: "numeric",
  }).format(new Date(value));
}

function messageTime(value: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(value));
}

export function ConversationThread({
  conversation,
  initialPage,
  draft,
  setDraft,
  keys,
  canOperate,
  realWhatsAppEnabled,
  metaSenderId,
  quickReplies,
  teamMembers,
  agentProfiles = [],
  aiRepliesEnabled = false,
  mobileThreadOpen,
  onBack,
  onShowContact,
  onQueued,
  onChanged,
  onDeleted,
}: {
  readonly conversation: ConversationSummary;
  readonly initialPage: MessagePage | undefined;
  readonly draft: ReplyDraft;
  readonly setDraft: (draft: ReplyDraft) => void;
  readonly keys: ReplyIntentKeys;
  readonly canOperate: boolean;
  readonly realWhatsAppEnabled: boolean;
  readonly metaSenderId: string | undefined;
  readonly quickReplies: readonly QuickReply[];
  readonly teamMembers: readonly TeamMember[];
  readonly agentProfiles?: readonly AgentProfileSummary[];
  readonly aiRepliesEnabled?: boolean;
  readonly mobileThreadOpen: boolean;
  readonly onBack: () => void;
  readonly onShowContact: (trigger: HTMLButtonElement) => void;
  readonly onQueued: (result: QueuedWhatsAppOutbound) => Promise<void>;
  readonly onChanged: () => Promise<void>;
  readonly onDeleted: (conversationId: string) => Promise<void>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone() ?? "UTC";
  const channelLabel = t(conversationChannelKey(conversation.channelKind));
  const canSendWhatsApp =
    realWhatsAppEnabled && conversation.channelKind === "whatsapp";
  const [page, setPage] = useState<MessagePage>(
    initialPage ?? { messages: [], nextCursor: null },
  );
  const [loading, setLoading] = useState(initialPage === undefined);
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [history, setHistory] = useState(false);
  const historyRef = useRef(false);
  const historyRequest = useRef<AbortController | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const scrollArea = useRef<HTMLDivElement>(null);
  const [receipt, setReceipt] = useState<string>();
  const [controlsOpen, setControlsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const browsingHistory = () => historyRef.current;
    async function refresh() {
      try {
        if (!browsingHistory()) {
          const latest = await crmRead<MessagePage>(
            historyUrl(conversation.id),
            controller.signal,
          );
          if (cancelled || browsingHistory()) return;
          if (
            !Array.isArray(latest.messages) ||
            latest.messages.some(
              (message: Message) => message.conversationId !== conversation.id,
            )
          )
            throw new Error(t("inbox.mismatch"));
          setPage(latest);
          setLoadError(undefined);
          setLoading(false);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(errorMessage(error, t, "inbox.loadFailed"));
          setLoading(false);
        }
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), 5000);
      }
    }
    void refresh();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [conversation.id, refreshKey, t]);

  useEffect(() => () => historyRequest.current?.abort(), []);
  useEffect(() => {
    if (!history && !loading)
      scrollArea.current?.scrollTo({ top: scrollArea.current.scrollHeight });
  }, [page.messages.length, history, loading]);
  // The selected thread stays mounted while the mobile navigator is visible.
  // Its first hidden render cannot scroll; opening it must reveal the latest
  // messages, without moving an operator who explicitly loaded earlier history.
  useEffect(() => {
    if (mobileThreadOpen && !history && !loading)
      scrollArea.current?.scrollTo({ top: scrollArea.current.scrollHeight });
  }, [mobileThreadOpen, history, loading]);

  function updateDraft(change: Partial<ReplyDraft>) {
    setDraft({ ...draft, ...change });
  }

  async function loadOlder() {
    const before = page.nextCursor;
    if (!before) return;
    historyRef.current = true;
    setHistory(true);
    setLoading(true);
    historyRequest.current?.abort();
    const controller = new AbortController();
    historyRequest.current = controller;
    try {
      const older = await crmRead<MessagePage>(
        historyUrl(conversation.id, before),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (
        !Array.isArray(older.messages) ||
        older.messages.some(
          (message: Message) => message.conversationId !== conversation.id,
        )
      )
        throw new Error(t("inbox.historyMismatch"));
      setPage((current) => ({
        messages: [
          ...older.messages,
          ...current.messages.filter(
            (message) => !older.messages.some((item) => item.id === message.id),
          ),
        ],
        nextCursor: older.nextCursor,
      }));
      setLoadError(undefined);
    } catch (error) {
      if (!controller.signal.aborted)
        setLoadError(errorMessage(error, t, "inbox.historyFailed"));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  function latest() {
    historyRequest.current?.abort();
    historyRef.current = false;
    setHistory(false);
    setLoading(true);
    setRefreshKey((value) => value + 1);
  }

  async function send(snapshot: ReplyDraft) {
    if (!canOperate || pending || loading || loadError !== undefined) return;
    if (snapshot.provider !== "meta" || !canSendWhatsApp) return;
    setPending(true);
    setActionError(undefined);
    try {
      const result = await crmMutation<QueuedWhatsAppOutbound>(
        `/api/messaging/conversations/${conversation.id}/messages`,
        {
          ...snapshot,
          parameters: templateParameters(snapshot.parameters),
          confirmReal: true,
        },
        { idempotencyKey: keys.get(conversation.id, metaSenderId, snapshot) },
      );
      keys.complete(conversation.id, metaSenderId, snapshot);
      setDraft({
        ...snapshot,
        text: "",
        templateName: "",
        language: "",
        parameters: "",
      });
      setReceipt(
        result.queued ? t("inbox.queueSuccess") : t("inbox.queueDuplicate"),
      );
      await onQueued(result);
      latest();
    } catch (error) {
      setActionError(errorMessage(error, t, "inbox.queueFailed"));
    } finally {
      setPending(false);
    }
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canOperate || pending || !canSendWhatsApp || draft.provider !== "meta")
      return;
    void send({ ...draft });
  }

  async function change(body: Record<string, unknown>, messageId?: string) {
    if (!canOperate || pending) return;
    setPending(true);
    setActionError(undefined);
    try {
      await crmMutation(
        messageId
          ? `/api/messaging/messages/${messageId}/reactions`
          : `/api/messaging/conversations/${conversation.id}`,
        body,
        { method: messageId ? "POST" : "PATCH" },
      );
      await onChanged();
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setActionError(errorMessage(error, t, "inbox.updateFailed"));
    } finally {
      setPending(false);
    }
  }

  async function removeConversation() {
    if (!canOperate || pending) return;
    setPending(true);
    setActionError(undefined);
    try {
      await crmMutation(
        `/api/messaging/conversations/${conversation.id}`,
        {},
        { method: "DELETE" },
      );
      setDeleteOpen(false);
      setControlsOpen(false);
      await onDeleted(conversation.id);
    } catch (error) {
      setActionError(errorMessage(error, t, "inbox.deleteFailed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <header className="message-panel__heading conversation-header">
        <IconButton
          className="inbox-back"
          label={t("inbox.back")}
          onClick={onBack}
        >
          <ArrowLeft aria-hidden="true" size={18} />
        </IconButton>
        <span className="contact-avatar" aria-hidden="true">
          {conversation.contactName.slice(0, 1)}
        </span>
        <div className="message-contact">
          <Link href={`/contacts/${conversation.contactId}`}>
            <h2>
              <bdi>{conversation.contactName}</bdi>
            </h2>
          </Link>
          <span className="message-contact__metadata">
            <small>
              <bdi>
                {conversation.recipientAddress ?? t("inbox.noRecipient")}
              </bdi>
            </small>
            <span aria-hidden="true">·</span>
            <small>{channelLabel}</small>
          </span>
        </div>
        <div className="conversation-header__state">
          <Badge
            label={
              t.has(`status.${conversation.status}`)
                ? t(`status.${conversation.status}`)
                : t("common.unknown")
            }
            tone={conversation.status === "open" ? "positive" : "neutral"}
          />
          {conversation.unreadCount > 0 ? (
            <Badge
              label={t("inbox.unread", { count: conversation.unreadCount })}
              tone="info"
            />
          ) : null}
        </div>
        <IconButton
          label={t("inbox.contactDetails")}
          onClick={(event) => onShowContact(event.currentTarget)}
          className="conversation-header__contact-action"
        >
          <UserRound aria-hidden="true" size={18} />
        </IconButton>
        <IconButton
          className="conversation-actions"
          label={t("premiumPrimary.messageSettings")}
          onClick={() => setControlsOpen(true)}
        >
          <MoreHorizontal aria-hidden="true" size={18} />
        </IconButton>
        <Dialog
          className="conversation-controls-dialog"
          closeLabel={t("common.close")}
          title={t("premiumPrimary.messageSettings")}
          open={controlsOpen}
          onClose={() => setControlsOpen(false)}
        >
          <div className="conversation-actions__menu">
            <div className="conversation-actions__context">
              <p>
                {conversation.contactName} ·{" "}
                <bdi>{conversation.recipientAddress}</bdi>
              </p>
            </div>
            <div className="conversation-actions__fields">
              <Select
                disabled={!canOperate || pending}
                id={`conversation-owner-${conversation.id}`}
                label={t("inbox.responder")}
                onChange={(event) => {
                  const versionId = event.target.value;
                  void change(
                    versionId === "human"
                      ? {
                          ownershipMode: "human",
                          reason: "Human takeover requested from Inbox",
                        }
                      : {
                          ownershipMode: "ai",
                          agentProfileVersionId: versionId,
                        },
                  );
                }}
                value={
                  conversation.ownershipMode === "ai"
                    ? (conversation.aiAgentProfileVersionId ?? "human")
                    : "human"
                }
              >
                <option value="human">{t("inbox.humanResponder")}</option>
                {agentProfiles.flatMap((profile) =>
                  profile.versionId === null
                    ? []
                    : [
                        <option
                          disabled={!aiRepliesEnabled}
                          key={profile.versionId}
                          value={profile.versionId}
                        >
                          {t("inbox.aiResponder", { name: profile.name })}
                        </option>,
                      ],
                )}
              </Select>
              <small>
                {!aiRepliesEnabled
                  ? t("inbox.aiDisabled")
                  : agentProfiles.length === 0
                    ? t("inbox.noAiAgent")
                    : t("inbox.responderHint")}
              </small>
              <Select
                disabled={!canOperate || pending}
                id={`conversation-status-${conversation.id}`}
                label={t("inbox.status")}
                onChange={(event) =>
                  void change({ status: event.target.value })
                }
                value={conversation.status}
              >
                <option value="open">{t("status.open")}</option>
                <option value="pending">{t("status.pending")}</option>
                <option value="resolved">{t("status.resolved")}</option>
                <option value="closed">{t("status.closed")}</option>
              </Select>
              <Select
                disabled={!canOperate || pending}
                id={`conversation-assignee-${conversation.id}`}
                label={t("inbox.assigned")}
                onChange={(event) =>
                  void change({ assignedUserId: event.target.value || null })
                }
                value={conversation.assignedUserId ?? ""}
              >
                <option value="">{t("inbox.unassigned")}</option>
                {teamMembers.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.email} · {t(`status.${member.role}`)}
                  </option>
                ))}
              </Select>
            </div>
            {canOperate ? (
              <div className="conversation-actions__danger-zone">
                <div>
                  <strong>{t("inbox.deleteConversation")}</strong>
                  <p>{t("inbox.deleteConversationHint")}</p>
                </div>
                <Button
                  disabled={pending}
                  onClick={() => {
                    setActionError(undefined);
                    setDeleteOpen(true);
                  }}
                  size="small"
                  variant="danger"
                >
                  <Trash2 aria-hidden="true" size={15} />
                  {t("inbox.deleteConversation")}
                </Button>
              </div>
            ) : null}
          </div>
          {actionError && controlsOpen && !deleteOpen ? (
            <p className="form-error" role="alert">
              {actionError}
            </p>
          ) : null}
        </Dialog>
        <ConfirmDialog
          busy={pending}
          cancelLabel={t("common.cancel")}
          confirmLabel={t("inbox.deleteConversationConfirm")}
          destructive
          description={t("inbox.deleteConversationDescription", {
            contact: conversation.contactName,
          })}
          onCancel={() => {
            if (!pending) {
              setDeleteOpen(false);
              setActionError(undefined);
            }
          }}
          onConfirm={() => void removeConversation()}
          open={deleteOpen}
          title={t("inbox.deleteConversationTitle")}
        >
          {actionError && deleteOpen ? (
            <p className="form-error" role="alert">
              {actionError}
            </p>
          ) : null}
        </ConfirmDialog>
      </header>
      <div
        className="message-thread"
        ref={scrollArea}
        aria-label={t("inbox.threadLabel", {
          contact: conversation.contactName,
        })}
        aria-busy={loading}
      >
        {history ? (
          <div className="thread-notice">
            {t("inbox.historyMode")}{" "}
            <Button onClick={latest} variant="quiet">
              {t("inbox.latest")}
            </Button>
          </div>
        ) : null}
        {page.nextCursor ? (
          <Button
            className="history-button"
            disabled={loading}
            onClick={() => void loadOlder()}
            variant="quiet"
          >
            <ArrowUp aria-hidden="true" size={14} />
            {t("inbox.earlier")}
          </Button>
        ) : null}
        {loading ? (
          <div
            className="thread-loading"
            role="status"
            aria-label={t("inbox.loading")}
          >
            {page.messages.length ? (
              <p>{t("inbox.loading")}</p>
            ) : (
              <div aria-hidden="true">
                <LoadingSkeleton />
                <LoadingSkeleton />
                <LoadingSkeleton />
              </div>
            )}
          </div>
        ) : null}
        {loadError ? (
          <div className="thread-notice" role="alert">
            <p>{loadError}</p>
            <Button onClick={latest} variant="secondary">
              {t("inbox.retry")}
            </Button>
          </div>
        ) : null}
        {!loading && !loadError && page.messages.length === 0 ? (
          <div className="thread-empty">
            <MessagesPlaceholder />
            <h3>{t("inbox.starts")}</h3>
            <p>{t("tenantPrimary.startsHint")}</p>
          </div>
        ) : null}
        {page.messages.length ? (
          <ol
            aria-live={history ? "off" : "polite"}
            aria-relevant="additions"
            className="message-timeline"
            role="log"
          >
            {page.messages.map((message, index) => {
              const previous = page.messages[index - 1];
              const startsDay =
                previous === undefined ||
                conversationDayKey(new Date(previous.createdAt), timeZone) !==
                  conversationDayKey(new Date(message.createdAt), timeZone);
              const grouped =
                !startsDay &&
                previous.direction === message.direction &&
                previous.senderType === message.senderType &&
                new Date(message.createdAt).getTime() -
                  new Date(previous.createdAt).getTime() <
                  300_000;
              return (
                <li className="message-timeline__item" key={message.id}>
                  {startsDay ? (
                    <div className="message-day-separator" role="separator">
                      <time dateTime={message.createdAt}>
                        {messageDay(message.createdAt, locale, timeZone)}
                      </time>
                    </div>
                  ) : null}
                  <div
                    className={`message-cluster message-cluster--${message.direction} ${grouped ? "message-cluster--grouped" : ""}`}
                  >
                    <span className="message-author-avatar" aria-hidden="true">
                      {grouped
                        ? ""
                        : message.senderType === "contact"
                          ? conversation.contactName.slice(0, 1)
                          : "O"}
                    </span>
                    <div className="message-content-stack">
                      <article
                        aria-label={`${t(`status.${message.direction}`)} ${t(`status.${message.status}`)}`}
                        className={`message-bubble message-bubble--${message.direction} ${grouped ? "message-bubble--grouped" : ""}`}
                      >
                        {!grouped ? (
                          <small className="message-sender">
                            <bdi>
                              {message.senderType === "contact"
                                ? conversation.contactName
                                : t(
                                    message.senderType === "agent"
                                      ? "tenantPrimary.senderAgent"
                                      : message.senderType === "system"
                                        ? "tenantPrimary.senderSystem"
                                        : "tenantPrimary.senderTeam",
                                  )}
                            </bdi>
                          </small>
                        ) : null}
                        {message.template ? (
                          <div className="template-message">
                            <strong>
                              {t("inbox.templatePrefix")}
                              {message.template.name}
                            </strong>
                            <small>
                              {t("inbox.language")}
                              {message.template.language}
                            </small>
                            {message.template.parameters.length ? (
                              <ol>
                                {message.template.parameters.map(
                                  (parameter, parameterIndex) => (
                                    <li key={parameterIndex}>{parameter}</li>
                                  ),
                                )}
                              </ol>
                            ) : (
                              <p>{t("inbox.noParams")}</p>
                            )}
                            <small>{t("inbox.templateHint")}</small>
                          </div>
                        ) : (
                          <p dir="auto">
                            {message.contentText ??
                              t("tenantPrimary.unsupportedContent", {
                                type: message.contentType,
                              })}
                          </p>
                        )}
                        {message.status === "failed" ||
                        message.deliveryFailure ? (
                          <DeliveryFailure failure={message.deliveryFailure} />
                        ) : null}
                        {message.deliveryEvents.length ? (
                          <details className="delivery-history">
                            <summary>{t("inbox.deliveryHistory")}</summary>
                            <ul>
                              {message.deliveryEvents.map(
                                (event, eventIndex) => (
                                  <li key={eventIndex}>
                                    {t(`status.${event.status}`)} ·{" "}
                                    <time dateTime={event.occurredAt}>
                                      {new Date(
                                        event.occurredAt,
                                      ).toLocaleString(locale, {
                                        timeZone,
                                      })}
                                    </time>
                                  </li>
                                ),
                              )}
                            </ul>
                          </details>
                        ) : null}
                        {message.reactions.length || canOperate ? (
                          <div className="reaction-row">
                            {message.reactions.map((reaction) => (
                              <span key={reaction}>{reaction}</span>
                            ))}
                            {canOperate ? (
                              <IconButton
                                disabled={pending}
                                label={t("inbox.react")}
                                onClick={() =>
                                  void change({ emoji: "👍" }, message.id)
                                }
                              >
                                <ThumbsUp aria-hidden="true" size={14} />
                              </IconButton>
                            ) : null}
                          </div>
                        ) : null}
                      </article>
                      <footer className="message-footer">
                        <time dateTime={message.createdAt}>
                          {messageTime(message.createdAt, locale, timeZone)}
                        </time>
                        <span>
                          {message.direction === "outbound"
                            ? t(`status.${message.status}`)
                            : t("inbox.received")}
                        </span>
                      </footer>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : null}
      </div>
      <form className="composer conversation-composer" onSubmit={submit}>
        {receipt ? (
          <p role="status" className="queue-receipt">
            {receipt}
          </p>
        ) : null}
        {actionError && !controlsOpen && !deleteOpen ? (
          <p className="form-error" role="alert">
            {actionError}
          </p>
        ) : null}
        {!canOperate ? (
          <p className="thread-notice">{t("inbox.readOnly")}</p>
        ) : (
          <div className="composer-shell">
            <div
              className="composer-kind"
              role="group"
              aria-label={t("tenantPrimary.kind")}
            >
              {(["text", "template"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  disabled={pending}
                  aria-pressed={draft.kind === kind}
                  onClick={() => updateDraft({ kind })}
                >
                  {t(`tenantPrimary.${kind}`)}
                </button>
              ))}
              <span>{channelLabel}</span>
            </div>
            {draft.kind === "template" ? (
              <div className="template-fields">
                <Input
                  id="template-name"
                  label={t("inbox.templateName")}
                  required
                  disabled={pending}
                  value={draft.templateName}
                  onChange={(event) =>
                    updateDraft({ templateName: event.target.value })
                  }
                />
                <Input
                  id="template-language"
                  label={t("inbox.languageCode")}
                  placeholder="en_US / he"
                  dir="ltr"
                  required
                  disabled={pending}
                  value={draft.language}
                  onChange={(event) =>
                    updateDraft({ language: event.target.value })
                  }
                />
                <Input
                  id="template-parameters"
                  label={t("inbox.params")}
                  disabled={pending}
                  value={draft.parameters}
                  onChange={(event) =>
                    updateDraft({ parameters: event.target.value })
                  }
                />
                <p>{t("inbox.approvalHint")}</p>
              </div>
            ) : (
              <>
                <Textarea
                  className="composer__textarea"
                  dir="auto"
                  maxLength={4096}
                  disabled={pending}
                  id={`reply-text-${conversation.id}`}
                  label={t("inbox.reply")}
                  onChange={(event) =>
                    updateDraft({ text: event.target.value })
                  }
                  placeholder={t("inbox.replyHint")}
                  required
                  rows={3}
                  value={draft.text}
                />
              </>
            )}
            <div className="composer-footer">
              <div className="composer-footer__tools">
                {draft.kind === "text" && quickReplies.length ? (
                  <Popover
                    align="start"
                    contentClassName="composer-quick-replies"
                    disabled={pending}
                    label={t("inbox.quickReplies")}
                    role="menu"
                    trigger={<MessageSquareText aria-hidden="true" size={17} />}
                    triggerClassName="composer-tool"
                  >
                    {({ close }) =>
                      quickReplies.map((reply) => (
                        <button
                          disabled={pending}
                          key={reply.id}
                          onClick={() => {
                            updateDraft({ text: reply.body });
                            close();
                          }}
                          role="menuitem"
                          type="button"
                        >
                          {reply.title}
                        </button>
                      ))
                    }
                  </Popover>
                ) : null}
                {!canSendWhatsApp ? (
                  <span
                    className="sender-notice"
                    role="status"
                    title={t("tenantPrimary.sendingUnavailable")}
                  >
                    <CircleAlert aria-hidden="true" size={17} />
                    <span className="or-visually-hidden">
                      {t("tenantPrimary.sendingUnavailable")}
                    </span>
                  </span>
                ) : null}
              </div>
              <div className="composer-footer__meta">
                <small>
                  {draft.kind === "text" ? (
                    <bdi dir="ltr">{draft.text.length} / 4096</bdi>
                  ) : (
                    t("inbox.exactValues")
                  )}
                </small>
                <Button
                  aria-label={
                    pending ? t("inbox.queuing") : t("tenantPrimary.send")
                  }
                  busy={pending}
                  className="composer-send"
                  disabled={
                    pending ||
                    loading ||
                    loadError !== undefined ||
                    !canSendWhatsApp
                  }
                  title={pending ? t("inbox.queuing") : t("tenantPrimary.send")}
                  type="submit"
                >
                  <Send aria-hidden="true" size={16} />
                  <span className="or-visually-hidden">
                    {pending ? t("inbox.queuing") : t("tenantPrimary.send")}
                  </span>
                </Button>
              </div>
            </div>
          </div>
        )}
      </form>
    </>
  );
}

function MessagesPlaceholder() {
  return (
    <span aria-hidden="true" className="contact-avatar">
      <MessageCircle size={20} />
    </span>
  );
}
