"use client";

import { DeliveryFailure } from "./delivery-failure";

import { errorMessage } from "../../i18n/error-message";
import { useTranslations, useLocale } from "next-intl";

import {
  ThumbsUp,
  MessageCircle,
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  Send,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type {
  ConversationSummary,
  Message,
  MessageCursor,
  MessagePage,
  QueuedWhatsAppOutbound,
  QuickReply,
  TeamMember,
} from "@or-on/crm";
import { Badge, Button, Dialog, Input } from "@or-on/ui";
import { crmMutation, crmRead } from "../crm";
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
  onBack,
  onQueued,
  onChanged,
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
  readonly onBack: () => void;
  readonly onQueued: (result: QueuedWhatsAppOutbound) => Promise<void>;
  readonly onChanged: () => Promise<void>;
}) {
  const t = useTranslations();
  const locale = useLocale();
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
  const [confirmed, setConfirmed] = useState(false);
  const [review, setReview] = useState<ReplyDraft>();
  const scrollArea = useRef<HTMLDivElement>(null);
  const [receipt, setReceipt] = useState<string>();

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

  function updateDraft(change: Partial<ReplyDraft>) {
    setConfirmed(false);
    setReview(undefined);
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
    if (
      snapshot.provider === "meta" &&
      (!realWhatsAppEnabled || !confirmed || review === undefined)
    )
      return;
    setPending(true);
    setActionError(undefined);
    try {
      const result = await crmMutation<QueuedWhatsAppOutbound>(
        `/api/messaging/conversations/${conversation.id}/messages`,
        {
          ...snapshot,
          parameters: templateParameters(snapshot.parameters),
          confirmReal: snapshot.provider === "meta",
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
      setConfirmed(false);
      setReview(undefined);
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
    if (draft.provider === "meta") {
      if (!realWhatsAppEnabled || !confirmed) return;
      setReview({ ...draft });
    } else void send({ ...draft });
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

  return (
    <>
      <header className="message-panel__heading">
        <Button
          className="inbox-back"
          aria-label={t("inbox.back")}
          onClick={onBack}
          variant="quiet"
        >
          <ArrowLeft aria-hidden="true" size={18} />
        </Button>
        <span className="contact-avatar" aria-hidden="true">
          {conversation.contactName.slice(0, 1)}
        </span>
        <div className="message-contact">
          <Link href={`/contacts/${conversation.contactId}`}>
            <h2>{conversation.contactName}</h2>
          </Link>
          <small>
            <bdi>{conversation.recipientAddress ?? t("inbox.noRecipient")}</bdi>{" "}
            ·{" "}
            {conversation.provider === "meta"
              ? "Meta WhatsApp"
              : t("common.simulator")}
          </small>
        </div>
        <Badge
          label={
            t.has(`status.${conversation.status}`)
              ? t(`status.${conversation.status}`)
              : t("common.unknown")
          }
          tone={conversation.status === "open" ? "info" : "neutral"}
        />
        <details className="conversation-details">
          <summary>
            {t("common.details")}
            <ChevronDown aria-hidden="true" size={13} />
          </summary>
          <div>
            <p>
              {t("inbox.currentChannel")}
              {conversation.senderAddress ?? t("inbox.unknownSender")}
            </p>
            {conversation.providerAccountId ? (
              <p>
                {t("inbox.senderId")}
                <bdi>{conversation.providerAccountId}</bdi>
              </p>
            ) : null}
            <p>
              {t("inbox.consent")} {t(`status.${conversation.whatsAppConsent}`)}
              {conversation.whatsAppOptedOutAt ? t("inbox.optedOut") : ""}
            </p>
            <p>{t("inbox.eligibility")}</p>
            <label>
              {t("inbox.status")}
              <select
                disabled={!canOperate || pending}
                onChange={(event) =>
                  void change({ status: event.target.value })
                }
                value={conversation.status}
              >
                <option value="open">{t("status.open")}</option>
                <option value="pending">{t("status.pending")}</option>
                <option value="resolved">{t("status.resolved")}</option>
                <option value="closed">{t("status.closed")}</option>
              </select>
            </label>
            <label>
              {t("inbox.assigned")}
              <select
                disabled={!canOperate || pending}
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
              </select>
            </label>
          </div>
        </details>
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
          <p role="status" className="thread-notice">
            {t("inbox.loading")}
          </p>
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
            <p>{t("inbox.startsHint")}</p>
          </div>
        ) : null}
        {page.messages.map((message) => (
          <article
            className={`message-bubble message-bubble--${message.direction}`}
            key={message.id}
            aria-label={`${t(`status.${message.direction}`)} ${t(`status.${message.status}`)}`}
          >
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
                    {message.template.parameters.map((parameter, index) => (
                      <li key={index}>{parameter}</li>
                    ))}
                  </ol>
                ) : (
                  <p>{t("inbox.noParams")}</p>
                )}
                <small>{t("inbox.templateHint")}</small>
              </div>
            ) : (
              <p dir="auto">
                {message.contentText ?? `[${message.contentType}]`}
              </p>
            )}
            <footer>
              <time dateTime={message.createdAt}>
                {new Intl.DateTimeFormat(locale, {
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: "Asia/Jerusalem",
                }).format(new Date(message.createdAt))}
              </time>
              <span>
                {message.direction === "outbound"
                  ? t(`status.${message.status}`)
                  : t("inbox.received")}
              </span>
            </footer>
            {message.status === "failed" || message.deliveryFailure ? (
              <DeliveryFailure failure={message.deliveryFailure} />
            ) : null}
            {message.deliveryEvents.length ? (
              <details className="delivery-history">
                <summary>{t("inbox.deliveryHistory")}</summary>
                <ul>
                  {message.deliveryEvents.map((event, index) => (
                    <li key={index}>
                      {t(`status.${event.status}`)} ·{" "}
                      <time dateTime={event.occurredAt}>
                        {new Date(event.occurredAt).toLocaleString(locale, {
                          timeZone: "Asia/Jerusalem",
                        })}
                      </time>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {message.reactions.length || canOperate ? (
              <div className="reaction-row">
                {message.reactions.map((reaction) => (
                  <span key={reaction}>{reaction}</span>
                ))}
                {canOperate ? (
                  <button
                    aria-label={t("inbox.react")}
                    disabled={pending}
                    onClick={() => void change({ emoji: "👍" }, message.id)}
                    type="button"
                  >
                    <ThumbsUp aria-hidden="true" size={14} />
                  </button>
                ) : null}
              </div>
            ) : null}
          </article>
        ))}
      </div>
      <form className="composer" onSubmit={submit}>
        {receipt ? (
          <p role="status" className="queue-receipt">
            {receipt}
          </p>
        ) : null}
        {actionError && review === undefined ? (
          <p className="form-error" role="alert">
            {actionError}
          </p>
        ) : null}
        {!canOperate ? (
          <p className="thread-notice">{t("inbox.readOnly")}</p>
        ) : (
          <>
            <div className="composer-controls">
              <label htmlFor="delivery-provider">
                {t("inbox.mode")}
                <select
                  id="delivery-provider"
                  disabled={pending}
                  value={draft.provider}
                  onChange={(event) =>
                    updateDraft({
                      provider:
                        event.target.value === "meta" ? "meta" : "simulator",
                    })
                  }
                >
                  <option value="simulator">{t("inbox.simulator")}</option>
                  <option disabled={!realWhatsAppEnabled} value="meta">
                    {t("inbox.real")}
                    {realWhatsAppEnabled ? "" : " " + t("inbox.disabled")}
                  </option>
                </select>
              </label>
              <label htmlFor="message-kind">
                {t("inbox.type")}
                <select
                  id="message-kind"
                  disabled={pending}
                  value={draft.kind}
                  onChange={(event) =>
                    updateDraft({
                      kind:
                        event.target.value === "template" ? "template" : "text",
                    })
                  }
                >
                  <option value="text">{t("inbox.text")}</option>
                  <option value="template">{t("inbox.template")}</option>
                </select>
              </label>
            </div>
            {draft.provider === "meta" ? (
              <p className="sender-notice">
                {t("inbox.realSender")}{" "}
                <bdi>{metaSenderId ?? t("inbox.notConfigured")}</bdi>
                {t("inbox.senderHint")}
              </p>
            ) : (
              <p className="sender-notice">
                <ShieldCheck aria-hidden="true" size={13} />
                {t("inbox.simulatorHint")}
              </p>
            )}
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
                {quickReplies.length ? (
                  <div className="quick-reply-row">
                    {quickReplies.map((reply) => (
                      <button
                        disabled={pending}
                        key={reply.id}
                        onClick={() => updateDraft({ text: reply.body })}
                        type="button"
                      >
                        {reply.title}
                      </button>
                    ))}
                  </div>
                ) : null}
                <label className="or-visually-hidden" htmlFor="reply-text">
                  {t("inbox.reply")}
                </label>
                <textarea
                  id="reply-text"
                  dir="auto"
                  maxLength={4096}
                  disabled={pending}
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
            {draft.provider === "meta" ? (
              <label className="real-provider-confirmation">
                <input
                  required
                  type="checkbox"
                  checked={confirmed}
                  disabled={pending}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                {t("inbox.confirm", {
                  contact: conversation.contactName,
                  recipient:
                    "\u2068" +
                    (conversation.recipientAddress ?? t("inbox.noRecipient")) +
                    "\u2069",
                })}
              </label>
            ) : null}
            <div className="composer-footer">
              <small>
                {draft.kind === "text" ? (
                  <bdi dir="ltr">{draft.text.length} / 4096</bdi>
                ) : (
                  t("inbox.exactValues")
                )}
              </small>
              <Button
                disabled={
                  pending ||
                  loading ||
                  loadError !== undefined ||
                  (draft.provider === "meta" &&
                    (!confirmed || !realWhatsAppEnabled))
                }
                type="submit"
              >
                <Send aria-hidden="true" size={15} />{" "}
                {pending
                  ? t("inbox.queuing")
                  : draft.provider === "meta"
                    ? t("inbox.review")
                    : t("inbox.queueSimulator")}
              </Button>
            </div>
          </>
        )}
      </form>
      <Dialog
        closeLabel={t("common.close")}
        open={review !== undefined}
        onClose={() => {
          if (!pending) setReview(undefined);
        }}
        title={t("inbox.confirmTitle")}
        description={t("inbox.confirmHint")}
      >
        <dl className="send-review">
          <dt>{t("inbox.recipient")}</dt>
          <dd>
            {conversation.contactName} ·{" "}
            <bdi>{conversation.recipientAddress}</bdi>
          </dd>
          <dt>{t("inbox.configuredSender")}</dt>
          <dd>
            <bdi>{metaSenderId ?? t("inbox.notConfigured")}</bdi>
          </dd>
          <dt>{t("inbox.message")}</dt>
          <dd dir="auto">
            {review?.kind === "text"
              ? review.text
              : `${review?.templateName ?? ""} · ${review?.language ?? ""}\n${review?.parameters ?? ""}`}
          </dd>
        </dl>
        <p>{t("inbox.guardHint")}</p>
        {actionError && review !== undefined ? (
          <p role="alert" className="form-error">
            {actionError}
          </p>
        ) : null}
        <Button
          disabled={
            pending ||
            !realWhatsAppEnabled ||
            !confirmed ||
            review === undefined
          }
          onClick={() => {
            if (review) void send(review);
          }}
        >
          {pending ? t("inbox.queuing") : t("inbox.sendReal")}
        </Button>
      </Dialog>
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
