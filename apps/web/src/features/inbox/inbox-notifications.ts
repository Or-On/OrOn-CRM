import type { ConversationSummary } from "@or-on/crm";

export interface InboundConversationAlert {
  readonly conversationId: string;
  readonly contactName: string;
  readonly newMessageCount: number;
  readonly notificationKey: string;
}

/**
 * Finds only unread growth observed after the caller's initial baseline.
 * Existing unread conversations therefore stay silent after login/reload.
 */
export function findInboundConversationAlerts(
  previous: readonly ConversationSummary[],
  next: readonly ConversationSummary[],
): readonly InboundConversationAlert[] {
  const earlier = new Map(previous.map((item) => [item.id, item]));
  return next.flatMap((conversation) => {
    const before = earlier.get(conversation.id);
    const previousUnread = before?.unreadCount ?? 0;
    if (conversation.unreadCount <= previousUnread) return [];
    return [
      {
        conversationId: conversation.id,
        contactName: conversation.contactName,
        newMessageCount: conversation.unreadCount - previousUnread,
        notificationKey: `${conversation.id}:${conversation.lastMessageAt ?? "unknown"}:${String(conversation.unreadCount)}`,
      },
    ];
  });
}
