import type { MessageDeliveryFailure } from "./whatsapp-diagnostics.js";

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
  readonly voiceConsent: "unknown" | "granted" | "revoked";
  readonly whatsAppConsent: "unknown" | "granted" | "revoked";
  readonly whatsAppOptedOutAt: string | null;
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

export interface ContactNote {
  readonly id: string;
  readonly authorUserId: string | null;
  readonly body: string;
  readonly createdAt: string;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface ContactCustomField {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly fieldType:
    "text" | "number" | "date" | "boolean" | "select" | "multi_select";
  readonly value: JsonValue | null;
}

export interface ContactDetail extends ContactSummary {
  readonly notes: readonly ContactNote[];
  readonly customFields: readonly ContactCustomField[];
}

export interface ContactImportRow {
  readonly name: string;
  readonly phone?: string;
  readonly email?: string;
  readonly company?: string;
}

export interface ContactImportResult {
  readonly created: number;
  readonly skipped: number;
  readonly errors: readonly { readonly row: number; readonly reason: string }[];
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
  readonly provider: string;
  readonly senderAddress: string | null;
  readonly providerAccountId: string | null;
  readonly recipientAddress: string | null;
  readonly whatsAppConsent: string;
  readonly whatsAppOptedOutAt: string | null;
  readonly customerServiceWindowExpiresAt: string | null;
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
  readonly reactions: readonly string[];
  readonly deliveryEvents: readonly MessageDeliveryEvent[];
  readonly deliveryFailure?: MessageDeliveryFailure | null;
  readonly template?: TemplateSummary | null;
  readonly historyCursor?: MessageCursor;
}

export interface TemplateSummary {
  readonly name: string;
  readonly language: string;
  readonly parameters: readonly string[];
}

export interface MessageCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface MessagePage {
  readonly messages: readonly Message[];
  readonly nextCursor: MessageCursor | null;
}

export interface MessageDeliveryEvent {
  readonly status: string;
  readonly occurredAt: string;
}

export interface TeamMember {
  readonly userId: string;
  readonly email: string;
  readonly role: "owner" | "admin" | "agent" | "viewer";
}

export interface TenantSettings {
  readonly displayName: string | null;
  readonly defaultCurrency: string;
  readonly locale: string;
  readonly timezone: string;
}

export interface NotificationSummary {
  readonly id: string;
  readonly title: string;
  readonly body: string | null;
  readonly read: boolean;
  readonly createdAt: string;
}

export interface QuickReply {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly shortcut: string | null;
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

export interface BroadcastSummary {
  readonly id: string;
  readonly name: string;
  readonly status:
    | "draft"
    | "scheduled"
    | "sending"
    | "paused"
    | "sent"
    | "failed"
    | "cancelled";
  readonly totalRecipients: number;
  readonly deliveredCount: number;
  readonly failedCount: number;
  readonly createdAt: string;
}

export interface AutomationSummary {
  readonly executionKind?: "empty" | "canonical" | "unsupported";
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly version: number;
  readonly published: boolean;
  readonly validationStatus: "pending" | "valid" | "invalid";
  readonly createdAt: string;
}

export interface AutomationRunSummary {
  readonly id: string;
  readonly definitionId: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
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
