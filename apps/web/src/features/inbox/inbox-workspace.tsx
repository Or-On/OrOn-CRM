"use client";

import { useTranslations, useLocale, useTimeZone } from "next-intl";
import Link from "next/link";

import {
  Archive,
  ChevronDown,
  Clock3,
  Inbox as InboxIcon,
  ListFilter,
  Mail,
  MessageCircle,
  PanelLeftClose,
  PanelLeftOpen,
  PhoneCall,
  RefreshCw,
  Search,
  UserRound,
  UsersRound,
  Workflow,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentProfileSummary,
  ConversationCursor,
  ConversationPage,
  ConversationSummary,
  Message,
  MessageCursor,
  QueuedWhatsAppOutbound,
  QuickReply,
  TeamMember,
} from "@or-on/crm";
import {
  Badge,
  EmptyState,
  IconButton,
  Popover,
  StatusIndicator,
  Surface,
} from "@or-on/ui";
import { crmMutation, crmRead } from "../crm";
import { IdentityImage } from "../identity";
import { ConversationThread } from "./conversation-thread";
import { emptyReply, ReplyIntentKeys, type ReplyDraft } from "./reply-intent";
import {
  conversationChannelKey,
  conversationDayKey,
  previousConversationDay,
} from "./conversation-presentation";
import { useInboxPanelFocus } from "./use-inbox-panel-focus";

type ConversationFilter =
  "all" | "mine" | "unassigned" | "unread" | "open" | "waiting" | "closed";

function isArray(value: unknown): boolean {
  return Array.isArray(value);
}

function matchesFilter(
  conversation: ConversationSummary,
  filter: ConversationFilter,
  currentUserId: string | undefined,
): boolean {
  switch (filter) {
    case "mine":
      return (
        currentUserId !== undefined &&
        conversation.assignedUserId === currentUserId
      );
    case "unassigned":
      return conversation.assignedUserId === null;
    case "unread":
      return conversation.unreadCount > 0;
    case "open":
      return conversation.status === "open";
    case "waiting":
      return conversation.status === "pending";
    case "closed":
      return (
        conversation.status === "closed" || conversation.status === "resolved"
      );
    case "all":
      return true;
  }
}

function filterFallback(filter: ConversationFilter, locale: string): string {
  const hebrew = locale.startsWith("he");
  const labels: Record<ConversationFilter, readonly [string, string]> = {
    all: ["All", "הכול"],
    mine: ["Mine", "שלי"],
    unassigned: ["Unassigned", "ללא שיוך"],
    unread: ["Unread", "לא נקראו"],
    open: ["Open", "פתוח"],
    waiting: ["Waiting", "ממתינות"],
    closed: ["Closed", "סגור"],
  };
  return labels[filter][hebrew ? 1 : 0];
}

function conversationTimestamp(
  value: string | null,
  locale: string,
  timeZone: string,
): string {
  if (value === null) return "";
  const message = new Date(value);
  const sameDay =
    conversationDayKey(message, timeZone) ===
    conversationDayKey(new Date(), timeZone);
  return new Intl.DateTimeFormat(
    locale,
    sameDay
      ? {
          hour: "2-digit",
          minute: "2-digit",
          timeZone,
        }
      : {
          day: "numeric",
          month: "short",
          timeZone,
        },
  ).format(message);
}

