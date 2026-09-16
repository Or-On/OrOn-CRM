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
  /** Tenant-managed customer-file classifications, when that projection is loaded. */
  readonly classifications?: readonly ContactClassificationSummary[];
}

export interface ContactClassificationSummary {
  readonly id: string;
  readonly name: string;
  readonly color: string;
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
  readonly ownershipMode?: "ai" | "human";
  readonly aiAgentProfileVersionId?: string | null;
  readonly aiEnabledAt?: string | null;
  readonly handoffReasonSafe?: string | null;
  readonly channelKind: string;
  readonly provider: string;
  readonly senderAddress: string | null;
  readonly providerAccountId: string | null;
  readonly recipientAddress: string | null;
  readonly whatsAppConsent: string;
  readonly whatsAppOptedOutAt: string | null;
  readonly customerServiceWindowExpiresAt: string | null;
}

export type ConversationFilter =
  "all" | "mine" | "unassigned" | "unread" | "open" | "waiting" | "closed";

export interface ConversationCursor {
  readonly lastMessageAt: string | null;
  readonly id: string;
}

export interface ConversationPage {
  readonly conversations: readonly ConversationSummary[];
  readonly nextCursor: ConversationCursor | null;
}

export interface MessageMedia {
  readonly kind: "image" | "document";
  readonly status:
    "pending" | "processing" | "available" | "failed" | "unavailable";
  readonly mimeType: string | null;
  readonly fileName: string | null;
  readonly caption: string | null;
}

export interface MessageLocation {
  readonly latitude: number;
  readonly longitude: number;
  readonly name: string | null;
  readonly address: string | null;
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
  /** Sanitized customer-media metadata. Provider identifiers never leave CRM. */
  readonly media?: MessageMedia | null;
  readonly location?: MessageLocation | null;
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
  readonly displayName: string | null;
  readonly role: "owner" | "admin" | "agent" | "technician" | "viewer";
}

export interface TenantInvitationSummary {
  readonly id: string;
  readonly email: string;
  readonly role: "admin" | "agent" | "technician" | "viewer";
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface TenantSettings {
  readonly displayName: string | null;
  readonly defaultCurrency: string;
  readonly locale: string;
  readonly timezone: string;
  readonly businessName?: string | null;
  readonly businessEmail?: string | null;
  readonly businessPhone?: string | null;
  readonly businessAddress?: string | null;
  readonly accentToken?:
    "blue" | "cyan" | "emerald" | "violet" | "amber" | "rose" | null;
  readonly reportHeader?: string | null;
  readonly reportFooter?: string | null;
  readonly supportProfile?: TenantSupportProfile;
  readonly identityVerification?: IdentityVerificationPolicy;
}

export interface TenantTerminologyEntry {
  readonly term: string;
  readonly preferredTerm?: string;
  readonly pronunciation?: string;
  readonly language?: string;
}

export interface TenantSupportProfile {
  readonly schemaVersion: "1.0";
  readonly displayName?: string;
  readonly supportDisplayName?: string;
  readonly legalName?: string;
  readonly businessDescription?: string;
  readonly productsAndServices?: readonly string[];
  readonly authorizedAffiliations?: readonly string[];
  readonly primaryLanguage?: string;
  readonly supportedLanguages?: readonly string[];
  readonly timezone?: string;
  readonly businessHours?: Readonly<Record<string, JsonValue>>;
  readonly terminology?: readonly TenantTerminologyEntry[];
}

export interface IdentityVerificationPolicy {
  readonly schemaVersion: "1.0";
  readonly enabled: boolean;
  readonly requiredFactors: readonly (
    "fullName" | "phone" | "nationalId" | "customerNumber"
  )[];
  readonly maxAttempts: number;
  readonly onFailure: "human_handoff" | "end_call";
  readonly contextDisclosure: "after_verification";
}

export interface StoredIdentityImage {
  readonly data: Uint8Array;
  readonly contentType: "image/jpeg" | "image/png" | "image/webp";
  readonly updatedAt: string;
}

export interface NotificationSummary {
  readonly id: string;
  readonly title: string;
  readonly body: string | null;
  readonly read: boolean;
  readonly createdAt: string;
  readonly referenceType?: string | null;
  readonly referenceId?: string | null;
  readonly type?: string;
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
  readonly openPipelineValues: readonly {
    readonly currency: string;
    readonly value: string;
  }[];
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
  readonly definition?: JsonValue;
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

export type ExpenseStatus = "pending" | "recorded" | "void";

export interface Expense {
  readonly id: string;
  readonly createdByUserId: string | null;
  readonly title: string;
  readonly vendor: string | null;
  readonly category: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: ExpenseStatus;
  readonly sourceKind: "manual" | "provider_invoice";
  readonly sourceReference: string | null;
  readonly notes: string | null;
  readonly incurredAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExpenseInput {
  readonly title: string;
  readonly vendor?: string | null;
  readonly category: string;
  /** A base-10 decimal string. JavaScript numbers are intentionally rejected. */
  readonly amount: string;
  readonly currency: string;
  readonly status?: Exclude<ExpenseStatus, "void">;
  readonly notes?: string | null;
  readonly incurredAt: string;
}

export interface ExpenseCurrencySummary {
  readonly currency: string;
  readonly recordedTotal: string;
  readonly pendingTotal: string;
  readonly recordedCount: number;
  readonly pendingCount: number;
}

export interface ExpenseSummary {
  readonly totals: readonly ExpenseCurrencySummary[];
  readonly expenseCount: number;
  readonly recordedCount: number;
  readonly pendingCount: number;
  readonly voidCount: number;
}

export interface ExpenseCursor {
  readonly incurredAt: string;
  readonly id: string;
}

export interface ExpensePage {
  readonly expenses: readonly Expense[];
  readonly nextCursor: ExpenseCursor | null;
}

export type TaskStatus = "todo" | "in_progress" | "completed" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "urgent";

export interface Task {
  readonly id: string;
  readonly createdByUserId: string | null;
  readonly assigneeUserId: string | null;
  readonly contactId: string | null;
  readonly contactName: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly dueAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskInput {
  readonly title: string;
  readonly description?: string | null;
  readonly status?: Exclude<TaskStatus, "cancelled">;
  readonly priority?: TaskPriority;
  readonly assigneeUserId?: string | null;
  readonly dueAt?: string | null;
}

export type CalendarEventStatus = "confirmed" | "tentative" | "cancelled";

export interface CalendarEvent {
  readonly id: string;
  readonly createdByUserId: string | null;
  readonly organizerUserId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly location: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
  readonly timezone: string;
  readonly status: CalendarEventStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CalendarEventInput {
  readonly title: string;
  readonly description?: string | null;
  readonly location?: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay?: boolean;
  readonly timezone: string;
  readonly status?: Exclude<CalendarEventStatus, "cancelled">;
  readonly organizerUserId?: string | null;
}

export interface CalendarEventCursor {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly id: string;
}

export interface CalendarEventPage {
  readonly events: readonly CalendarEvent[];
  readonly nextCursor: CalendarEventCursor | null;
}
