export interface ContactIdentity {
  readonly id: string;
  readonly channel: "phone" | "whatsapp" | "email" | "sip" | "external";
  readonly normalizedValue: string | null;
  readonly displayValue: string | null;
  readonly validationStatus: "unverified" | "valid" | "invalid" | "revoked";
  readonly isPrimary: boolean;
}

export interface ContactSummary {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly company: string | null;
  readonly lifecycleStatus: "active" | "archived" | "blocked";
  readonly lastActivityAt: string | null;
  readonly createdAt: string;
  readonly identities: readonly ContactIdentity[];
  readonly tags: readonly Tag[];
}

export interface Tag {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

export interface ContactInput {
  readonly name: string;
  readonly phone?: string;
  readonly email?: string;
  readonly company?: string;
  readonly tagIds?: readonly string[];
}

export interface ConversationSummary {
  readonly id: string;
  readonly contactId: string;
  readonly contactName: string;
  readonly status: "open" | "pending" | "resolved" | "closed";
  readonly unreadCount: number;
  readonly lastMessageAt: string | null;
  readonly lastMessagePreview: string | null;
  readonly assignedUserId: string | null;
  readonly channelKind: string;
}

export interface Message {
  readonly id: string;
  readonly conversationId: string;
  readonly direction: "inbound" | "outbound" | "internal";
  readonly senderType: "contact" | "user" | "agent" | "system";
  readonly contentType: string;
  readonly contentText: string | null;
  readonly status: string;
  readonly providerMessageId: string | null;
  readonly createdAt: string;
}

export interface PipelineStage {
  readonly id: string;
  readonly pipelineId: string;
  readonly name: string;
  readonly position: number;
  readonly probability: number;
}

export interface Deal {
  readonly id: string;
  readonly pipelineId: string;
  readonly stageId: string;
  readonly contactId: string | null;
  readonly contactName: string | null;
  readonly title: string;
  readonly value: string;
  readonly currency: string;
  readonly status: "open" | "won" | "lost" | "archived";
  readonly updatedAt: string;
}

export interface PipelineBoard {
  readonly id: string;
  readonly name: string;
  readonly stages: readonly PipelineStage[];
  readonly deals: readonly Deal[];
}

export interface DashboardMetrics {
  readonly contacts: number;
  readonly openConversations: number;
  readonly unreadMessages: number;
  readonly openPipelineValue: string;
  readonly messagesToday: number;
}

export interface SimulatedInboundInput {
  readonly providerEventId: string;
  readonly providerMessageId: string;
  readonly from: string;
  readonly profileName: string;
  readonly text: string;
  readonly occurredAt?: Date;
}

export interface SimulatedOutboundInput {
  readonly conversationId: string;
  readonly senderUserId: string;
  readonly text: string;
  readonly idempotencyKey: string;
}
