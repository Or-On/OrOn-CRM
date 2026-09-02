"use client";

import {
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
            throw new Error(
              "Conversation response did not match this view. Please refresh.",
            );
          setPage(latest);
          setLoadError(undefined);
          setLoading(false);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "Could not load conversation.",
          );
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
  }, [conversation.id, refreshKey]);

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
        throw new Error("History response did not match this conversation.");
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
        setLoadError(
          error instanceof Error
            ? error.message
            : "Could not load earlier messages.",
        );
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
        result.queued
          ? "Message queued. Delivery is not yet confirmed."
          : "This request was already queued. No duplicate was created.",
      );
      await onQueued(result);
      latest();
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Could not queue the message. Your draft is preserved.",
      );
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
      setActionError(
        error instanceof Error
          ? error.message
          : "Could not update this conversation.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <header className="message-panel__heading">
        <Button
          className="inbox-back"
          aria-label="Back to conversations"
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
            <bdi>
              {conversation.recipientAddress ?? "No validated recipient"}
            </bdi>{" "}
            · {conversation.provider === "meta" ? "Meta WhatsApp" : "Simulator"}
          </small>
        </div>
        <Badge
          label={conversation.status}
          tone={conversation.status === "open" ? "info" : "neutral"}
        />
        <details className="conversation-details">
          <summary>
            Details <ChevronDown aria-hidden="true" size={13} />
          </summary>
          <div>
            <p>
              Current channel: {conversation.senderAddress ?? "Unknown sender"}
            </p>
            {conversation.providerAccountId ? (
              <p>
                Phone Number ID: <bdi>{conversation.providerAccountId}</bdi>
              </p>
            ) : null}
            <p>
              WhatsApp consent: {conversation.whatsAppConsent}
              {conversation.whatsAppOptedOutAt ? " · opted out" : ""}
            </p>
            <p>
              Free-form eligibility is checked against the selected sender’s
              customer-service window when you submit.
            </p>
            <label>
              Status
              <select
                disabled={!canOperate || pending}
                onChange={(event) =>
                  void change({ status: event.target.value })
                }
                value={conversation.status}
              >
                <option value="open">Open</option>
                <option value="pending">Pending</option>
                <option value="resolved">Resolved</option>
                <option value="closed">Closed</option>
              </select>
            </label>
            <label>
              Assigned operator
              <select
                disabled={!canOperate || pending}
                onChange={(event) =>
                  void change({ assignedUserId: event.target.value || null })
                }
                value={conversation.assignedUserId ?? ""}
              >
                <option value="">Unassigned</option>
                {teamMembers.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.email} · {member.role}
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
        aria-label={`Messages with ${conversation.contactName}`}
        aria-busy={loading}
      >
        {history ? (
          <div className="thread-notice">
            Viewing history · live updates paused{" "}
            <Button onClick={latest} variant="quiet">
              Back to latest
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
            <ArrowUp aria-hidden="true" size={14} /> Earlier messages
          </Button>
        ) : null}
        {loading ? (
          <p role="status" className="thread-notice">
            Loading conversation…
          </p>
        ) : null}
        {loadError ? (
          <div className="thread-notice" role="alert">
            <p>{loadError}</p>
            <Button onClick={latest} variant="secondary">
              Retry loading
            </Button>
          </div>
        ) : null}
        {!loading && !loadError && page.messages.length === 0 ? (
          <div className="thread-empty">
            <MessagesPlaceholder />
            <h3>A conversation starts here</h3>
            <p>Choose a delivery mode and write your first reply.</p>
          </div>
        ) : null}
        {page.messages.map((message) => (
          <article
            className={`message-bubble message-bubble--${message.direction}`}
            key={message.id}
            aria-label={`${message.direction} ${message.status}`}
          >
            {message.template ? (
              <div className="template-message">
                <strong>Template · {message.template.name}</strong>
                <small>Language: {message.template.language}</small>
                {message.template.parameters.length ? (
                  <ol>
                    {message.template.parameters.map((parameter, index) => (
                      <li key={index}>{parameter}</li>
                    ))}
                  </ol>
                ) : (
                  <p>No body parameters</p>
                )}
                <small>
                  Submitted template reference—not a synchronized approval
                  record.
                </small>
              </div>
            ) : (
              <p dir="auto">
                {message.contentText ?? `[${message.contentType}]`}
              </p>
            )}
            <footer>
              <time dateTime={message.createdAt}>
                {new Intl.DateTimeFormat("en", {
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: "Asia/Jerusalem",
                }).format(new Date(message.createdAt))}
              </time>
              <span>
                {message.direction === "outbound" ? message.status : "Received"}
              </span>
            </footer>
            {message.deliveryEvents.length ? (
              <details className="delivery-history">
                <summary>Delivery history</summary>
                <ul>
                  {message.deliveryEvents.map((event, index) => (
                    <li key={index}>
                      {event.status} ·{" "}
                      <time dateTime={event.occurredAt}>
                        {new Date(event.occurredAt).toISOString()}
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
                    aria-label="React with thumbs up"
                    disabled={pending}
                    onClick={() => void change({ emoji: "👍" }, message.id)}
                    type="button"
                  >
                    ＋👍
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
          <p className="thread-notice">
            Read-only access. A messaging operator can reply or change this
            conversation.
          </p>
        ) : (
          <>
            <div className="composer-controls">
              <label htmlFor="delivery-provider">
                Delivery mode
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
                  <option value="simulator">
                    Simulator — no external delivery
                  </option>
                  <option disabled={!realWhatsAppEnabled} value="meta">
                    REAL Meta WhatsApp delivery
                    {realWhatsAppEnabled ? "" : " — disabled"}
                  </option>
                </select>
              </label>
              <label htmlFor="message-kind">
                Message type
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
                  <option value="text">
                    Free-form text (24-hour window only)
                  </option>
                  <option value="template">Template reference</option>
                </select>
              </label>
            </div>
            {draft.provider === "meta" ? (
              <p className="sender-notice">
                Real sender · Phone Number ID{" "}
                <bdi>{metaSenderId ?? "not configured"}</bdi>. This identifies
                the configured sender, not a verified business number.
              </p>
            ) : (
              <p className="sender-notice">
                <ShieldCheck aria-hidden="true" size={13} /> Simulator only. No
                external message will be sent.
              </p>
            )}
            {draft.kind === "template" ? (
              <div className="template-fields">
                <Input
                  id="template-name"
                  label="Meta-approved template name"
                  required
                  disabled={pending}
                  value={draft.templateName}
                  onChange={(event) =>
                    updateDraft({ templateName: event.target.value })
                  }
                />
                <Input
                  id="template-language"
                  label="Exact language code"
                  placeholder="en_US or he"
                  required
                  disabled={pending}
                  value={draft.language}
                  onChange={(event) =>
                    updateDraft({ language: event.target.value })
                  }
                />
                <Input
                  id="template-parameters"
                  label="Body parameters, in order (separate with |)"
                  disabled={pending}
                  value={draft.parameters}
                  onChange={(event) =>
                    updateDraft({ parameters: event.target.value })
                  }
                />
                <p>
                  Use a template approved for this sender in Meta. Approval and
                  rendered wording are not synchronized here.
                </p>
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
                  Reply message
                </label>
                <textarea
                  id="reply-text"
                  dir="auto"
                  maxLength={4096}
                  disabled={pending}
                  onChange={(event) =>
                    updateDraft({ text: event.target.value })
                  }
                  placeholder="Write a thoughtful reply…"
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
                I understand this sends a real WhatsApp message to{" "}
                {conversation.contactName},{" "}
                <bdi>{conversation.recipientAddress}</bdi>.
              </label>
            ) : null}
            <div className="composer-footer">
              <small>
                {draft.kind === "text"
                  ? `${String(draft.text.length)} / 4096`
                  : "Template values are submitted exactly as entered"}
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
                  ? "Queuing…"
                  : draft.provider === "meta"
                    ? "Review real message"
                    : "Queue simulator reply"}
              </Button>
            </div>
          </>
        )}
      </form>
      <Dialog
        open={review !== undefined}
        onClose={() => {
          if (!pending) setReview(undefined);
        }}
        title="Confirm real WhatsApp delivery"
        description="A real message cannot be recalled. Check the sender, recipient and content before continuing."
      >
        <dl className="send-review">
          <dt>Recipient</dt>
          <dd>
            {conversation.contactName} ·{" "}
            <bdi>{conversation.recipientAddress}</bdi>
          </dd>
          <dt>Configured sender Phone Number ID</dt>
          <dd>
            <bdi>{metaSenderId ?? "Not configured"}</bdi>
          </dd>
          <dt>Message</dt>
          <dd dir="auto">
            {review?.kind === "text"
              ? review.text
              : `${review?.templateName ?? ""} · ${review?.language ?? ""}\n${review?.parameters ?? ""}`}
          </dd>
        </dl>
        <p>
          Consent, opt-out, customer-service window and provider safety checks
          still apply.
        </p>
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
          {pending ? "Queuing…" : "Send real WhatsApp"}
        </Button>
      </Dialog>
    </>
  );
}

function MessagesPlaceholder() {
  return (
    <span aria-hidden="true" className="contact-avatar">
      ↗
    </span>
  );
}