export function InboxWorkspace({
  conversations,
  initialMessages,
  initialConversationId,
  initialConversationNextCursor = null,
  initialNextCursor = null,
  quickReplies,
  realWhatsAppEnabled,
  metaSenderId,
  teamMembers,
  agentProfiles = [],
  aiRepliesEnabled = false,
  canOperate = false,
  currentUserId,
  initialSearch = "",
  initialFilter = "all",
}: {
  readonly conversations: readonly ConversationSummary[];
  readonly initialMessages: readonly Message[];
  readonly initialConversationId?: string | undefined;
  readonly initialConversationNextCursor?: ConversationCursor | null;
  readonly initialNextCursor?: MessageCursor | null;
  readonly quickReplies: readonly QuickReply[];
  readonly realWhatsAppEnabled: boolean;
  readonly metaSenderId?: string | undefined;
  readonly teamMembers: readonly TeamMember[];
  readonly agentProfiles?: readonly AgentProfileSummary[];
  readonly aiRepliesEnabled?: boolean;
  readonly canOperate?: boolean;
  /** Required for a truthful "Mine" filter; the filter is disabled when absent. */
  readonly currentUserId?: string | undefined;
  /** Allows route-level command/search links to initialize the navigator. */
  readonly initialSearch?: string | undefined;
  readonly initialFilter?: ConversationFilter | undefined;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone() ?? "UTC";
  const initialId = initialConversationId ?? conversations[0]?.id;
  const [items, setItems] = useState(conversations);
  const [conversationNextCursor, setConversationNextCursor] =
    useState<ConversationCursor | null>(initialConversationNextCursor);
  const [loadingMoreConversations, setLoadingMoreConversations] =
    useState(false);
  const [selectedId, setSelectedId] = useState(initialId);
  const [mobileThread, setMobileThread] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [channelsCollapsed, setChannelsCollapsed] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [compactChannels, setCompactChannels] = useState(false);
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<
    Readonly<Record<string, boolean>>
  >({});
  const [query, setQuery] = useState(initialSearch);
  const [searchInput, setSearchInput] = useState(initialSearch);
  const [filter, setFilter] = useState<ConversationFilter>(initialFilter);
  const [channelFilter, setChannelFilter] = useState<"all" | "whatsapp">("all");
  const [drafts, setDrafts] = useState<Readonly<Record<string, ReplyDraft>>>(
    {},
  );
  const [keys] = useState(() => new ReplyIntentKeys());
  const [listError, setListError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const selected = items.find((item) => item.id === selectedId);
  const alive = useRef(true);
  const refreshRevision = useRef(0);
  const loadedAdditionalConversationPages = useRef(false);
  const channelToggleRef = useRef<HTMLButtonElement>(null);
  const channelSidebarRef = useRef<HTMLElement>(null);
  const contactPanelRef = useRef<HTMLElement>(null);
  const contactTriggerRef = useRef<HTMLButtonElement>(null);
  const closeChannels = useCallback(() => setChannelsOpen(false), []);
  const closeContact = useCallback(() => setContextOpen(false), []);

  useInboxPanelFocus({
    open: compactChannels && channelsOpen,
    modal: true,
    panelRef: channelSidebarRef,
    triggerRef: channelToggleRef,
    onClose: closeChannels,
  });
  useInboxPanelFocus({
    open: contextOpen && selected !== undefined,
    modal: compactChannels,
    panelRef: contactPanelRef,
    triggerRef: contactTriggerRef,
    onClose: closeContact,
  });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      refreshRevision.current += 1;
    };
  }, []);
  // Route/tenant refreshes establish a baseline without notifying for messages
  // that were already unread when the page rendered.
  useEffect(() => {
    setItems(conversations);
    setConversationNextCursor(initialConversationNextCursor);
    loadedAdditionalConversationPages.current = false;
  }, [conversations, initialConversationNextCursor]);
  useEffect(() => {
    setQuery(initialSearch);
    setSearchInput(initialSearch);
  }, [initialSearch]);
  useEffect(() => setFilter(initialFilter), [initialFilter]);
  useEffect(() => {
    if (selected === undefined || selected.unreadCount === 0) return;
    const controller = new AbortController();
    void crmMutation(
      `/api/messaging/conversations/${encodeURIComponent(selected.id)}`,
      { read: true },
      { method: "PATCH", signal: controller.signal },
    )
      .then(() => {
        if (!alive.current) return;
        setItems((current) =>
          current.map((item) =>
            item.id === selected.id ? { ...item, unreadCount: 0 } : item,
          ),
        );
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [selected]);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 69.999rem)");
    const synchronize = () => {
      setCompactChannels(media.matches);
      if (!media.matches) setChannelsOpen(false);
    };
    synchronize();
    media.addEventListener("change", synchronize);
    return () => media.removeEventListener("change", synchronize);
  }, []);

  function replaceInboxParam(name: string, value?: string) {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (!url.pathname.endsWith("/inbox")) return;
    if (value) url.searchParams.set(name, value);
    else url.searchParams.delete(name);
    window.history.replaceState(window.history.state, "", url);
  }

  function selectFilter(next: ConversationFilter) {
    setFilter(next);
    setChannelFilter("all");
    replaceInboxParam("filter", next === "all" ? undefined : next);
    void refreshItems(selectedId, { filter: next, channelFilter: "all" }).catch(
      () => {
        if (alive.current) setListError(t("inbox.refreshFailed"));
      },
    );
  }

  function selectConversation(id: string) {
    setSelectedId(id);
    replaceInboxParam("conversation", id);
  }

  const refreshItems = useCallback(
    async (
      ensureId?: string,
      override: {
        readonly filter?: ConversationFilter;
        readonly channelFilter?: "all" | "whatsapp";
        readonly query?: string;
        readonly preserveLoaded?: boolean;
      } = {},
    ) => {
      const revision = ++refreshRevision.current;
      const parameters = new URLSearchParams();
      const requestedFilter = override.filter ?? filter;
      const requestedChannel = override.channelFilter ?? channelFilter;
      const requestedQuery = override.query ?? query;
      if (requestedQuery.trim()) parameters.set("q", requestedQuery.trim());
      if (requestedFilter !== "all") parameters.set("filter", requestedFilter);
      if (requestedChannel !== "all")
        parameters.set("channel", requestedChannel);
      const result = await crmRead<ConversationPage>(
        `/api/messaging/conversations${parameters.size ? `?${parameters}` : ""}`,
      );
      if (!isArray(result.conversations))
        throw new Error(t("inbox.listInvalid"));
      let next = [...result.conversations];
      if (ensureId && !next.some((item) => item.id === ensureId)) {
        const specific = await crmRead<{
          conversations: ConversationSummary[];
        }>(`/api/messaging/conversations?id=${encodeURIComponent(ensureId)}`);
        next = [...specific.conversations, ...next];
      }
      if (alive.current && revision === refreshRevision.current) {
        if (
          override.preserveLoaded === true &&
          loadedAdditionalConversationPages.current
        ) {
          setItems((current) => [
            ...next,
            ...current.filter(
              (item) => !next.some((refreshed) => refreshed.id === item.id),
            ),
          ]);
        } else {
          setItems(next);
          setConversationNextCursor(result.nextCursor ?? null);
          loadedAdditionalConversationPages.current = false;
        }
        setListError(undefined);
      }
      return next;
    },
    [channelFilter, filter, query, t],
  );

  async function loadMoreConversations() {
    const before = conversationNextCursor;
    if (before === null || loadingMoreConversations) return;
    const revision = refreshRevision.current;
    setLoadingMoreConversations(true);
    setListError(undefined);
    const parameters = new URLSearchParams();
    if (query.trim()) parameters.set("q", query.trim());
    if (filter !== "all") parameters.set("filter", filter);
    if (channelFilter !== "all") parameters.set("channel", channelFilter);
    if (before.lastMessageAt !== null)
      parameters.set("before", before.lastMessageAt);
    parameters.set("beforeId", before.id);
    try {
      const result = await crmRead<ConversationPage>(
        `/api/messaging/conversations?${parameters}`,
      );
      if (!isArray(result.conversations))
        throw new Error(t("inbox.listInvalid"));
      if (!alive.current || revision !== refreshRevision.current) return;
      setItems((current) => [
        ...current,
        ...result.conversations.filter(
          (item) => !current.some((existing) => existing.id === item.id),
        ),
      ]);
      setConversationNextCursor(result.nextCursor ?? null);
      loadedAdditionalConversationPages.current = true;
    } catch {
      if (alive.current) setListError(t("inbox.refreshFailed"));
    } finally {
      if (alive.current) setLoadingMoreConversations(false);
    }
  }

  function applySearch(value: string) {
    const next = value.trim().slice(0, 120);
    setSearchInput(next);
    setQuery(next);
    replaceInboxParam("search", next || undefined);
    void refreshItems(selectedId, { query: next }).catch(() => {
      if (alive.current) setListError(t("inbox.refreshFailed"));
    });
  }

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refreshItems(selectedId, { preserveLoaded: true });
      } catch {
        // Background refresh remains quiet; manual refresh reports errors.
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), 5000);
      }
    };
    timer = setTimeout(() => void poll(), 5000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refreshItems, selectedId]);

  async function conversationDeleted(
    conversationId: string,
    retainedAsEvidence: boolean,
  ) {
    const remaining = items.filter((item) => item.id !== conversationId);
    const replacementId = remaining[0]?.id;
    setItems(remaining);
    setSelectedId(replacementId);
    setContextOpen(false);
    setMobileThread(false);
    setDrafts((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([id]) => id !== conversationId),
      ),
    );
    replaceInboxParam("conversation", replacementId);
    setNotice(
      t(retainedAsEvidence ? "inbox.removedRetainedEvidence" : "inbox.deleted"),
    );
    try {
      await refreshItems();
    } catch {
      if (alive.current) setListError(t("inbox.deletedRefresh"));
    }
  }

  async function queued(result: QueuedWhatsAppOutbound, originId: string) {
    setNotice(result.queued ? t("inbox.queued") : t("inbox.duplicate"));
    // Queue success must not become a send failure just because refresh failed.
    try {
      await refreshItems(result.conversationId);
      if (alive.current)
        setSelectedId((current) => {
          if (current !== originId) return current;
          replaceInboxParam("conversation", result.conversationId);
          return result.conversationId;
        });
    } catch {
      if (alive.current) setListError(t("inbox.queuedRefresh"));
    }
  }

  const normalizedQuery = query.toLocaleLowerCase().trim();
  const filtered = useMemo(
    () =>
      items.filter(
        (item) =>
          (channelFilter === "all" || item.channelKind === channelFilter) &&
          matchesFilter(item, filter, currentUserId) &&
          `${item.contactName} ${item.recipientAddress ?? ""} ${item.senderAddress ?? ""} ${item.provider} ${item.lastMessagePreview ?? ""}`
            .toLocaleLowerCase()
            .includes(normalizedQuery),
      ),
    [channelFilter, currentUserId, filter, items, normalizedQuery],
  );
  const filters = useMemo(
    () =>
      (
        [
          "all",
          "mine",
          "unassigned",
          "unread",
          "open",
          "waiting",
          "closed",
        ] as const
      ).map((id) => ({
        id,
        count: items.filter((item) => matchesFilter(item, id, currentUserId))
          .length,
        disabled: id === "mine" && currentUserId === undefined,
      })),
    [currentUserId, items],
  );
  const assignedMember = teamMembers.find(
    (member) => member.userId === selected?.assignedUserId,
  );
  const currentMember = teamMembers.find(
    (member) => member.userId === currentUserId,
  );
  const now = new Date();
  const todayKey = conversationDayKey(now, timeZone);
  const yesterdayKey = previousConversationDay(todayKey);
  const groupFor = (conversation: ConversationSummary) => {
    if (conversation.lastMessageAt === null) return "earlier";
    const key = conversationDayKey(
      new Date(conversation.lastMessageAt),
      timeZone,
    );
    if (key === todayKey) return "today";
    if (key === yesterdayKey) return "yesterday";
    return "earlier";
  };
  const conversationGroups = [
    {
      id: "today",
      label: t("inbox.groups.today"),
      items: filtered.filter((item) => groupFor(item) === "today"),
    },
    {
      id: "yesterday",
      label: t("inbox.groups.yesterday"),
      items: filtered.filter((item) => groupFor(item) === "yesterday"),
    },
    {
      id: "earlier",
      label: t("inbox.groups.earlier"),
      items: filtered.filter((item) => groupFor(item) === "earlier"),
    },
  ].filter((group) => group.items.length > 0);

  function conversationRow(conversation: ConversationSummary) {
    return (
      <button
        className={`conversation-row ${selectedId === conversation.id ? "conversation-row--active" : ""}`}
        aria-current={selectedId === conversation.id ? "true" : undefined}
        key={conversation.id}
        onClick={() => {
          selectConversation(conversation.id);
          setMobileThread(true);
          setNotice(undefined);
        }}
        type="button"
      >
        <span className="contact-avatar" aria-hidden="true">
          {conversation.contactName.slice(0, 1)}
        </span>
        <span className="conversation-row__copy">
          <span className="conversation-row__title">
            <strong>
              <bdi>{conversation.contactName}</bdi>
            </strong>
            {conversation.lastMessageAt ? (
              <time dateTime={conversation.lastMessageAt}>
                {conversationTimestamp(
                  conversation.lastMessageAt,
                  locale,
                  timeZone,
                )}
              </time>
            ) : null}
          </span>
          <span className="conversation-row__metadata">
            <span className="conversation-row__channel">
              <MessageCircle aria-hidden="true" size={12} />
              <bdi>
                {conversation.recipientAddress ??
                  t(conversationChannelKey(conversation.channelKind))}
              </bdi>
            </span>
            <StatusIndicator
              label={
                t.has(`status.${conversation.status}`)
                  ? t(`status.${conversation.status}`)
                  : t("common.unknown")
              }
              tone={
                conversation.status === "open"
                  ? "positive"
                  : conversation.status === "pending"
                    ? "warning"
                    : "neutral"
              }
            />
            <span
              className="conversation-row__assignment"
              title={t("inbox.assigned")}
            >
              <UserRound aria-hidden="true" size={11} />
              <bdi>
                {conversation.assignedUserId === null
                  ? t("inbox.unassigned")
                  : (teamMembers.find(
                      (member) => member.userId === conversation.assignedUserId,
                    )?.displayName ??
                    teamMembers.find(
                      (member) => member.userId === conversation.assignedUserId,
                    )?.email ??
                    t("common.unknown"))}
              </bdi>
            </span>
          </span>
          <small dir="auto">
            {conversation.lastMessagePreview ?? t("common.noText")}
          </small>
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
    );
  }

  function toggleChannels() {
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 69.999rem)").matches
    ) {
      setChannelsOpen((current) => !current);
      return;
    }
    setChannelsCollapsed((current) => !current);
  }

  const channelsVisible = compactChannels ? channelsOpen : !channelsCollapsed;

  return (
    <div
      className={`inbox-layout inbox-workspace ${mobileThread ? "inbox-layout--thread" : ""} ${contextOpen ? "inbox-workspace--context" : ""} ${channelsCollapsed ? "inbox-workspace--channels-collapsed" : ""} ${channelsOpen ? "inbox-workspace--channels-open" : ""}`}
      data-mobile-view={mobileThread ? "thread" : "navigator"}
    >
      <aside
        aria-hidden={
          !(compactChannels ? channelsOpen : !channelsCollapsed)
            ? true
            : undefined
        }
        aria-label={t("inbox.workspaceNavigation")}
        aria-modal={compactChannels && channelsOpen ? true : undefined}
        className="inbox-channel-sidebar"
        id="inbox-channel-navigation"
        inert={
          !(compactChannels ? channelsOpen : !channelsCollapsed)
            ? true
            : undefined
        }
        ref={channelSidebarRef}
        role={compactChannels ? "dialog" : undefined}
        tabIndex={-1}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("a"))
            closeChannels();
        }}
      >
        <div className="inbox-channel-sidebar__inner">
          <div className="inbox-channel-sidebar__mobile-heading">
            <strong>{t("shell.inbox")}</strong>
            <IconButton label={t("shell.closeNav")} onClick={closeChannels}>
              <X aria-hidden="true" size={16} />
            </IconButton>
          </div>
          <nav aria-label={t("inbox.workspaceNavigation")}>
            {[
              {
                id: "all" as const,
                label: t("shell.inbox"),
                Icon: InboxIcon,
              },
              {
                id: "unread" as const,
                label: filterFallback("unread", locale),
                Icon: MessageCircle,
              },
              {
                id: "waiting" as const,
                label: filterFallback("waiting", locale),
                Icon: Clock3,
              },
              {
                id: "closed" as const,
                label: filterFallback("closed", locale),
                Icon: Archive,
              },
              {
                id: "unassigned" as const,
                label: filterFallback("unassigned", locale),
                Icon: UserRound,
              },
            ].map((item) => {
              const count =
                filters.find((option) => option.id === item.id)?.count ?? 0;
              return (
                <button
                  aria-label={`${t("inbox.filters.label")}: ${item.label} (${count.toLocaleString(locale)})`}
                  aria-current={
                    channelFilter === "all" && filter === item.id
                      ? "page"
                      : undefined
                  }
                  aria-pressed={channelFilter === "all" && filter === item.id}
                  key={item.id}
                  onClick={() => {
                    selectFilter(item.id);
                    setChannelsOpen(false);
                  }}
                  type="button"
                >
                  <item.Icon aria-hidden="true" size={14} />
                  <span>{item.label}</span>
                  <small>{count.toLocaleString(locale)}</small>
                </button>
              );
            })}
            <p>{t("inbox.channels")}</p>
            <Link href="/email">
              <Mail aria-hidden="true" size={14} />
              <span>{t("shell.email")}</span>
            </Link>
            <button
              aria-pressed={channelFilter === "whatsapp"}
              onClick={() => {
                setFilter("all");
                setChannelFilter("whatsapp");
                replaceInboxParam("filter", undefined);
                setChannelsOpen(false);
                void refreshItems(selectedId, {
                  filter: "all",
                  channelFilter: "whatsapp",
                }).catch(() => {
                  if (alive.current) setListError(t("inbox.refreshFailed"));
                });
              }}
              type="button"
            >
              <MessageCircle aria-hidden="true" size={14} />
              <span>{t("inbox.whatsapp")}</span>
              <small>
                {items
                  .filter((item) => item.channelKind === "whatsapp")
                  .length.toLocaleString(locale)}
              </small>
            </button>
            <Link href="/voice">
              <PhoneCall aria-hidden="true" size={14} />
              <span>{t("shell.voice")}</span>
            </Link>
            <p>{t("inbox.views")}</p>
            <Link href="/contacts">
              <UsersRound aria-hidden="true" size={14} />
              <span>{t("shell.contacts")}</span>
            </Link>
            <Link href="/orchestration?tab=handoffs">
              <Workflow aria-hidden="true" size={14} />
              <span>{t("orchestration.handoffs")}</span>
            </Link>
          </nav>
          <Link className="inbox-channel-profile" href="/profile">
            <IdentityImage
              className="inbox-channel-profile__avatar"
              fallback={(
                currentMember?.displayName ??
                currentMember?.email ??
                "O"
              )
                .slice(0, 2)
                .toLocaleUpperCase(locale)}
              source="/api/account/avatar"
            />
            <span>
              <strong>
                {currentMember?.displayName ??
                  currentMember?.email ??
                  t("shell.account")}
              </strong>
              <small>{currentMember?.email ?? t("shell.profile")}</small>
            </span>
          </Link>
        </div>
      </aside>
      <button
        aria-hidden={!channelsOpen}
        aria-label={t("shell.closeNav")}
        className="inbox-channel-scrim"
        data-inbox-overlay-dismiss="channels"
        onClick={closeChannels}
        tabIndex={-1}
        type="button"
      />
      <Surface
        aria-label={t("inbox.conversations")}
        as="section"
        className="inbox-list inbox-navigator"
      >
        <div className="inbox-list__heading">
          <IconButton
            aria-controls="inbox-channel-navigation"
            aria-expanded={channelsVisible}
            className="inbox-channel-toggle"
            label={channelsVisible ? t("shell.closeNav") : t("shell.openNav")}
            onClick={toggleChannels}
            ref={channelToggleRef}
          >
            {channelsVisible ? (
              <PanelLeftClose aria-hidden="true" size={16} />
            ) : (
              <PanelLeftOpen aria-hidden="true" size={16} />
            )}
          </IconButton>
          <div className="inbox-list__title">
            <h2>{t("shell.inbox")}</h2>
          </div>
          <div className="inbox-list__actions">
            <Popover
              align="end"
              contentClassName="inbox-filter-menu"
              label={t("inbox.filters.label")}
              onOpenChange={setAdvancedFiltersOpen}
              open={advancedFiltersOpen}
              role="menu"
              trigger={<ListFilter aria-hidden="true" size={16} />}
              triggerClassName="inbox-filter-trigger"
            >
              {({ close }) => (
                <>
                  {filters
                    .filter((option) =>
                      ["mine", "unassigned", "unread"].includes(option.id),
                    )
                    .map((option) => {
                      const key = `inbox.filters.${option.id}`;
                      const label = t.has(key)
                        ? t(key)
                        : filterFallback(option.id, locale);
                      return (
                        <button
                          aria-checked={
                            channelFilter === "all" && filter === option.id
                          }
                          disabled={option.disabled}
                          key={option.id}
                          onClick={() => {
                            selectFilter(option.id);
                            close();
                          }}
                          role="menuitemcheckbox"
                          type="button"
                        >
                          <span>{label}</span>
                          <small>{option.count.toLocaleString(locale)}</small>
                        </button>
                      );
                    })}
                  <button
                    onClick={() => {
                      close();
                      void refreshItems(selectedId).catch(() =>
                        setListError(t("inbox.refreshFailed")),
                      );
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <RefreshCw aria-hidden="true" size={14} />
                    <span>{t("inbox.refresh")}</span>
                  </button>
                </>
              )}
            </Popover>
          </div>
        </div>
        <form
          className="inbox-search"
          onSubmit={(event) => {
            event.preventDefault();
            applySearch(searchInput);
          }}
          role="search"
        >
          <Search aria-hidden="true" size={15} />
          <input
            aria-label={t("inbox.search")}
            maxLength={120}
            onChange={(event) => setSearchInput(event.currentTarget.value)}
            placeholder={t("inbox.searchHint")}
            type="search"
            value={searchInput}
          />
          {searchInput ? (
            <button
              aria-label={t("inbox.clearSearch")}
              className="inbox-search__clear"
              onClick={() => applySearch("")}
              type="button"
            >
              <X aria-hidden="true" size={14} />
            </button>
          ) : null}
          <button className="sr-only" type="submit">
            {t("inbox.search")}
          </button>
        </form>
        <div
          aria-label={
            t.has("inbox.filters.label")
              ? t("inbox.filters.label")
              : t("inbox.conversations")
          }
          className="inbox-filters"
          role="group"
        >
          {filters.map((option) => {
            const advanced = ["mine", "unassigned", "unread"].includes(
              option.id,
            );
            const key = `inbox.filters.${option.id}`;
            const label = t.has(key)
              ? t(key)
              : filterFallback(option.id, locale);
            return (
              <button
                aria-pressed={channelFilter === "all" && filter === option.id}
                className={`inbox-filter ${advanced ? "inbox-filter--advanced" : ""} ${advancedFiltersOpen ? "inbox-filter--advanced-open" : ""} ${channelFilter === "all" && filter === option.id ? "inbox-filter--active" : ""}`}
                disabled={option.disabled}
                key={option.id}
                onClick={() => selectFilter(option.id)}
                title={
                  option.disabled
                    ? t.has("inbox.filters.mineUnavailable")
                      ? t("inbox.filters.mineUnavailable")
                      : locale.startsWith("he")
                        ? "זהות המפעיל נדרשת למסנן זה"
                        : "Your operator identity is required for this filter"
                    : undefined
                }
                type="button"
              >
                <span>{label}</span>
                <small>{option.count.toLocaleString(locale)}</small>
              </button>
            );
          })}
        </div>
        {listError ? (
          <p className="form-error" role="alert">
            {listError}
          </p>
        ) : null}
        <nav
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
            conversationGroups.map((group) => (
              <section className="conversation-group" key={group.id}>
                <button
                  aria-expanded={!collapsedGroups[group.id]}
                  className="conversation-group__heading"
                  onClick={() =>
                    setCollapsedGroups((current) => ({
                      ...current,
                      [group.id]: !current[group.id],
                    }))
                  }
                  type="button"
                >
                  <span>{group.label}</span>
                  <small>{group.items.length.toLocaleString(locale)}</small>
                  <ChevronDown aria-hidden="true" size={13} />
                </button>
                {collapsedGroups[group.id] ? null : (
                  <div className="conversation-group__rows">
                    {group.items.map(conversationRow)}
                  </div>
                )}
              </section>
            ))
          )}
        </nav>
        <div className="inbox-list__footer">
          <small>{t("inbox.loaded", { count: items.length })}</small>
          {conversationNextCursor ? (
            <button
              disabled={loadingMoreConversations}
              onClick={() => void loadMoreConversations()}
              type="button"
            >
              {loadingMoreConversations
                ? t("inbox.loadingMore")
                : t("inbox.loadMore")}
            </button>
          ) : null}
        </div>
      </Surface>
      <Surface
        aria-label={
          selected === undefined
            ? t("inbox.context")
            : t("inbox.threadLabel", { contact: selected.contactName })
        }
        as="section"
        className="message-panel inbox-conversation"
        level="raised"
      >
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
            agentProfiles={agentProfiles}
            aiRepliesEnabled={aiRepliesEnabled}
            mobileThreadOpen={mobileThread}
            onBack={() => setMobileThread(false)}
            onShowContact={(trigger) => {
              contactTriggerRef.current = trigger;
              setContextOpen(true);
            }}
            onQueued={(result) => queued(result, selected.id)}
            onChanged={async () => {
              await refreshItems(selected.id);
            }}
            onDeleted={conversationDeleted}
          />
        )}
      </Surface>
      {selected === undefined ? null : (
        <aside
          aria-hidden={!contextOpen}
          aria-label={t("common.details")}
          aria-modal={compactChannels && contextOpen ? true : undefined}
          className="inbox-context-pane"
          inert={!contextOpen}
          ref={contactPanelRef}
          role={compactChannels ? "dialog" : undefined}
          tabIndex={-1}
        >
          <div className="inbox-context-pane__inner">
            <header className="inbox-context-profile-header">
              <span className="contact-avatar" aria-hidden="true">
                {selected.contactName.slice(0, 1)}
              </span>
              <div>
                <strong>
                  <bdi>{selected.contactName}</bdi>
                </strong>
                <span>
                  <bdi>
                    {selected.recipientAddress ?? t("inbox.noRecipient")}
                  </bdi>
                </span>
              </div>
              <IconButton label={t("common.close")} onClick={closeContact}>
                <X aria-hidden="true" size={16} />
              </IconButton>
            </header>
            <Link
              className="or-button or-button--secondary or-button--medium inbox-context__contact-link"
              href={`/contacts/${selected.contactId}`}
            >
              <UserRound aria-hidden="true" size={14} />
              {t("contacts.open")}
            </Link>
            <div className="inbox-context-tabs" role="presentation">
              <span aria-current="page">{t("common.details")}</span>
            </div>
            <details className="inbox-context" open>
              <summary className="or-visually-hidden">
                {t("common.details")}
              </summary>
              <div className="inbox-context__content">
                <dl className="inbox-context__facts">
                  <div>
                    <dt>{t("inbox.status")}</dt>
                    <dd>
                      <Badge
                        label={
                          t.has(`status.${selected.status}`)
                            ? t(`status.${selected.status}`)
                            : t("common.unknown")
                        }
                        tone={
                          selected.status === "open" ? "positive" : "neutral"
                        }
                      />
                    </dd>
                  </div>
                  <div>
                    <dt>{t("inbox.currentChannel")}</dt>
                    <dd>
                      <bdi>
                        {t(conversationChannelKey(selected.channelKind))}
                      </bdi>
                    </dd>
                  </div>
                  <div>
                    <dt>{t("inbox.assigned")}</dt>
                    <dd>
                      <bdi>
                        {assignedMember?.email ?? t("inbox.unassigned")}
                      </bdi>
                    </dd>
                  </div>
                </dl>
                <p className="inbox-context__eligibility">
                  {t("inbox.text")}
                  {selected.customerServiceWindowExpiresAt ? (
                    <time dateTime={selected.customerServiceWindowExpiresAt}>
                      {conversationTimestamp(
                        selected.customerServiceWindowExpiresAt,
                        locale,
                        timeZone,
                      )}
                    </time>
                  ) : null}
                </p>
              </div>
            </details>
          </div>
        </aside>
      )}
      {notice ? (
        <div className="inbox-notice" role="status">
          {notice}
        </div>
      ) : null}
    </div>
  );
}
