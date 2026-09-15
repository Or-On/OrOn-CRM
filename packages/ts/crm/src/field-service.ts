import { createHash, randomUUID } from "node:crypto";

import type postgres from "postgres";
import type { Message } from "./types.js";
import { listMessages } from "./messaging.js";

import {
  assertServiceCaseTransition,
  missingIntakeFields,
  reportCompletionErrors,
  sanitizeIntakeProposal,
  type IntakeRequiredField,
  type ServiceCaseStatus,
  type ServiceIntakeFields,
  type WarrantyStatus,
} from "./field-service-domain.js";
import { normalizeE164 } from "./phone.js";
import { requireFieldService } from "./tenant-features.js";

export interface CustomerClassification {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly color: string;
  readonly active: boolean;
}

export const customerClassificationColors = [
  "slate",
  "blue",
  "cyan",
  "emerald",
  "violet",
  "amber",
  "rose",
] as const;

export type CustomerClassificationColor =
  (typeof customerClassificationColors)[number];

export interface ServiceLocation {
  readonly id: string;
  readonly customerContactId: string | null;
  readonly name: string;
  readonly address: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly contactEmail: string | null;
}

export interface CustomerDocumentSummary {
  readonly id: string;
  readonly objectId: string;
  readonly displayName: string;
  readonly category:
    "general" | "warranty" | "invoice" | "manual" | "identity" | "other";
  readonly caption: string | null;
  readonly contentType: string;
  readonly byteSize: number;
  readonly status: "pending" | "available" | "quarantined" | "deleted";
  readonly createdAt: string;
}

export interface CustomerDossier {
  readonly contactId: string;
  readonly nationalIdMasked: string | null;
  readonly preferredLanguage: string | null;
  readonly address: string | null;
  readonly classifications: readonly CustomerClassification[];
  readonly locations: readonly ServiceLocation[];
  readonly documents: readonly CustomerDocumentSummary[];
}

export interface ProtectedNationalIdEnvelope {
  readonly ciphertext: string;
  readonly blindIndex: string;
  readonly hint: string;
}

export interface TechnicianSummary {
  readonly id: string;
  readonly linkedUserId: string | null;
  readonly employeeIdentifier: string | null;
  readonly fullName: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly identityVerification: "self_declared" | "verified" | "revoked";
  readonly active: boolean;
}

export interface ServiceCaseSummary {
  readonly id: string;
  readonly reference: string;
  readonly customerContactId: string;
  readonly customerName: string;
  readonly serviceLocationId: string | null;
  readonly serviceLocationName: string | null;
  readonly serviceLocationAddress: string | null;
  readonly status: ServiceCaseStatus;
  readonly title: string;
  readonly faultDescription: string;
  readonly warrantyStatus: WarrantyStatus;
  readonly productType: string | null;
  readonly productModel: string | null;
  readonly serialNumber: string | null;
  readonly priority: "low" | "normal" | "high" | "urgent";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ServiceAppointment {
  readonly id: string;
  readonly caseId: string;
  readonly technicianId: string;
  readonly technicianName: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
  readonly notes: string | null;
  readonly status:
    "suggested" | "scheduled" | "in_progress" | "completed" | "cancelled";
  readonly source: "manual" | "ai_suggestion" | "calendar";
  readonly approvalStatus: "pending" | "approved" | "rejected";
  readonly externalProvider: string | null;
  readonly externalEventId: string | null;
}

export interface ServiceVisit {
  readonly id: string;
  readonly caseId: string;
  readonly appointmentId: string | null;
  readonly technicianId: string;
  readonly visitNumber: number;
  readonly status:
    "assigned" | "arrived" | "departed" | "reported" | "cancelled";
  readonly arrivalAt: string | null;
  readonly departureAt: string | null;
  readonly durationSeconds: number | null;
  readonly arrivalSignatureObjectId: string | null;
  readonly departureSignatureObjectId: string | null;
  readonly arrivalIdentity: Readonly<Record<string, unknown>> | null;
  readonly departureIdentity: Readonly<Record<string, unknown>> | null;
}

export interface ServiceAttachmentSummary {
  readonly id: string;
  readonly objectId: string;
  readonly visitId: string | null;
  readonly reportRevisionId: string | null;
  readonly category: string;
  readonly source: string;
  readonly processingStatus: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly caption: string | null;
  readonly createdAt: string;
}

export const serviceOcrStatuses = [
  "pending",
  "processing",
  "review_required",
  "confirmed",
  "failed",
] as const;

export type ServiceOcrStatus = (typeof serviceOcrStatuses)[number];

export interface ServiceOcrSummary {
  readonly id: string;
  readonly attachmentId: string;
  readonly status: ServiceOcrStatus;
  readonly proposedFields: Readonly<Record<string, string>>;
  readonly confirmedFields: Readonly<Record<string, string>>;
  readonly manuallyConfirmedFields: readonly string[];
  readonly confidence: number | null;
  readonly errorSafe: string | null;
  readonly attempt: number;
}

export interface ServiceOcrQueueItem extends ServiceOcrSummary {
  readonly objectId: string;
  readonly caseId: string;
  readonly caseReference: string;
  readonly caseTitle: string;
  readonly customerName: string;
  readonly serviceLocationName: string | null;
  readonly category: string;
  readonly source: string;
  readonly attachmentProcessingStatus: string;
  readonly evidenceStatus: "pending" | "available" | "quarantined" | "deleted";
  readonly contentType: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export const serviceOcrQueueViews = [
  "attention",
  "in_flight",
  "completed",
  "all",
] as const;

export type ServiceOcrQueueView = (typeof serviceOcrQueueViews)[number];

export interface ServiceOcrQueueCursor {
  readonly status: ServiceOcrStatus;
  readonly createdAt: string;
  readonly id: string;
}

export interface ServiceOcrQueueCounts {
  /** Exact totals for the current search query, before applying a queue view. */
  readonly all: number;
  readonly attention: number;
  readonly inFlight: number;
  readonly completed: number;
}

export interface ServiceOcrQueuePage {
  readonly items: readonly ServiceOcrQueueItem[];
  readonly counts: ServiceOcrQueueCounts;
  readonly nextCursor: ServiceOcrQueueCursor | null;
}

export interface ReportRevision {
  readonly id: string;
  readonly reportId: string;
  readonly version: number;
  readonly status: "draft" | "review_required" | "finalized" | "superseded";
  readonly diagnosis: string | null;
  readonly workPerformed: string | null;
  readonly partReplaced: boolean | null;
  readonly replacementPartDetails: string | null;
  readonly technicianNotes: string | null;
  readonly finalizedAt: string | null;
}

export const serviceReportStatuses = [
  "draft",
  "review_required",
  "finalized",
  "superseded",
] as const;

export type ServiceReportStatus = (typeof serviceReportStatuses)[number];

export interface ServiceReportSummary {
  readonly id: string;
  readonly reportId: string;
  readonly version: number;
  readonly status: ServiceReportStatus;
  readonly caseId: string;
  readonly caseReference: string;
  readonly caseTitle: string;
  readonly customerContactId: string;
  readonly customerName: string;
  readonly visitId: string;
  readonly visitNumber: number;
  readonly technicianId: string;
  readonly technicianName: string;
  readonly finalizedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ServiceReportCursor {
  readonly updatedAt: string;
  readonly id: string;
}

export interface ServiceReportPage {
  readonly reports: readonly ServiceReportSummary[];
  readonly nextCursor: ServiceReportCursor | null;
}

export interface ServiceCaseDossier {
  readonly serviceCase: ServiceCaseSummary;
  readonly customer: CustomerDossier;
  readonly appointments: readonly ServiceAppointment[];
  readonly visits: readonly ServiceVisit[];
  readonly reports: readonly ReportRevision[];
  readonly conversationIds: readonly string[];
  readonly callSessionIds: readonly string[];
  readonly conversations: readonly {
    readonly conversationId: string;
    readonly messages: readonly Message[];
  }[];
  readonly calls: readonly {
    readonly sessionId: string;
    readonly status: string;
    readonly direction: string;
    readonly outcome: string | null;
    readonly answered: boolean | null;
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly recordingObjectId: string | null;
    readonly transcriptObjectId: string | null;
    readonly recordingStatus: "available" | "missing";
    readonly transcriptStatus: "available" | "missing";
  }[];
  readonly attachments: readonly ServiceAttachmentSummary[];
  readonly ocrResults?: readonly ServiceOcrSummary[];
  readonly statusHistory: readonly {
    readonly fromStatus: string | null;
    readonly toStatus: string;
    readonly reason: string | null;
    readonly changedAt: string;
  }[];
  readonly summaries: readonly {
    readonly sourceKind: "whatsapp" | "call" | "dossier";
    readonly status: string;
    readonly summary: string | null;
  }[];
  readonly audit: readonly {
    readonly action: string;
    readonly occurredAt: string;
  }[];
}

export interface ServiceCaseLinkCandidates {
  readonly conversations: readonly {
    readonly id: string;
    readonly status: string;
    readonly lastMessageAt: string | null;
    readonly linked: boolean;
    readonly linkedCaseCount: number;
  }[];
  readonly calls: readonly {
    readonly sessionId: string;
    readonly status: string;
    readonly direction: string;
    readonly startedAt: string;
    readonly linked: boolean;
    readonly linkedCaseCount: number;
  }[];
}

export interface ServiceReportDocument {
  readonly revision: ReportRevision;
  readonly serviceCase: ServiceCaseSummary;
  readonly customer: CustomerDossier;
  readonly visit: ServiceVisit;
  readonly technician: TechnicianSummary;
  readonly customerSnapshot: Readonly<Record<string, unknown>>;
  readonly productSnapshot: Readonly<Record<string, unknown>>;
  readonly branding: {
    readonly businessName: string;
    readonly logoData: string | null;
    readonly logoContentType: string | null;
    readonly accentToken: string | null;
    readonly reportHeader: string | null;
    readonly reportFooter: string | null;
    readonly businessEmail: string | null;
    readonly businessPhone: string | null;
    readonly businessAddress: string | null;
    readonly locale: string;
    readonly timezone: string;
  };
  readonly attachments: readonly ServiceAttachmentSummary[];
}

interface SignedReportFinalizationSnapshot {
  readonly schemaVersion: 1;
  readonly serviceCase: ServiceCaseSummary;
  readonly customer: Pick<
    CustomerDossier,
    "contactId" | "nationalIdMasked" | "preferredLanguage" | "address"
  >;
  readonly visit: ServiceVisit;
  readonly technician: TechnicianSummary;
}

export interface FieldServiceObjectMetadata {
  readonly id: string;
  readonly caseId: string;
  readonly category: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly checksum: string;
  readonly storageBackend: "local" | "gcs";
  readonly storageKey: string;
  readonly status: "pending" | "available" | "quarantined" | "deleted";
}

function requiredText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum)
    throw new TypeError(`${label} is required`);
  return normalized;
}

function nullableText(value: string | null | undefined, maximum = 2_000) {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (normalized.length > maximum) throw new TypeError("Text is too long");
  return normalized === "" ? null : normalized;
}

function databaseJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function signedReportFinalizationSnapshot(
  value: unknown,
  expectedCaseId: string,
  expectedVisitId: string,
): SignedReportFinalizationSnapshot | undefined {
  const stored = objectRecord(value);
  const candidate = objectRecord(stored.signedDocument);
  const serviceCase = objectRecord(candidate.serviceCase);
  const customer = objectRecord(candidate.customer);
  const visit = objectRecord(candidate.visit);
  const technician = objectRecord(candidate.technician);
  if (
    candidate.schemaVersion !== 1 ||
    serviceCase.id !== expectedCaseId ||
    visit.id !== expectedVisitId ||
    typeof serviceCase.customerContactId !== "string" ||
    customer.contactId !== serviceCase.customerContactId ||
    typeof visit.technicianId !== "string" ||
    technician.id !== visit.technicianId
  )
    return undefined;
  return candidate as unknown as SignedReportFinalizationSnapshot;
}

function storedTextRecord(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function maskedNationalId(hint: string | null): string | null {
  return hint === null ? null : `${"•".repeat(6)}${hint}`;
}

export async function listCustomerClassifications(
  sql: postgres.TransactionSql,
  includeInactive = false,
): Promise<readonly CustomerClassification[]> {
  return sql<CustomerClassification[]>`
    SELECT id, name, description, color, active
    FROM crm.customer_classifications
    WHERE ${includeInactive} OR active
    ORDER BY active DESC, lower(name), id
  `;
}

export async function createCustomerClassification(
  sql: postgres.TransactionSql,
  actorUserId: string,
  input: {
    readonly name: string;
    readonly description?: string;
    readonly color?: string;
  },
): Promise<CustomerClassification> {
  const name = requiredText(input.name, "Classification name", 80);
  const description = nullableText(input.description, 500);
  const requestedColor = nullableText(input.color, 30) ?? "slate";
  if (
    !customerClassificationColors.includes(
      requestedColor as CustomerClassificationColor,
    )
  )
    throw new TypeError("Classification color is invalid");
  const color = requestedColor as CustomerClassificationColor;
  const rows = await sql<CustomerClassification[]>`
    INSERT INTO crm.customer_classifications(
      tenant_id, name, description, color, created_by_user_id
    ) VALUES (
      platform.current_tenant_id(), ${name}, ${description}, ${color},
      ${actorUserId}::uuid
    )
    RETURNING id, name, description, color, active
  `;
  const row = rows[0];
  if (row === undefined)
    throw new Error("Classification creation returned no row");
  await sql`
    INSERT INTO audit.records(
      tenant_id, actor_user_id, action, target_type, target_id, metadata
    ) VALUES (
      platform.current_tenant_id(), ${actorUserId}::uuid,
      'customer.classification.created', 'customer_classification',
      ${row.id}::uuid, ${sql.json({ name: row.name, color: row.color })}
    )
  `;
  return row;
}

export async function updateCustomerClassification(
  sql: postgres.TransactionSql,
  actorUserId: string,
  classificationId: string,
  input: {
    readonly name: string;
    readonly description?: string | null;
    readonly color: string;
    readonly active?: boolean;
  },
): Promise<CustomerClassification> {
  const name = requiredText(input.name, "Classification name", 80);
  const description = nullableText(input.description, 500);
  if (
    !customerClassificationColors.includes(
      input.color as CustomerClassificationColor,
    )
  )
    throw new TypeError("Classification color is invalid");
  const rows = await sql<CustomerClassification[]>`
    UPDATE crm.customer_classifications SET
      name=${name}, description=${description},
      color=${input.color as CustomerClassificationColor},
      active=coalesce(${input.active ?? null}, active),
      updated_at=CURRENT_TIMESTAMP
    WHERE id=${classificationId}::uuid
    RETURNING id, name, description, color, active
  `;
  const row = rows[0];
  if (row === undefined) throw new TypeError("Classification was not found");
  await sql`
    INSERT INTO audit.records(
      tenant_id, actor_user_id, action, target_type, target_id, metadata
    ) VALUES (
      platform.current_tenant_id(), ${actorUserId}::uuid,
      'customer.classification.updated', 'customer_classification',
      ${row.id}::uuid,
      ${sql.json({ name: row.name, color: row.color, active: row.active })}
    )
  `;
  return row;
}

export async function assignContactClassification(
  sql: postgres.TransactionSql,
  actorUserId: string,
  contactId: string,
  classificationId: string,
  assigned: boolean,
): Promise<void> {
  if (assigned) {
    await sql`
      INSERT INTO crm.contact_classifications(
        tenant_id, contact_id, classification_id, assigned_by_user_id
      ) VALUES (
        platform.current_tenant_id(), ${contactId}::uuid,
        ${classificationId}::uuid, ${actorUserId}::uuid
      ) ON CONFLICT DO NOTHING
    `;
  } else {
    await sql`
      DELETE FROM crm.contact_classifications
      WHERE contact_id = ${contactId}::uuid
        AND classification_id = ${classificationId}::uuid
    `;
  }
  await sql`
    INSERT INTO audit.records(
      tenant_id, actor_user_id, action, target_type, target_id, metadata
    ) VALUES (
      platform.current_tenant_id(), ${actorUserId}::uuid,
      ${
        assigned
          ? "customer.classification.assigned"
          : "customer.classification.unassigned"
      },
      'contact', ${contactId}::uuid,
      ${sql.json({ classificationId })}
    )
  `;
}

export async function getCustomerDossier(
  sql: postgres.TransactionSql,
  contactId: string,
): Promise<CustomerDossier | undefined> {
  const contacts = await sql<{ id: string }[]>`
    SELECT id FROM crm.contacts WHERE id = ${contactId}::uuid
  `;
  if (contacts.length === 0) return undefined;
  const [profiles, classifications, locations, documents] = await Promise.all([
    sql<
      {
        national_id_hint: string | null;
        preferred_language: string | null;
        address: string | null;
      }[]
    >`
      SELECT national_id_hint, preferred_language, address
      FROM crm.customer_profiles WHERE contact_id = ${contactId}::uuid
    `,
    sql<CustomerClassification[]>`
      SELECT classification.id, classification.name, classification.description,
             classification.color, classification.active
      FROM crm.contact_classifications assigned
      JOIN crm.customer_classifications classification
        ON classification.id = assigned.classification_id
      WHERE assigned.contact_id = ${contactId}::uuid
      ORDER BY lower(classification.name), classification.id
    `,
    sql<
      {
        id: string;
        customer_contact_id: string | null;
        name: string;
        address: string | null;
        latitude: string | null;
        longitude: string | null;
        contact_name: string | null;
        contact_phone: string | null;
        contact_email: string | null;
      }[]
    >`
      SELECT id, customer_contact_id, name, address, latitude, longitude,
             contact_name, contact_phone, contact_email
      FROM crm.service_locations
      WHERE customer_contact_id = ${contactId}::uuid
        AND archived_at IS NULL
      ORDER BY lower(name), id
    `,
    sql<
      {
        id: string;
        object_id: string;
        display_name: string;
        category: CustomerDocumentSummary["category"];
        caption: string | null;
        content_type: string;
        byte_size: string;
        status: CustomerDocumentSummary["status"];
        created_at: Date;
      }[]
    >`
      SELECT document.id, document.object_id, document.display_name,
             document.category, document.caption, object.content_type,
             object.byte_size, object.status, document.created_at
      FROM crm.customer_documents document
      JOIN objects.object_metadata object ON object.id=document.object_id
      WHERE document.contact_id=${contactId}::uuid
        AND document.deleted_at IS NULL AND object.deleted_at IS NULL
      ORDER BY document.created_at DESC, document.id DESC
    `,
  ]);
  const profile = profiles[0];
  return {
    contactId,
    nationalIdMasked: maskedNationalId(profile?.national_id_hint ?? null),
    preferredLanguage: profile?.preferred_language ?? null,
    address: profile?.address ?? null,
    classifications,
    locations: locations.map((row) => ({
      id: row.id,
      customerContactId: row.customer_contact_id,
      name: row.name,
      address: row.address,
      latitude: row.latitude === null ? null : Number(row.latitude),
      longitude: row.longitude === null ? null : Number(row.longitude),
      contactName: row.contact_name,
      contactPhone: row.contact_phone,
      contactEmail: row.contact_email,
    })),
    documents: documents.map((row) => ({
      id: row.id,
      objectId: row.object_id,
      displayName: row.display_name,
      category: row.category,
      caption: row.caption,
      contentType: row.content_type,
      byteSize: Number(row.byte_size),
      status: row.status,
      createdAt: row.created_at.toISOString(),
    })),
  };
}

export async function registerCustomerDocument(
  sql: postgres.TransactionSql,
  actorUserId: string,
  input: {
    readonly contactId: string;
    readonly displayName: string;
    readonly category: CustomerDocumentSummary["category"];
    readonly caption?: string | null;
    readonly contentType: string;
    readonly byteSize: number;
    readonly checksum: string;
    readonly storageBackend: "local" | "gcs";
    readonly storageKey: string;
  },
): Promise<{ readonly documentId: string; readonly objectId: string }> {
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 1)
    throw new TypeError("Document size is invalid");
  const displayName = requiredText(input.displayName, "Document name", 240);
  if (/\p{Cc}/u.test(displayName))
    throw new TypeError("Document name contains unsupported characters");
  if (
    !["general", "warranty", "invoice", "manual", "identity", "other"].includes(
      input.category,
    )
  )
    throw new TypeError("Document category is invalid");
  const rows = await sql<{ document_id: string; object_id: string }[]>`
    WITH object_insert AS (
      INSERT INTO objects.object_metadata(
        tenant_id, created_by_user_id, owner_type, owner_id, category,
        content_type, byte_size, checksum, storage_backend, storage_key, status
      )
      SELECT platform.current_tenant_id(), ${actorUserId}::uuid, 'contact',
             contact.id, 'customer_document',
             ${requiredText(input.contentType, "Content type", 160)},
             ${input.byteSize}, ${requiredText(input.checksum, "Checksum", 128)},
             ${input.storageBackend},
             ${requiredText(input.storageKey, "Storage key", 500)}, 'pending'
      FROM crm.contacts contact WHERE contact.id=${input.contactId}::uuid
      RETURNING id
    )
    INSERT INTO crm.customer_documents(
      tenant_id, contact_id, object_id, display_name, category, caption,
      created_by_user_id
    )
    SELECT platform.current_tenant_id(), ${input.contactId}::uuid, object_insert.id,
           ${displayName}, ${input.category}, ${nullableText(input.caption, 1_000)},
           ${actorUserId}::uuid
    FROM object_insert
    RETURNING id AS document_id, object_id
  `;
  const row = rows[0];
  if (row === undefined) throw new TypeError("Customer contact was not found");
  return { documentId: row.document_id, objectId: row.object_id };
}

export async function markCustomerDocumentAvailable(
  sql: postgres.TransactionSql,
  objectId: string,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE objects.object_metadata object SET status='available',
      updated_at=CURRENT_TIMESTAMP
    WHERE object.id=${objectId}::uuid AND object.owner_type='contact'
      AND object.status='pending' AND EXISTS (
        SELECT 1 FROM crm.customer_documents document
        WHERE document.object_id=object.id AND document.deleted_at IS NULL
      )
    RETURNING object.id
  `;
  return rows.length === 1;
}

export async function getCustomerDocumentObjectMetadata(
  sql: postgres.TransactionSql,
  contactId: string,
  documentId: string,
): Promise<
  | {
      readonly id: string;
      readonly displayName: string;
      readonly category: CustomerDocumentSummary["category"];
      readonly contentType: string;
      readonly byteSize: number;
      readonly checksum: string;
      readonly storageBackend: "local" | "gcs";
      readonly storageKey: string;
      readonly status: CustomerDocumentSummary["status"];
    }
  | undefined
> {
  const rows = await sql<
    {
      id: string;
      display_name: string;
      category: CustomerDocumentSummary["category"];
      content_type: string;
      byte_size: string;
      checksum: string;
      storage_backend: "local" | "gcs";
      storage_key: string;
      status: CustomerDocumentSummary["status"];
    }[]
  >`
    SELECT object.id, document.display_name, document.category, object.content_type,
           object.byte_size, object.checksum, object.storage_backend,
           object.storage_key, object.status
    FROM crm.customer_documents document
    JOIN objects.object_metadata object ON object.id=document.object_id
    WHERE document.id=${documentId}::uuid AND document.contact_id=${contactId}::uuid
      AND document.deleted_at IS NULL AND object.deleted_at IS NULL
  `;
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        id: row.id,
        displayName: row.display_name,
        category: row.category,
        contentType: row.content_type,
        byteSize: Number(row.byte_size),
        checksum: row.checksum,
        storageBackend: row.storage_backend,
        storageKey: row.storage_key,
        status: row.status,
      };
}

export async function archiveCustomerDocument(
  sql: postgres.TransactionSql,
  actorUserId: string,
  contactId: string,
  documentId: string,
): Promise<boolean> {
  const rows = await sql<
    {
      readonly document_id: string;
      readonly object_id: string;
      readonly category: string;
    }[]
  >`
    WITH archived AS (
      UPDATE crm.customer_documents document
      SET deleted_at=CURRENT_TIMESTAMP
      WHERE document.id=${documentId}::uuid
        AND document.contact_id=${contactId}::uuid
        AND document.deleted_at IS NULL
      RETURNING document.id, document.object_id, document.category
    ), object_archive AS (
      UPDATE objects.object_metadata object
      SET status='deleted', deleted_at=CURRENT_TIMESTAMP,
          updated_at=CURRENT_TIMESTAMP
      FROM archived
      WHERE object.id=archived.object_id AND object.deleted_at IS NULL
      RETURNING object.id
    )
    SELECT archived.id AS document_id, archived.object_id, archived.category
    FROM archived
  `;
  const archived = rows[0];
  if (archived === undefined) return false;
  await sql`
    INSERT INTO audit.records(
      tenant_id, actor_user_id, action, target_type, target_id, metadata
    ) VALUES (
      platform.current_tenant_id(), ${actorUserId}::uuid,
      'customer.document.archived', 'customer_document',
      ${archived.document_id}::uuid,
      ${sql.json({
        contactId,
        objectId: archived.object_id,
        category: archived.category,
      })}
    )
  `;
  return true;
}

export async function updateCustomerDossier(
  sql: postgres.TransactionSql,
  contactId: string,
  input: {
    readonly preferredLanguage?: string | null;
    readonly address?: string | null;
    readonly nationalId?: ProtectedNationalIdEnvelope | null;
  },
): Promise<CustomerDossier> {
  const preferredLanguage = nullableText(input.preferredLanguage, 20);
  const address = nullableText(input.address, 500);
  const nationalId = input.nationalId;
  await sql`
    INSERT INTO crm.customer_profiles(
      tenant_id, contact_id, national_id_ciphertext, national_id_blind_index,
      national_id_hint, preferred_language, address
    ) VALUES (
      platform.current_tenant_id(), ${contactId}::uuid,
      ${nationalId === undefined ? null : (nationalId?.ciphertext ?? null)},
      ${nationalId === undefined ? null : (nationalId?.blindIndex ?? null)},
      ${nationalId === undefined ? null : (nationalId?.hint ?? null)},
      ${preferredLanguage}, ${address}
    ) ON CONFLICT (tenant_id, contact_id) DO UPDATE SET
      national_id_ciphertext = CASE WHEN ${nationalId !== undefined}
        THEN EXCLUDED.national_id_ciphertext ELSE crm.customer_profiles.national_id_ciphertext END,
      national_id_blind_index = CASE WHEN ${nationalId !== undefined}
        THEN EXCLUDED.national_id_blind_index ELSE crm.customer_profiles.national_id_blind_index END,
      national_id_hint = CASE WHEN ${nationalId !== undefined}
        THEN EXCLUDED.national_id_hint ELSE crm.customer_profiles.national_id_hint END,
      preferred_language = CASE WHEN ${input.preferredLanguage !== undefined}
        THEN EXCLUDED.preferred_language ELSE crm.customer_profiles.preferred_language END,
      address = CASE WHEN ${input.address !== undefined}
        THEN EXCLUDED.address ELSE crm.customer_profiles.address END,
      updated_at = CURRENT_TIMESTAMP
  `;
  const dossier = await getCustomerDossier(sql, contactId);
  if (dossier === undefined)
    throw new Error("Customer dossier contact was not found");
  return dossier;
}

export async function getCustomerNationalIdEnvelope(
  sql: postgres.TransactionSql,
  contactId: string,
): Promise<ProtectedNationalIdEnvelope | undefined> {
  const rows = await sql<
    { ciphertext: string; blind_index: string; hint: string }[]
  >`
    SELECT national_id_ciphertext AS ciphertext,
           national_id_blind_index AS blind_index,
           national_id_hint AS hint
    FROM crm.customer_profiles
    WHERE contact_id = ${contactId}::uuid AND national_id_ciphertext IS NOT NULL
  `;
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        ciphertext: row.ciphertext,
        blindIndex: row.blind_index,
        hint: row.hint,
      };
}

export async function createServiceLocation(
  sql: postgres.TransactionSql,
  input: {
    readonly customerContactId?: string | null;
    readonly name: string;
    readonly address?: string | null;
    readonly latitude?: number | null;
    readonly longitude?: number | null;
    readonly contactName?: string | null;
    readonly contactPhone?: string | null;
    readonly contactEmail?: string | null;
  },
): Promise<string> {
  const name = requiredText(input.name, "Location name", 160);
  const latitude = input.latitude ?? null;
  const longitude = input.longitude ?? null;
  if ((latitude === null) !== (longitude === null))
    throw new TypeError("Latitude and longitude must be supplied together");
  const rows = await sql<{ id: string }[]>`
    INSERT INTO crm.service_locations(
      tenant_id, customer_contact_id, name, address, latitude, longitude,
      contact_name, contact_phone, contact_email
    ) VALUES (
      platform.current_tenant_id(), ${input.customerContactId ?? null}::uuid,
      ${name}, ${nullableText(input.address, 500)}, ${latitude}, ${longitude},
      ${nullableText(input.contactName, 160)}, ${nullableText(input.contactPhone, 40)},
      ${nullableText(input.contactEmail, 320)}
    ) RETURNING id
  `;
  const id = rows[0]?.id;
  if (id === undefined)
    throw new Error("Location creation returned no identifier");
  return id;
}

function validatedLocationCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): readonly [number | null, number | null] {
  const normalizedLatitude = latitude ?? null;
  const normalizedLongitude = longitude ?? null;
  if ((normalizedLatitude === null) !== (normalizedLongitude === null))
    throw new TypeError("Latitude and longitude must be supplied together");
  if (
    normalizedLatitude !== null &&
    (normalizedLongitude === null ||
      !Number.isFinite(normalizedLatitude) ||
      !Number.isFinite(normalizedLongitude) ||
      normalizedLatitude < -90 ||
      normalizedLatitude > 90 ||
      normalizedLongitude < -180 ||
      normalizedLongitude > 180)
  )
    throw new TypeError("Service-location coordinates are invalid");
  return [normalizedLatitude, normalizedLongitude];
}

export async function updateServiceLocation(
  sql: postgres.TransactionSql,
  actorUserId: string,
  contactId: string,
  locationId: string,
  input: {
    readonly name: string;
    readonly address?: string | null;
    readonly latitude?: number | null;
    readonly longitude?: number | null;
    readonly contactName?: string | null;
    readonly contactPhone?: string | null;
    readonly contactEmail?: string | null;
  },
): Promise<boolean> {
  const [latitude, longitude] = validatedLocationCoordinates(
    input.latitude,
    input.longitude,
  );
  const rows = await sql<{ id: string }[]>`
    UPDATE crm.service_locations SET
      name=${requiredText(input.name, "Location name", 160)},
      address=${nullableText(input.address, 500)},
      latitude=${latitude}, longitude=${longitude},
      contact_name=${nullableText(input.contactName, 160)},
      contact_phone=${nullableText(input.contactPhone, 40)},
      contact_email=${nullableText(input.contactEmail, 320)},
      updated_at=CURRENT_TIMESTAMP
    WHERE id=${locationId}::uuid AND customer_contact_id=${contactId}::uuid
      AND archived_at IS NULL
    RETURNING id
  `;
  if (rows.length === 0) return false;
  await sql`
    INSERT INTO audit.records(
      tenant_id, actor_user_id, action, target_type, target_id, metadata
    ) VALUES (
      platform.current_tenant_id(), ${actorUserId}::uuid,
      'customer.location.updated', 'service_location', ${locationId}::uuid,
      ${sql.json({ contactId })}
    )
  `;
  return true;
}

export async function archiveServiceLocation(
  sql: postgres.TransactionSql,
  actorUserId: string,
  contactId: string,
  locationId: string,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE crm.service_locations SET archived_at=CURRENT_TIMESTAMP,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=${locationId}::uuid AND customer_contact_id=${contactId}::uuid
      AND archived_at IS NULL
    RETURNING id
  `;
  if (rows.length === 0) return false;
  await sql`
    INSERT INTO audit.records(
      tenant_id, actor_user_id, action, target_type, target_id, metadata
    ) VALUES (
      platform.current_tenant_id(), ${actorUserId}::uuid,
      'customer.location.archived', 'service_location', ${locationId}::uuid,
      ${sql.json({ contactId })}
    )
  `;
  return true;
}

export async function listTechnicians(
  sql: postgres.TransactionSql,
  includeInactive = false,
): Promise<readonly TechnicianSummary[]> {
  await requireFieldService(sql);
  const rows = await sql<
    {
      id: string;
      linked_user_id: string | null;
      employee_identifier: string | null;
      full_name: string;
      phone: string | null;
      email: string | null;
      identity_verification: TechnicianSummary["identityVerification"];
      active: boolean;
    }[]
  >`
    SELECT id, linked_user_id, employee_identifier, full_name, phone, email,
           identity_verification, active
    FROM service.technicians
    WHERE ${includeInactive} OR active
    ORDER BY active DESC, lower(full_name), id
  `;
  return rows.map((row) => ({
    id: row.id,
    linkedUserId: row.linked_user_id,
    employeeIdentifier: row.employee_identifier,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    identityVerification: row.identity_verification,
    active: row.active,
  }));
}

export async function createTechnician(
  sql: postgres.TransactionSql,
  actorUserId: string,
  input: {
    readonly linkedUserId?: string | null;
    readonly employeeIdentifier?: string | null;
    readonly fullName: string;
    readonly phone?: string | null;
    readonly email?: string | null;
    readonly verified?: boolean;
  },
): Promise<string> {
  await requireFieldService(sql);
  if (input.linkedUserId !== undefined && input.linkedUserId !== null)
    await assertTechnicianUserLink(sql, input.linkedUserId);
  const rows = await sql<{ id: string }[]>`
    INSERT INTO service.technicians(
      tenant_id, linked_user_id, employee_identifier, full_name, phone, email,
      identity_verification, created_by_user_id
    ) VALUES (
      platform.current_tenant_id(), ${input.linkedUserId ?? null}::uuid,
      ${nullableText(input.employeeIdentifier, 100)},
      ${requiredText(input.fullName, "Technician name", 160)},
      ${nullableText(input.phone, 40)}, ${nullableText(input.email, 320)},
      ${input.verified === true ? "verified" : "self_declared"},
      ${actorUserId}::uuid
    ) RETURNING id
  `;
  const id = rows[0]?.id;
  if (id === undefined)
    throw new Error("Technician creation returned no identifier");
  await sql`
    INSERT INTO audit.records(
      tenant_id, actor_user_id, action, target_type, target_id, metadata
    ) VALUES (
      platform.current_tenant_id(), ${actorUserId}::uuid,
      'field_service.technician.created', 'technician', ${id}::uuid,
      ${sql.json({
        linkedUserId: input.linkedUserId ?? null,
        verified: input.verified === true,
      })}
    )
  `;
  return id;
}

async function assertTechnicianUserLink(
  sql: postgres.TransactionSql,
  linkedUserId: string,
): Promise<void> {
  const rows = await sql<{ user_id: string }[]>`
    SELECT user_id
    FROM platform.current_tenant_team()
    WHERE user_id=${linkedUserId}::uuid AND role='technician'
  `;
  if (rows.length !== 1)
    throw new TypeError(
      "Linked user must be an active technician member of this tenant",
    );
}

export async function updateTechnician(
  sql: postgres.TransactionSql,
  actorUserId: string,
  technicianId: string,
  input: {
    readonly linkedUserId?: string | null;
    readonly employeeIdentifier?: string | null;
    readonly fullName?: string;
    readonly phone?: string | null;
    readonly email?: string | null;
    readonly verified?: boolean;
    readonly active?: boolean;
  },
): Promise<TechnicianSummary | undefined> {
  await requireFieldService(sql);
  if (input.linkedUserId !== undefined && input.linkedUserId !== null)
    await assertTechnicianUserLink(sql, input.linkedUserId);
  const rows = await sql<{ id: string }[]>`
    UPDATE service.technicians SET
      linked_user_id=CASE WHEN ${input.linkedUserId !== undefined}
        THEN ${input.linkedUserId ?? null}::uuid ELSE linked_user_id END,
      employee_identifier=CASE WHEN ${input.employeeIdentifier !== undefined}
        THEN ${nullableText(input.employeeIdentifier, 100)} ELSE employee_identifier END,
      full_name=CASE WHEN ${input.fullName !== undefined}
        THEN ${input.fullName === undefined ? "" : requiredText(input.fullName, "Technician name", 160)}
        ELSE full_name END,
      phone=CASE WHEN ${input.phone !== undefined}
        THEN ${nullableText(input.phone, 40)} ELSE phone END,
      email=CASE WHEN ${input.email !== undefined}
        THEN ${nullableText(input.email, 320)} ELSE email END,
      identity_verification=CASE
        WHEN ${input.active === false} THEN 'revoked'
        WHEN ${input.verified !== undefined}
          THEN CASE WHEN ${input.verified === true} THEN 'verified' ELSE 'self_declared' END
        ELSE identity_verification END,
      active=COALESCE(${input.active ?? null}, active),
      updated_at=CURRENT_TIMESTAMP
    WHERE id=${technicianId}::uuid
    RETURNING id
  `;
  if (rows.length === 0) return undefined;
  await sql`
    INSERT INTO audit.records(
      tenant_id, actor_user_id, action, target_type, target_id, metadata
    ) VALUES (
      platform.current_tenant_id(), ${actorUserId}::uuid,
      'field_service.technician.updated', 'technician', ${technicianId}::uuid,
      ${sql.json({
        linkedUserId: input.linkedUserId ?? null,
        linkedUserIdChanged: input.linkedUserId !== undefined,
        verified: input.verified ?? null,
        verifiedChanged: input.verified !== undefined,
        active: input.active ?? null,
        activeChanged: input.active !== undefined,
      })}
    )
  `;
  return (await listTechnicians(sql, true)).find(
    (technician) => technician.id === technicianId,
  );
}

interface ServiceCaseRow {
  readonly id: string;
  readonly reference: string;
  readonly customer_contact_id: string;
  readonly customer_name: string;
  readonly service_location_id: string | null;
  readonly service_location_name: string | null;
  readonly service_location_address: string | null;
  readonly status: ServiceCaseStatus;
  readonly title: string;
  readonly fault_description: string;
  readonly warranty_status: WarrantyStatus;
  readonly product_type: string | null;
  readonly product_model: string | null;
  readonly serial_number: string | null;
  readonly priority: ServiceCaseSummary["priority"];
  readonly created_at: Date;
  readonly updated_at: Date;
}

function serviceCase(row: ServiceCaseRow): ServiceCaseSummary {
  return {
    id: row.id,
    reference: row.reference,
    customerContactId: row.customer_contact_id,
    customerName: row.customer_name,
    serviceLocationId: row.service_location_id,
    serviceLocationName: row.service_location_name,
    serviceLocationAddress: row.service_location_address,
    status: row.status,
    title: row.title,
    faultDescription: row.fault_description,
    warrantyStatus: row.warranty_status,
    productType: row.product_type,
    productModel: row.product_model,
    serialNumber: row.serial_number,
    priority: row.priority,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const caseProjection = `
  SELECT service_case.id, service_case.reference,
         service_case.customer_contact_id, customer.name AS customer_name,
         service_case.service_location_id,
         location.name AS service_location_name,
         location.address AS service_location_address, service_case.status,
         service_case.title, service_case.fault_description,
         service_case.warranty_status, service_case.product_type,
         service_case.product_model,
         service_case.serial_number, service_case.priority,
         service_case.created_at, service_case.updated_at
  FROM service.cases service_case
  JOIN crm.contacts customer ON customer.id = service_case.customer_contact_id
  LEFT JOIN crm.service_locations location ON location.id = service_case.service_location_id
`;

export async function listServiceCases(
  sql: postgres.TransactionSql,
  options: {
    readonly status?: ServiceCaseStatus;
    readonly query?: string;
  } = {},
): Promise<readonly ServiceCaseSummary[]> {
  return (await listServiceCasePage(sql, options)).cases;
}

export interface ServiceCaseCursor {
  readonly updatedAt: string;
  readonly id: string;
}

export interface ServiceCasePage {
  readonly cases: readonly ServiceCaseSummary[];
  readonly nextCursor: ServiceCaseCursor | null;
}

export async function listServiceCasePage(
  sql: postgres.TransactionSql,
  options: {
    readonly status?: ServiceCaseStatus;
    readonly query?: string;
    readonly limit?: number;
    readonly cursor?: ServiceCaseCursor;
  } = {},
): Promise<ServiceCasePage> {
  await requireFieldService(sql);
  const query = options.query?.trim() ?? "";
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const cursorDate =
    options.cursor === undefined
      ? undefined
      : new Date(options.cursor.updatedAt);
  if (cursorDate !== undefined && Number.isNaN(cursorDate.valueOf()))
    throw new TypeError("Service-case cursor timestamp is invalid");
  const rows = await sql.unsafe<ServiceCaseRow[]>(
    `${caseProjection}
     WHERE ($1::text IS NULL OR service_case.status = $1)
       AND ($2 = '' OR service_case.reference ILIKE '%' || $2 || '%'
         OR service_case.title ILIKE '%' || $2 || '%'
         OR customer.name ILIKE '%' || $2 || '%')
       AND ($3::timestamptz IS NULL OR
         (service_case.updated_at, service_case.id) <
         ($3::timestamptz, $4::uuid))
     ORDER BY service_case.updated_at DESC, service_case.id DESC LIMIT $5`,
    [
      options.status ?? null,
      query,
      cursorDate?.toISOString() ?? null,
      options.cursor?.id ?? null,
      limit + 1,
    ],
  );
  const hasMore = rows.length > limit;
  const selected = hasMore ? rows.slice(0, limit) : rows;
  const last = selected.at(-1);
  return {
    cases: selected.map(serviceCase),
    nextCursor:
      hasMore && last !== undefined
        ? { updatedAt: last.updated_at.toISOString(), id: last.id }
        : null,
  };
}

export async function getServiceCase(
  sql: postgres.TransactionSql,
  caseId: string,
): Promise<ServiceCaseSummary | undefined> {
  await requireFieldService(sql);
  return getServiceCaseRecord(sql, caseId);
}

async function getServiceCaseRecord(
  sql: postgres.TransactionSql,
  caseId: string,
): Promise<ServiceCaseSummary | undefined> {
  const rows = await sql.unsafe<ServiceCaseRow[]>(
    `${caseProjection} WHERE service_case.id = $1::uuid`,
    [caseId],
  );
  return rows[0] === undefined ? undefined : serviceCase(rows[0]);
}

export async function listCustomerServiceCases(
  sql: postgres.TransactionSql,
  contactId: string,
): Promise<readonly ServiceCaseSummary[]> {
  await requireFieldService(sql);
  const rows = await sql.unsafe<ServiceCaseRow[]>(
    `${caseProjection}
     WHERE service_case.customer_contact_id = $1::uuid
        OR service_case.reporting_contact_id = $1::uuid
     ORDER BY service_case.updated_at DESC, service_case.id DESC LIMIT 200`,
    [contactId],
  );
  return rows.map(serviceCase);
}

export async function createServiceCase(
  sql: postgres.TransactionSql,
  actor: { readonly userId?: string; readonly service?: string },
  input: {
    readonly customerContactId: string;
    readonly reportingContactId?: string | null;
    readonly serviceLocationId?: string | null;
    readonly intakeDraftId?: string | null;
    readonly conversationId?: string | null;
    readonly title: string;
    readonly faultDescription: string;
    readonly warrantyStatus?: WarrantyStatus;
    readonly productType?: string | null;
    readonly productModel?: string | null;
    readonly serialNumber?: string | null;
    readonly priority?: ServiceCaseSummary["priority"];
    readonly source?: "manual" | "whatsapp";
  },
): Promise<ServiceCaseSummary> {
  await requireFieldService(sql);
  if ((actor.userId === undefined) === (actor.service === undefined))
    throw new TypeError("Exactly one case actor is required");
  if (
    input.serviceLocationId !== null &&
    input.serviceLocationId !== undefined
  ) {
    const locations = await sql<{ id: string }[]>`
      SELECT id FROM crm.service_locations
      WHERE id=${input.serviceLocationId}::uuid
        AND customer_contact_id=${input.customerContactId}::uuid
        AND archived_at IS NULL
      FOR SHARE
    `;
    if (locations[0] === undefined)
      throw new TypeError(
        "An active service location belonging to the customer is required",
      );
  }
  const rows = await sql<{ id: string }[]>`
    WITH identifier AS (SELECT gen_random_uuid() AS id)
    INSERT INTO service.cases(
      id, tenant_id, reference, customer_contact_id, reporting_contact_id,
      service_location_id, intake_draft_id, conversation_id, title,
      fault_description, warranty_status, product_type, product_model,
      serial_number, priority, source, created_by_user_id
    ) SELECT
      identifier.id, platform.current_tenant_id(),
      'FS-' || to_char(CURRENT_TIMESTAMP, 'YYYY') || '-' ||
        upper(left(replace(identifier.id::text, '-', ''), 8)),
      ${input.customerContactId}::uuid, ${input.reportingContactId ?? null}::uuid,
      ${input.serviceLocationId ?? null}::uuid, ${input.intakeDraftId ?? null}::uuid,
      ${input.conversationId ?? null}::uuid,
      ${requiredText(input.title, "Case title", 200)},
      ${requiredText(input.faultDescription, "Fault description", 10_000)},
      ${input.warrantyStatus ?? "unknown"}, ${nullableText(input.productType, 160)},
      ${nullableText(input.productModel, 160)}, ${nullableText(input.serialNumber, 160)},
      ${input.priority ?? "normal"}, ${input.source ?? "manual"},
      ${actor.userId ?? null}::uuid
    FROM identifier RETURNING id
  `;
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("Case creation returned no identifier");
  await sql`
    INSERT INTO service.case_status_history(
      tenant_id, case_id, to_status, actor_user_id, actor_service
    ) VALUES (
      platform.current_tenant_id(), ${id}::uuid, 'awaiting_scheduling',
      ${actor.userId ?? null}::uuid, ${actor.service ?? null}
    )
  `;
  if (input.conversationId !== null && input.conversationId !== undefined) {
    await linkCaseConversation(
      sql,
      id,
      input.conversationId,
      input.source === "whatsapp" ? "intake" : "relevant",
      actor.userId ?? null,
    );
  }
  const created = await getServiceCase(sql, id);
  if (created === undefined) throw new Error("Created case could not be read");
  return created;
}

export async function transitionServiceCase(
  sql: postgres.TransactionSql,
  actor: { readonly userId?: string; readonly service?: string },
  caseId: string,
  nextStatus: ServiceCaseStatus,
  reason?: string,
): Promise<ServiceCaseSummary> {
  await requireFieldService(sql);
  const current = await sql<{ status: ServiceCaseStatus }[]>`
    SELECT status FROM service.cases WHERE id = ${caseId}::uuid FOR UPDATE
  `;
  const row = current[0];
  if (row === undefined) throw new Error("Service case was not found");
  assertServiceCaseTransition(row.status, nextStatus);
  if (row.status !== nextStatus) {
    await sql`
      UPDATE service.cases SET status = ${nextStatus},
        closed_at = CASE WHEN ${nextStatus} = 'closed' THEN CURRENT_TIMESTAMP ELSE closed_at END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ${caseId}::uuid
    `;
    await sql`
      INSERT INTO service.case_status_history(
        tenant_id, case_id, from_status, to_status, reason,
        actor_user_id, actor_service
      ) VALUES (
        platform.current_tenant_id(), ${caseId}::uuid, ${row.status}, ${nextStatus},
        ${nullableText(reason, 1_000)}, ${actor.userId ?? null}::uuid,
        ${actor.service ?? null}
      )
    `;
  }
  const updated = await getServiceCase(sql, caseId);
  if (updated === undefined) throw new Error("Service case was not found");
  return updated;
}

function validTimezone(value: string): string {
  const timezone = requiredText(value, "Timezone", 100);
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
  } catch {
    throw new TypeError("Timezone must be a valid IANA time-zone name");
  }
  return timezone;
}

function appointment(row: {
  id: string;
  case_id: string;
  technician_id: string;
  technician_name: string;
  starts_at: Date;
  ends_at: Date;
  timezone: string;
  notes: string | null;
  status: ServiceAppointment["status"];
  source: ServiceAppointment["source"];
  approval_status: ServiceAppointment["approvalStatus"];
  external_provider: string | null;
  external_event_id: string | null;
}): ServiceAppointment {
  return {
    id: row.id,
    caseId: row.case_id,
    technicianId: row.technician_id,
    technicianName: row.technician_name,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    timezone: row.timezone,
    notes: row.notes,
    status: row.status,
    source: row.source,
    approvalStatus: row.approval_status,
    externalProvider: row.external_provider,
    externalEventId: row.external_event_id,
  };
}

export async function listServiceAppointments(
  sql: postgres.TransactionSql,
  caseId?: string,
): Promise<readonly ServiceAppointment[]> {
  await requireFieldService(sql);
  return listServiceAppointmentRecords(sql, caseId);
}

async function listServiceAppointmentRecords(
  sql: postgres.TransactionSql,
  caseId?: string,
): Promise<readonly ServiceAppointment[]> {
  const rows = await sql<
    {
      id: string;
      case_id: string;
      technician_id: string;
      technician_name: string;
      starts_at: Date;
      ends_at: Date;
      timezone: string;
      notes: string | null;
      status: ServiceAppointment["status"];
      source: ServiceAppointment["source"];
      approval_status: ServiceAppointment["approvalStatus"];
      external_provider: string | null;
      external_event_id: string | null;
    }[]
  >`
    SELECT item.id, item.case_id, item.technician_id,
           technician.full_name AS technician_name, item.starts_at, item.ends_at,
           item.timezone, item.notes, item.status, item.source, item.approval_status,
           item.external_provider, item.external_event_id
    FROM service.appointments item
    JOIN service.technicians technician ON technician.id = item.technician_id
    WHERE (${caseId ?? null}::uuid IS NULL OR item.case_id = ${caseId ?? null}::uuid)
    ORDER BY item.starts_at, item.id
  `;
  return rows.map(appointment);
}

async function assertTenantCalendarAvailability(
  sql: postgres.TransactionSql,
  technicianId: string,
  startsAt: Date,
  endsAt: Date,
  excludedEventId: string | null = null,
): Promise<void> {
  const technicians = await sql<{ linked_user_id: string | null }[]>`
    SELECT linked_user_id FROM service.technicians
    WHERE id=${technicianId}::uuid AND active
  `;
  if (technicians[0]?.linked_user_id == null)
    throw new TypeError(
      "AI scheduling requires a technician linked to the tenant calendar",
    );
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(platform.current_tenant_id()::text || ':' || ${technicianId}, 0)
    )
  `;
  const conflicts = await sql<{ id: string }[]>`
    SELECT calendar.id
    FROM service.technicians technician
    JOIN crm.calendar_events calendar
      ON calendar.organizer_user_id=technician.linked_user_id
     AND calendar.status IN ('confirmed','tentative')
    WHERE technician.id=${technicianId}::uuid
      AND technician.active AND technician.linked_user_id IS NOT NULL
      AND (${excludedEventId}::uuid IS NULL OR calendar.id<>${excludedEventId}::uuid)
      AND tstzrange(calendar.starts_at, calendar.ends_at, '[)') &&
          tstzrange(${startsAt}, ${endsAt}, '[)')
    LIMIT 1
  `;
  if (conflicts[0] !== undefined)
    throw new TypeError("The technician is unavailable in the tenant calendar");
}

async function createTenantCalendarEventForAppointment(
  sql: postgres.TransactionSql,
  actorUserId: string,
  appointmentId: string,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO crm.calendar_events(
      tenant_id, created_by_user_id, organizer_user_id, title, description,
      location, starts_at, ends_at, all_day, timezone, status
    )
    SELECT appointment.tenant_id, ${actorUserId}::uuid, technician.linked_user_id,
           'Service visit · ' || service_case.reference,
           service_case.title,
           location.address,
           appointment.starts_at, appointment.ends_at, false,
           appointment.timezone, 'confirmed'
    FROM service.appointments appointment
    JOIN service.cases service_case ON service_case.id=appointment.case_id
    JOIN service.technicians technician ON technician.id=appointment.technician_id
    LEFT JOIN crm.service_locations location
      ON location.id=service_case.service_location_id
    WHERE appointment.id=${appointmentId}::uuid
    RETURNING id
  `;
  const eventId = rows[0]?.id;
  if (eventId === undefined)
    throw new TypeError(
      "The appointment cannot be added to the tenant calendar",
    );
  return eventId;
}

/**
 * Produces one grounded scheduling proposal from the tenant's own appointment
 * and calendar records. It deliberately does not create a calendar event; the
 * separate approval path owns that explicit write.
 */
export async function suggestNextServiceAppointment(
  sql: postgres.TransactionSql,
  actorUserId: string,
  input: {
    readonly caseId: string;
    readonly earliestAt: string;
    readonly durationMinutes: number;
    readonly timezone: string;
    readonly notes?: string | null;
    readonly idempotencyKey: string;
  },
): Promise<ServiceAppointment> {
  const state = await requireFieldService(sql);
  if (
    !state.aiSchedulingEnabled ||
    !state.readiness.calendarCanSuggest ||
    state.calendarProvider !== "crm_calendar"
  )
    throw new TypeError(
      "AI scheduling requires an enabled, readable tenant calendar",
    );
  if (
    !Number.isSafeInteger(input.durationMinutes) ||
    input.durationMinutes < 15 ||
    input.durationMinutes > 8 * 60 ||
    input.durationMinutes % 15 !== 0
  )
    throw new TypeError(
      "Suggested visit duration must be 15 to 480 minutes in 15-minute steps",
    );
  const timezone = validTimezone(input.timezone);
  const requestedEarliest = new Date(input.earliestAt);
  if (!Number.isFinite(requestedEarliest.valueOf()))
    throw new TypeError("Suggestion start must be a valid instant");
  const now = new Date();
  const earliestAt =
    requestedEarliest.valueOf() < now.valueOf() ? now : requestedEarliest;
  if (earliestAt.valueOf() > now.valueOf() + 90 * 24 * 60 * 60 * 1_000)
    throw new TypeError("Suggestion start is outside the 90-day horizon");

  await sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(platform.current_tenant_id()::text || ':ai-schedule', 0)
    )
  `;
  const existing = await sql<
    {
      id: string;
      case_id: string;
      technician_id: string;
      technician_name: string;
      starts_at: Date;
      ends_at: Date;
      timezone: string;
      notes: string | null;
      status: ServiceAppointment["status"];
      source: ServiceAppointment["source"];
      approval_status: ServiceAppointment["approvalStatus"];
      external_provider: string | null;
      external_event_id: string | null;
    }[]
  >`
    SELECT item.id, item.case_id, item.technician_id,
           technician.full_name AS technician_name, item.starts_at, item.ends_at,
           item.timezone, item.notes, item.status, item.source,
           item.approval_status, item.external_provider, item.external_event_id
    FROM service.appointments item
    JOIN service.technicians technician ON technician.id=item.technician_id
    WHERE item.idempotency_key=${requiredText(
      input.idempotencyKey,
      "Idempotency key",
      200,
    )}
  `;
  if (existing[0] !== undefined) {
    if (
      existing[0].case_id !== input.caseId ||
      existing[0].source !== "ai_suggestion"
    )
      throw new TypeError(
        "The idempotency key already belongs to another appointment",
      );
    return appointment(existing[0]);
  }

  const candidates = await sql<
    {
      technician_id: string;
      starts_at: Date;
      ends_at: Date;
    }[]
  >`
    WITH local_slots AS (
      SELECT generated.local_start
      FROM generate_series(
        date_trunc('day', ${earliestAt}::timestamptz AT TIME ZONE ${timezone}),
        date_trunc('day', ${earliestAt}::timestamptz AT TIME ZONE ${timezone})
          + interval '21 days',
        interval '30 minutes'
      ) AS generated(local_start)
      WHERE extract(isodow FROM generated.local_start) BETWEEN 1 AND 5
        AND generated.local_start::time >= time '08:00'
        AND (generated.local_start
          + make_interval(mins => ${input.durationMinutes}))::time <= time '18:00'
    ), candidates AS (
      SELECT technician.id AS technician_id,
             slot.local_start AT TIME ZONE ${timezone} AS starts_at,
             (slot.local_start + make_interval(mins => ${input.durationMinutes}))
               AT TIME ZONE ${timezone} AS ends_at,
             technician.full_name, technician.linked_user_id
      FROM service.technicians technician CROSS JOIN local_slots slot
      WHERE technician.active AND technician.linked_user_id IS NOT NULL
    )
    SELECT candidate.technician_id, candidate.starts_at, candidate.ends_at
    FROM candidates candidate
    WHERE candidate.starts_at >= ${earliestAt}
      AND NOT EXISTS (
        SELECT 1 FROM service.appointments booked
        WHERE booked.technician_id=candidate.technician_id
          AND booked.status IN ('suggested','scheduled','in_progress')
          AND tstzrange(booked.starts_at, booked.ends_at, '[)') &&
              tstzrange(candidate.starts_at, candidate.ends_at, '[)')
      )
      AND NOT EXISTS (
        SELECT 1 FROM crm.calendar_events calendar
        WHERE calendar.organizer_user_id=candidate.linked_user_id
          AND calendar.status IN ('confirmed','tentative')
          AND tstzrange(calendar.starts_at, calendar.ends_at, '[)') &&
              tstzrange(candidate.starts_at, candidate.ends_at, '[)')
      )
    ORDER BY candidate.starts_at, lower(candidate.full_name),
             candidate.technician_id
    LIMIT 1
  `;
  const candidate = candidates[0];
  if (candidate === undefined)
    throw new TypeError(
      "No grounded technician availability was found in the next 21 days",
    );
  return scheduleServiceAppointment(sql, actorUserId, {
    caseId: input.caseId,
    technicianId: candidate.technician_id,
    startsAt: candidate.starts_at.toISOString(),
    endsAt: candidate.ends_at.toISOString(),
    timezone,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    source: "ai_suggestion",
    idempotencyKey: input.idempotencyKey,
  });
}

export async function scheduleServiceAppointment(
  sql: postgres.TransactionSql,
  actorUserId: string,
  input: {
    readonly caseId: string;
    readonly technicianId: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly timezone: string;
    readonly notes?: string | null;
    readonly source?: "manual" | "ai_suggestion";
    readonly idempotencyKey: string;
  },
): Promise<ServiceAppointment> {
  const state = await requireFieldService(sql);
  const source = input.source ?? "manual";
  if (source === "ai_suggestion" && !state.aiSchedulingEnabled)
    throw new TypeError("AI scheduling is not enabled for this tenant");
  if (
    source === "ai_suggestion" &&
    (!state.readiness.calendarCanSuggest ||
      state.calendarProvider !== "crm_calendar")
  )
    throw new TypeError("AI scheduling requires a readable tenant calendar");
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  if (
    !Number.isFinite(startsAt.valueOf()) ||
    !Number.isFinite(endsAt.valueOf()) ||
    endsAt <= startsAt
  )
    throw new TypeError("Appointment end must be after its start");
  if (endsAt.valueOf() - startsAt.valueOf() > 24 * 60 * 60 * 1_000)
    throw new TypeError("An appointment cannot be longer than 24 hours");
  const timezone = validTimezone(input.timezone);
  const notes = nullableText(input.notes, 2_000);
  const idempotencyKey = requiredText(
    input.idempotencyKey,
    "Idempotency key",
    200,
  );
  const schedulableCases = await sql<{ status: ServiceCaseStatus }[]>`
    SELECT status FROM service.cases WHERE id=${input.caseId}::uuid
      AND status NOT IN ('closed','cancelled') FOR UPDATE
  `;
  if (schedulableCases[0] === undefined)
    throw new TypeError("An active service case is required for scheduling");
  const existingRequest = await sql<
    {
      id: string;
      case_id: string;
      technician_id: string;
      technician_name: string;
      starts_at: Date;
      ends_at: Date;
      timezone: string;
      notes: string | null;
      status: ServiceAppointment["status"];
      source: ServiceAppointment["source"];
      approval_status: ServiceAppointment["approvalStatus"];
      external_provider: string | null;
      external_event_id: string | null;
    }[]
  >`
    SELECT appointment.id, appointment.case_id, appointment.technician_id,
      technician.full_name AS technician_name, appointment.starts_at,
      appointment.ends_at, appointment.timezone, appointment.notes,
      appointment.status, appointment.source, appointment.approval_status,
      appointment.external_provider, appointment.external_event_id
    FROM service.appointments appointment
    JOIN service.technicians technician ON technician.id=appointment.technician_id
    WHERE appointment.idempotency_key=${idempotencyKey}
    FOR SHARE OF appointment
  `;
  const replay = existingRequest[0];
  if (replay !== undefined) {
    if (
      replay.case_id !== input.caseId ||
      replay.technician_id !== input.technicianId ||
      replay.starts_at.valueOf() !== startsAt.valueOf() ||
      replay.ends_at.valueOf() !== endsAt.valueOf() ||
      replay.timezone !== timezone ||
      replay.notes !== notes ||
      replay.source !== source
    )
      throw new TypeError(
        "The idempotency key already belongs to another appointment",
      );
    return appointment(replay);
  }
  const activeTechnicians = await sql<{ id: string }[]>`
    SELECT id FROM service.technicians
    WHERE id=${input.technicianId}::uuid AND active
    FOR SHARE
  `;
  if (activeTechnicians[0] === undefined)
    throw new TypeError("An active technician is required for scheduling");
  const requiresApproval =
    source === "ai_suggestion" && state.aiScheduleRequiresApproval;
  const status = requiresApproval ? "suggested" : "scheduled";
  const approvalStatus = requiresApproval ? "pending" : "approved";
  if (
    source === "ai_suggestion" &&
    status === "scheduled" &&
    (!state.readiness.calendarCanBook ||
      state.calendarProvider !== "crm_calendar")
  )
    throw new TypeError(
      "Calendar write access is required to approve an AI suggestion",
    );
  if (source === "ai_suggestion")
    await assertTenantCalendarAvailability(
      sql,
      input.technicianId,
      startsAt,
      endsAt,
    );
  const rows = await sql<
    {
      id: string;
      case_id: string;
      technician_id: string;
      technician_name: string;
      starts_at: Date;
      ends_at: Date;
      timezone: string;
      notes: string | null;
      status: ServiceAppointment["status"];
      source: ServiceAppointment["source"];
      approval_status: ServiceAppointment["approvalStatus"];
      external_provider: string | null;
      external_event_id: string | null;
      inserted: boolean;
    }[]
  >`
    INSERT INTO service.appointments(
      tenant_id, case_id, technician_id, starts_at, ends_at, timezone,
      notes, status, source, approval_status, idempotency_key,
      created_by_user_id
    ) VALUES (
      platform.current_tenant_id(), ${input.caseId}::uuid,
      ${input.technicianId}::uuid, ${startsAt}, ${endsAt},
      ${timezone}, ${notes},
      ${status}, ${source}, ${approvalStatus},
      ${idempotencyKey},
      ${actorUserId}::uuid
    ) ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET
      idempotency_key = EXCLUDED.idempotency_key
    RETURNING id, case_id, technician_id,
      (SELECT full_name FROM service.technicians
       WHERE id = service.appointments.technician_id) AS technician_name,
      starts_at, ends_at, timezone, notes, status, source, approval_status,
      external_provider, external_event_id, (xmax = 0) AS inserted
  `;
  const row = rows[0];
  if (row === undefined)
    throw new Error("Appointment creation returned no row");
  if (
    row.case_id !== input.caseId ||
    row.technician_id !== input.technicianId ||
    row.starts_at.valueOf() !== startsAt.valueOf() ||
    row.ends_at.valueOf() !== endsAt.valueOf() ||
    row.timezone !== timezone ||
    row.notes !== notes ||
    row.source !== source
  )
    throw new TypeError(
      "The idempotency key already belongs to another appointment",
    );
  let resultRow = row;
  if (row.inserted) {
    if (source === "ai_suggestion" && status === "scheduled") {
      const eventId = await createTenantCalendarEventForAppointment(
        sql,
        actorUserId,
        row.id,
      );
      const linked = await sql<(typeof row)[]>`
        UPDATE service.appointments SET external_provider='crm_calendar',
          external_event_id=${eventId}, updated_at=CURRENT_TIMESTAMP
        WHERE id=${row.id}::uuid
        RETURNING id, case_id, technician_id,
          (SELECT full_name FROM service.technicians
           WHERE id=service.appointments.technician_id) AS technician_name,
          starts_at, ends_at, timezone, notes, status, source, approval_status,
          external_provider, external_event_id, false AS inserted
      `;
      if (linked[0] === undefined)
        throw new Error("Calendar-backed appointment could not be linked");
      resultRow = linked[0];
    }
    await sql`
      INSERT INTO service.appointment_history(
        tenant_id, appointment_id, action, new_values, actor_user_id
      ) VALUES (
        platform.current_tenant_id(), ${row.id}::uuid, 'created',
        ${sql.json({
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          status,
          calendarEventId: resultRow.external_event_id,
        })},
        ${actorUserId}::uuid
      )
    `;
  }
  if (status === "scheduled") {
    const cases = await sql<{ status: ServiceCaseStatus }[]>`
      SELECT status FROM service.cases WHERE id = ${input.caseId}::uuid FOR UPDATE
    `;
    if (cases[0]?.status === "awaiting_scheduling")
      await transitionServiceCase(
        sql,
        { userId: actorUserId },
        input.caseId,
        "scheduled",
        "Technician appointment scheduled",
      );
  }
  return appointment(resultRow);
}

export async function approveAppointmentSuggestion(
  sql: postgres.TransactionSql,
  actorUserId: string,
  appointmentId: string,
): Promise<void> {
  const state = await requireFieldService(sql);
  if (
    !state.aiSchedulingEnabled ||
    !state.readiness.calendarCanBook ||
    state.calendarProvider !== "crm_calendar"
  )
    throw new TypeError(
      "Calendar write access is required to approve an AI suggestion",
    );
  const rows = await sql<
    {
      case_id: string;
      technician_id: string;
      starts_at: Date;
      ends_at: Date;
    }[]
  >`
    SELECT case_id, technician_id, starts_at, ends_at
    FROM service.appointments
    WHERE id=${appointmentId}::uuid AND status='suggested'
      AND approval_status='pending' AND external_event_id IS NULL
    FOR UPDATE
  `;
  const row = rows[0];
  if (row === undefined)
    throw new Error("Pending appointment suggestion was not found");
  await assertTenantCalendarAvailability(
    sql,
    row.technician_id,
    row.starts_at,
    row.ends_at,
  );
  const eventId = await createTenantCalendarEventForAppointment(
    sql,
    actorUserId,
    appointmentId,
  );
  const updated = await sql<{ case_id: string }[]>`
    UPDATE service.appointments
    SET status='scheduled', approval_status='approved',
        external_provider='crm_calendar', external_event_id=${eventId},
        updated_at=CURRENT_TIMESTAMP
    WHERE id=${appointmentId}::uuid AND status='suggested'
      AND approval_status='pending' AND external_event_id IS NULL
    RETURNING case_id
  `;
  if (updated[0] === undefined)
    throw new TypeError("The scheduling suggestion changed before approval");
  await sql`
    INSERT INTO service.appointment_history(
      tenant_id, appointment_id, action, new_values, actor_user_id
    ) VALUES (
      platform.current_tenant_id(), ${appointmentId}::uuid, 'approved',
      ${sql.json({ status: "scheduled", calendarEventId: eventId })},
      ${actorUserId}::uuid
    )
  `;
  const cases = await sql<{ status: ServiceCaseStatus }[]>`
    SELECT status FROM service.cases WHERE id = ${row.case_id}::uuid FOR UPDATE
  `;
  if (cases[0]?.status === "awaiting_scheduling")
    await transitionServiceCase(
      sql,
      { userId: actorUserId },
      row.case_id,
      "scheduled",
      "AI suggestion approved",
    );
}

export async function rescheduleServiceAppointment(
  sql: postgres.TransactionSql,
  actorUserId: string,
  appointmentId: string,
  input: {
    readonly technicianId?: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly timezone: string;
    readonly notes?: string | null;
    readonly idempotencyKey: string;
  },
): Promise<ServiceAppointment> {
  const state = await requireFieldService(sql);
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  if (
    !Number.isFinite(startsAt.valueOf()) ||
    !Number.isFinite(endsAt.valueOf()) ||
    endsAt <= startsAt ||
    endsAt.valueOf() - startsAt.valueOf() > 24 * 60 * 60 * 1_000
  )
    throw new TypeError("Choose a valid appointment of up to 24 hours");
  const timezone = validTimezone(input.timezone);
  const idempotencyKey = requiredText(
    input.idempotencyKey,
    "Idempotency key",
    200,
  );
  const rows = await sql<
    {
      id: string;
      case_id: string;
      technician_id: string;
      technician_name: string;
      starts_at: Date;
      ends_at: Date;
      timezone: string;
      notes: string | null;
      status: ServiceAppointment["status"];
      source: ServiceAppointment["source"];
      approval_status: ServiceAppointment["approvalStatus"];
      external_provider: string | null;
      external_event_id: string | null;
    }[]
  >`
    SELECT appointment.id, appointment.case_id, appointment.technician_id,
           technician.full_name AS technician_name, appointment.starts_at,
           appointment.ends_at, appointment.timezone, appointment.notes,
           appointment.status, appointment.source, appointment.approval_status,
           appointment.external_provider, appointment.external_event_id
    FROM service.appointments appointment
    JOIN service.technicians technician ON technician.id=appointment.technician_id
    WHERE appointment.id=${appointmentId}::uuid
      AND appointment.status IN ('suggested','scheduled')
    FOR UPDATE OF appointment
  `;
  const previous = rows[0];
  if (previous === undefined)
    throw new TypeError("A reschedulable appointment was not found");
  const technicianId = input.technicianId ?? previous.technician_id;
  const notes =
    input.notes === undefined
      ? previous.notes
      : nullableText(input.notes, 2_000);
  const priorRequest = await sql<{ new_values: Record<string, unknown> }[]>`
    SELECT new_values FROM service.appointment_history
    WHERE appointment_id=${appointmentId}::uuid AND action='rescheduled'
      AND new_values->>'idempotencyKey'=${idempotencyKey}
    ORDER BY occurred_at DESC, id DESC LIMIT 1
  `;
  if (priorRequest[0] !== undefined) {
    const values = priorRequest[0].new_values;
    if (
      values.startsAt !== startsAt.toISOString() ||
      values.endsAt !== endsAt.toISOString() ||
      values.timezone !== timezone ||
      values.technicianId !== technicianId ||
      values.notes !== notes
    )
      throw new TypeError(
        "The idempotency key already belongs to another reschedule",
      );
    return appointment(previous);
  }
  const technicians = await sql<
    { id: string; full_name: string; linked_user_id: string | null }[]
  >`
    SELECT id, full_name, linked_user_id FROM service.technicians
    WHERE id=${technicianId}::uuid AND active
    FOR SHARE
  `;
  const targetTechnician = technicians[0];
  if (targetTechnician === undefined)
    throw new TypeError("An active technician is required for rescheduling");
  if (
    previous.external_event_id !== null &&
    (previous.external_provider !== "crm_calendar" ||
      !state.readiness.calendarCanBook ||
      state.calendarProvider !== "crm_calendar")
  )
    throw new TypeError(
      "The linked calendar event could not be changed; reconnect write access first",
    );
  if (
    previous.source === "ai_suggestion" ||
    previous.external_event_id !== null
  )
    await assertTenantCalendarAvailability(
      sql,
      technicianId,
      startsAt,
      endsAt,
      previous.external_event_id,
    );
  if (previous.external_event_id !== null) {
    if (targetTechnician.linked_user_id === null)
      throw new TypeError(
        "A calendar-backed appointment requires a linked technician account",
      );
    const calendar = await sql<{ id: string }[]>`
      UPDATE crm.calendar_events SET starts_at=${startsAt}, ends_at=${endsAt},
        timezone=${timezone}, organizer_user_id=${targetTechnician.linked_user_id}::uuid,
        status='confirmed', updated_at=CURRENT_TIMESTAMP
      WHERE id=${previous.external_event_id}::uuid AND status<>'cancelled'
      RETURNING id
    `;
    if (calendar[0] === undefined)
      throw new TypeError(
        "The linked calendar event is missing; the appointment was not changed",
      );
  }
  const updated = await sql<(typeof rows)[number][]>`
    UPDATE service.appointments appointment SET technician_id=${technicianId}::uuid,
      starts_at=${startsAt},
      ends_at=${endsAt}, timezone=${timezone},
      notes=${notes},
      updated_at=CURRENT_TIMESTAMP
    FROM service.technicians technician
    WHERE appointment.id=${appointmentId}::uuid
      AND technician.id=${technicianId}::uuid
    RETURNING appointment.id, appointment.case_id, appointment.technician_id,
      technician.full_name AS technician_name, appointment.starts_at,
      appointment.ends_at, appointment.timezone, appointment.notes,
      appointment.status, appointment.source, appointment.approval_status,
      appointment.external_provider, appointment.external_event_id
  `;
  const row = updated[0];
  if (row === undefined)
    throw new TypeError(
      "The appointment changed before it could be rescheduled",
    );
  await sql`
    INSERT INTO service.appointment_history(
      tenant_id, appointment_id, action, previous_values, new_values,
      actor_user_id
    ) VALUES (
      platform.current_tenant_id(), ${appointmentId}::uuid, 'rescheduled',
      ${sql.json({
        startsAt: previous.starts_at.toISOString(),
        endsAt: previous.ends_at.toISOString(),
        timezone: previous.timezone,
        technicianId: previous.technician_id,
        notes: previous.notes,
      })},
      ${sql.json({
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        timezone,
        technicianId,
        notes,
        idempotencyKey,
      })}, ${actorUserId}::uuid
    )
  `;
  return appointment(row);
}

export async function cancelServiceAppointment(
  sql: postgres.TransactionSql,
  actorUserId: string,
  appointmentId: string,
  reason?: string,
): Promise<boolean> {
  const state = await requireFieldService(sql);
  const current = await sql<
    {
      id: string;
      case_id: string;
      external_provider: string | null;
      external_event_id: string | null;
    }[]
  >`
    SELECT id, case_id, external_provider, external_event_id
    FROM service.appointments
    WHERE id=${appointmentId}::uuid AND status IN ('suggested','scheduled')
    FOR UPDATE
  `;
  const existing = current[0];
  if (existing === undefined) return false;
  if (
    existing.external_event_id !== null &&
    (existing.external_provider !== "crm_calendar" ||
      !state.readiness.calendarCanBook ||
      state.calendarProvider !== "crm_calendar")
  )
    throw new TypeError(
      "The linked calendar event could not be cancelled; reconnect write access first",
    );
  if (existing.external_event_id !== null) {
    const events = await sql<{ id: string }[]>`
      UPDATE crm.calendar_events SET status='cancelled', updated_at=CURRENT_TIMESTAMP
      WHERE id=${existing.external_event_id}::uuid AND status<>'cancelled'
      RETURNING id
    `;
    if (events[0] === undefined)
      throw new TypeError(
        "The linked calendar event is missing; the appointment was not cancelled",
      );
  }
  const rows = await sql<{ id: string; case_id: string }[]>`
    UPDATE service.appointments
    SET status = 'cancelled',
        approval_status=CASE WHEN approval_status='pending' THEN 'rejected'
          ELSE approval_status END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${appointmentId}::uuid
      AND status IN ('suggested','scheduled')
    RETURNING id, case_id
  `;
  if (rows.length === 0) return false;
  await sql`
    INSERT INTO service.appointment_history(
      tenant_id, appointment_id, action, new_values, actor_user_id
    ) VALUES (
      platform.current_tenant_id(), ${appointmentId}::uuid, 'cancelled',
      ${sql.json({ reason: nullableText(reason, 1_000) })}, ${actorUserId}::uuid
    )
  `;
  const remaining = await sql<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM service.appointments
      WHERE case_id=${existing.case_id}::uuid
        AND status IN ('scheduled','in_progress')
    ) AS present
  `;
  const cases = await sql<{ status: ServiceCaseStatus }[]>`
    SELECT status FROM service.cases WHERE id=${existing.case_id}::uuid FOR UPDATE
  `;
  if (cases[0]?.status === "scheduled" && remaining[0]?.present !== true)
    await transitionServiceCase(
      sql,
      { userId: actorUserId },
      existing.case_id,
      "awaiting_scheduling",
      "Appointment cancelled",
    );
  return true;
}

function visit(row: {
  id: string;
  case_id: string;
  appointment_id: string | null;
  technician_id: string;
  visit_number: number;
  status: ServiceVisit["status"];
  arrival_at: Date | null;
  departure_at: Date | null;
  arrival_signature_object_id?: string | null;
  departure_signature_object_id?: string | null;
  arrival_identity?: Readonly<Record<string, unknown>> | null;
  departure_identity?: Readonly<Record<string, unknown>> | null;
}): ServiceVisit {
  return {
    id: row.id,
    caseId: row.case_id,
    appointmentId: row.appointment_id,
    technicianId: row.technician_id,
    visitNumber: row.visit_number,
    status: row.status,
    arrivalAt: row.arrival_at?.toISOString() ?? null,
    departureAt: row.departure_at?.toISOString() ?? null,
    durationSeconds:
      row.arrival_at === null || row.departure_at === null
        ? null
        : Math.max(
            0,
            Math.round(
              (row.departure_at.valueOf() - row.arrival_at.valueOf()) / 1_000,
            ),
          ),
    arrivalSignatureObjectId: row.arrival_signature_object_id ?? null,
    departureSignatureObjectId: row.departure_signature_object_id ?? null,
    arrivalIdentity: row.arrival_identity ?? null,
    departureIdentity: row.departure_identity ?? null,
  };
}

export async function createServiceVisit(
  sql: postgres.TransactionSql,
  actorUserId: string,
  caseId: string,
  technicianId: string,
  appointmentId?: string,
  requestId: string = randomUUID(),
): Promise<ServiceVisit> {
  await requireFieldService(sql);
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(platform.current_tenant_id()::text || ':' || ${caseId}, 0)
    )
  `;
  const rows = await sql<
    {
      id: string;
      case_id: string;
      appointment_id: string | null;
      technician_id: string;
      visit_number: number;
      status: ServiceVisit["status"];
      arrival_at: Date | null;
      departure_at: Date | null;
    }[]
  >`
    INSERT INTO service.visits(
      tenant_id, case_id, appointment_id, technician_id, visit_number
    ) SELECT
      platform.current_tenant_id(), service_case.id, appointment.id,
      technician.id,
      (SELECT coalesce(max(visit_number), 0) + 1
       FROM service.visits WHERE case_id = service_case.id)
    FROM service.cases service_case
    JOIN service.technicians technician
      ON technician.tenant_id=service_case.tenant_id
     AND technician.id=${technicianId}::uuid AND technician.active
    LEFT JOIN service.appointments appointment
      ON appointment.tenant_id=service_case.tenant_id
     AND appointment.id=${appointmentId ?? null}::uuid
     AND appointment.case_id=service_case.id
     AND appointment.technician_id=technician.id
     AND appointment.status IN ('scheduled','in_progress')
    WHERE service_case.id=${caseId}::uuid
      AND service_case.status NOT IN ('intake_draft','closed','cancelled')
      AND (${appointmentId ?? null}::uuid IS NULL OR appointment.id IS NOT NULL)
      AND (
        coalesce(current_setting('app.current_role', true), '') <> 'technician'
        OR appointment.id IS NOT NULL
      )
    RETURNING id, case_id, appointment_id, technician_id, visit_number,
      status, arrival_at, departure_at
  `;
  const row = rows[0];
  if (row === undefined)
    throw new TypeError(
      "The case, active technician, or matching scheduled appointment was not found",
    );
  await sql`
    INSERT INTO audit.records(
      tenant_id, actor_user_id, action, target_type, target_id, request_id, metadata
    ) VALUES (
      platform.current_tenant_id(), ${actorUserId}::uuid,
      'field_service.visit.created', 'service_visit', ${row.id}::uuid,
      ${requestId}, ${sql.json({
        caseId: row.case_id,
        technicianId: row.technician_id,
        appointmentId: row.appointment_id,
        visitNumber: row.visit_number,
      })}
    )
  `;
  return visit(row);
}

export async function identifyTechnicianSession(
  sql: postgres.TransactionSql,
  input: {
    readonly visitId: string;
    readonly technicianId: string;
    readonly fullName: string;
    readonly employeeIdentifier?: string | null;
    readonly contactInformation?: string | null;
    readonly requestId?: string;
  },
): Promise<string> {
  const feature = await requireFieldService(sql);
  const sessionRows = await sql<
    { session_id: string; absolute_expires_at: Date }[]
  >`
    SELECT session_id, absolute_expires_at
    FROM service.lock_current_technician_session_context()
  `;
  const session = sessionRows[0];
  if (session === undefined)
    throw new TypeError("The authenticated session is no longer valid");
  const existing = await sql<
    {
      id: string;
      technician_id: string;
      full_name: string;
      employee_identifier: string | null;
    }[]
  >`
    SELECT id, technician_id, full_name, employee_identifier
    FROM service.technician_session_identities
    WHERE auth_session_id = ${session.session_id}::uuid
      AND visit_id = ${input.visitId}::uuid
  `;
  const prior = existing[0];
  const fullName = requiredText(input.fullName, "Technician name", 160);
  const identifier = nullableText(input.employeeIdentifier, 100);
  if (prior !== undefined) {
    if (
      prior.technician_id !== input.technicianId ||
      prior.full_name !== fullName ||
      prior.employee_identifier !== identifier
    )
      throw new TypeError(
        "This visit session is already bound to another identity",
      );
    return prior.id;
  }
  const rows = await sql<{ id: string }[]>`
    INSERT INTO service.technician_session_identities(
      tenant_id, auth_session_id, visit_id, technician_id, full_name,
      employee_identifier, contact_information, verification_state,
      server_nonce, expires_at
    ) SELECT
      platform.current_tenant_id(), ${session.session_id}::uuid, visit.id,
      technician.id,
      ${fullName}, ${identifier}, ${nullableText(input.contactInformation, 320)},
      CASE
        WHEN technician.linked_user_id=platform.current_user_id()
          THEN technician.identity_verification
        ELSE 'self_declared'
      END,
      ${randomUUID()},
      LEAST(${session.absolute_expires_at}, CURRENT_TIMESTAMP + interval '12 hours')
    FROM service.visits visit
    JOIN service.technicians technician ON technician.id = ${input.technicianId}::uuid
      AND technician.id = visit.technician_id AND technician.active
    WHERE visit.tenant_id = platform.current_tenant_id()
      AND ${session.absolute_expires_at} > clock_timestamp()
      AND visit.status IN ('assigned','arrived')
      AND lower(btrim(technician.full_name)) = lower(btrim(${fullName}))
      AND (
        technician.employee_identifier IS NULL
        OR technician.employee_identifier = ${identifier}
      )
      AND (
        technician.linked_user_id = platform.current_user_id()
        OR (
          ${feature.sharedTechnicianLoginEnabled}
          AND coalesce(current_setting('app.current_role', true), '') = 'technician'
        )
      )
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (id === undefined)
    throw new TypeError(
      "The session is not permitted to identify as the assigned technician",
    );
  await sql`
    INSERT INTO audit.records(
      tenant_id, actor_user_id, action, target_type, target_id, request_id, metadata
    ) VALUES (
      platform.current_tenant_id(), platform.current_user_id(),
      'field_service.technician.identified', 'technician_identity', ${id}::uuid,
      ${input.requestId ?? randomUUID()},
      ${sql.json({ visitId: input.visitId, technicianId: input.technicianId })}
    )
  `;
  return id;
}

export async function signVisitAttendance(
  sql: postgres.TransactionSql,
  input: {
    readonly visitId: string;
    readonly signatureObjectId: string;
    readonly kind: "arrival" | "departure";
    readonly requestId?: string;
  },
): Promise<ServiceVisit> {
  await requireFieldService(sql);
  const sessionRows = await sql<{ session_id: string }[]>`
    SELECT session_id FROM service.lock_current_technician_session_context()
  `;
  const session = sessionRows[0];
  if (session === undefined)
    throw new TypeError("The authenticated session is no longer valid");
  const identities = await sql<
    {
      technician_id: string;
      identity_id: string;
      identity: Record<string, unknown>;
    }[]
  >`
    SELECT identity.technician_id, identity.id AS identity_id,
      jsonb_build_object(
        'identityId', identity.id, 'technicianId', identity.technician_id,
        'fullName', identity.full_name,
        'employeeIdentifier', identity.employee_identifier,
        'verificationState', identity.verification_state
      ) AS identity
    FROM service.technician_session_identities identity
    JOIN service.visits identity_visit ON identity_visit.id=identity.visit_id
    JOIN service.report_attachments attachment
      ON attachment.tenant_id=identity.tenant_id
     AND attachment.case_id=identity_visit.case_id
     AND attachment.visit_id=identity.visit_id
     AND attachment.object_id=${input.signatureObjectId}::uuid
     AND attachment.category=${`${input.kind}_signature`}
     AND attachment.source='technician'
     AND attachment.processing_status='available'
    JOIN objects.object_metadata object ON object.id = ${input.signatureObjectId}::uuid
      AND object.status = 'available' AND object.content_type IN ('image/png','image/jpeg','image/webp')
    WHERE identity.auth_session_id = ${session.session_id}::uuid
      AND identity.visit_id = ${input.visitId}::uuid
      AND identity.expires_at > CURRENT_TIMESTAMP
  `;
  const identity = identities[0];
  if (identity === undefined)
    throw new TypeError("Identify the assigned technician before signing");
  const current = await sql<
    {
      id: string;
      case_id: string;
      appointment_id: string | null;
      technician_id: string;
      visit_number: number;
      status: ServiceVisit["status"];
      arrival_at: Date | null;
      departure_at: Date | null;
      arrival_signature_object_id: string | null;
      departure_signature_object_id: string | null;
    }[]
  >`
    SELECT id, case_id, appointment_id, technician_id, visit_number, status,
           arrival_at, departure_at, arrival_signature_object_id,
           departure_signature_object_id
    FROM service.visits WHERE id = ${input.visitId}::uuid FOR UPDATE
  `;
  const row = current[0];
  if (row?.technician_id !== identity.technician_id)
    throw new TypeError("The technician is not assigned to this visit");
  const existingObject =
    input.kind === "arrival"
      ? row.arrival_signature_object_id
      : row.departure_signature_object_id;
  if (existingObject !== null) {
    if (existingObject !== input.signatureObjectId)
      throw new TypeError("A signed attendance record cannot be replaced");
    return visit(row);
  }
  if (input.kind === "departure" && row.arrival_at === null)
    throw new TypeError("Departure cannot be signed before arrival");
  if (input.kind === "arrival") {
    await sql`
      UPDATE service.visits SET
        arrival_at = clock_timestamp(),
        arrival_signature_object_id = ${input.signatureObjectId}::uuid,
        arrival_identity = ${sql.json(databaseJson(identity.identity))}, status = 'arrived',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${input.visitId}::uuid AND arrival_at IS NULL
    `;
  } else {
    await sql`
      UPDATE service.visits SET
        departure_at = clock_timestamp(),
        departure_signature_object_id = ${input.signatureObjectId}::uuid,
        departure_identity = ${sql.json(databaseJson(identity.identity))}, status = 'departed',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${input.visitId}::uuid AND departure_at IS NULL
    `;
  }
  const updated = await sql<
    {
      id: string;
      case_id: string;
      appointment_id: string | null;
      technician_id: string;
      visit_number: number;
      status: ServiceVisit["status"];
      arrival_at: Date | null;
      departure_at: Date | null;
    }[]
  >`
    SELECT id, case_id, appointment_id, technician_id, visit_number, status,
           arrival_at, departure_at
    FROM service.visits WHERE id = ${input.visitId}::uuid
  `;
  const updatedRow = updated[0];
  if (updatedRow === undefined)
    throw new Error("Signed visit could not be read");
  await sql`
    INSERT INTO audit.records(
      tenant_id, actor_user_id, action, target_type, target_id, request_id, metadata
    ) VALUES (
      platform.current_tenant_id(), platform.current_user_id(),
      ${`field_service.visit.${input.kind}_signed`}, 'service_visit',
      ${input.visitId}::uuid, ${input.requestId ?? randomUUID()},
      ${sql.json({
        caseId: row.case_id,
        technicianId: row.technician_id,
        identityId: identity.identity_id,
        signatureObjectId: input.signatureObjectId,
      })}
    )
  `;
  return visit(updatedRow);
}

/**
 * Serializes attendance retries and returns the durable result of an earlier
 * request. Reusing a key for a different visit or attendance kind is rejected.
 */
export async function beginVisitAttendanceRequest(
  sql: postgres.TransactionSql,
  input: {
    readonly visitId: string;
    readonly kind: "arrival" | "departure";
    readonly requestId: string;
  },
): Promise<ServiceVisit | undefined> {
  await requireFieldService(sql);
  const key = requiredText(input.requestId, "Idempotency key", 128);
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(platform.current_tenant_id()::text || ':attendance:' || ${key}, 0)
    )
  `;
  const prior = await sql<
    {
      action: string;
      target_id: string;
      id: string | null;
      case_id: string | null;
      appointment_id: string | null;
      technician_id: string | null;
      visit_number: number | null;
      status: ServiceVisit["status"] | null;
      arrival_at: Date | null;
      departure_at: Date | null;
      arrival_signature_object_id: string | null;
      departure_signature_object_id: string | null;
      arrival_identity: Readonly<Record<string, unknown>> | null;
      departure_identity: Readonly<Record<string, unknown>> | null;
    }[]
  >`
    SELECT audit.action, audit.target_id,
           visit.id, visit.case_id, visit.appointment_id, visit.technician_id,
           visit.visit_number, visit.status, visit.arrival_at, visit.departure_at,
           visit.arrival_signature_object_id, visit.departure_signature_object_id,
           visit.arrival_identity, visit.departure_identity
    FROM audit.records audit
    LEFT JOIN service.visits visit
      ON visit.id=audit.target_id AND audit.target_type='service_visit'
    WHERE audit.request_id=${key}
      AND audit.action LIKE 'field_service.visit.%_signed'
    ORDER BY audit.occurred_at, audit.id
    LIMIT 1
  `;
  const existing = prior[0];
  if (existing === undefined) return undefined;
  if (
    existing.target_id !== input.visitId ||
    existing.action !== `field_service.visit.${input.kind}_signed`
  )
    throw new TypeError(
      "Idempotency key was already used for another attendance action",
    );
  if (
    existing.id === null ||
    existing.case_id === null ||
    existing.technician_id === null ||
    existing.visit_number === null ||
    existing.status === null
  )
    throw new Error("The prior attendance result is no longer available");
  return visit({
    id: existing.id,
    case_id: existing.case_id,
    appointment_id: existing.appointment_id,
    technician_id: existing.technician_id,
    visit_number: existing.visit_number,
    status: existing.status,
    arrival_at: existing.arrival_at,
    departure_at: existing.departure_at,
    arrival_signature_object_id: existing.arrival_signature_object_id,
    departure_signature_object_id: existing.departure_signature_object_id,
    arrival_identity: existing.arrival_identity,
    departure_identity: existing.departure_identity,
  });
}

function reportRevision(row: {
  id: string;
  report_id: string;
  version: number;
  status: ReportRevision["status"];
  diagnosis: string | null;
  work_performed: string | null;
  part_replaced: boolean | null;
  replacement_part_details: string | null;
  technician_notes: string | null;
  finalized_at: Date | null;
}): ReportRevision {
  return {
    id: row.id,
    reportId: row.report_id,
    version: row.version,
    status: row.status,
    diagnosis: row.diagnosis,
    workPerformed: row.work_performed,
    partReplaced: row.part_replaced,
    replacementPartDetails: row.replacement_part_details,
    technicianNotes: row.technician_notes,
    finalizedAt: row.finalized_at?.toISOString() ?? null,
  };
}

interface ServiceReportSummaryRow {
  readonly id: string;
  readonly report_id: string;
  readonly version: number;
  readonly status: ServiceReportStatus;
  readonly case_id: string;
  readonly case_reference: string;
  readonly case_title: string;
  readonly customer_contact_id: string;
  readonly customer_name: string;
  readonly visit_id: string;
  readonly visit_number: number;
  readonly technician_id: string;
  readonly technician_name: string;
  readonly finalized_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function serviceReportSummary(
  row: ServiceReportSummaryRow,
): ServiceReportSummary {
  return {
    id: row.id,
    reportId: row.report_id,
    version: row.version,
    status: row.status,
    caseId: row.case_id,
    caseReference: row.case_reference,
    caseTitle: row.case_title,
    customerContactId: row.customer_contact_id,
    customerName: row.customer_name,
    visitId: row.visit_id,
    visitNumber: row.visit_number,
    technicianId: row.technician_id,
    technicianName: row.technician_name,
    finalizedAt: row.finalized_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Lists report revisions visible to the current tenant and, for technician
 * sessions, only the cases allowed by the existing PostgreSQL RLS policies.
 */
export async function listServiceReportPage(
  sql: postgres.TransactionSql,
  options: {
    readonly status?: ServiceReportStatus;
    readonly query?: string;
    readonly limit?: number;
    readonly cursor?: ServiceReportCursor;
  } = {},
): Promise<ServiceReportPage> {
  await requireFieldService(sql);
  const query = options.query?.trim() ?? "";
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const cursorDate =
    options.cursor === undefined
      ? undefined
      : new Date(options.cursor.updatedAt);
  if (cursorDate !== undefined && Number.isNaN(cursorDate.valueOf()))
    throw new TypeError("Service-report cursor timestamp is invalid");
  const rows = await sql.unsafe<ServiceReportSummaryRow[]>(
    `SELECT revision.id, revision.report_id, revision.version, revision.status,
            report.case_id, service_case.reference AS case_reference,
            service_case.title AS case_title,
            service_case.customer_contact_id, customer.name AS customer_name,
            report.visit_id, visit.visit_number,
            visit.technician_id, technician.full_name AS technician_name,
            revision.finalized_at, revision.created_at, revision.updated_at
       FROM service.report_revisions revision
       JOIN service.reports report
         ON report.tenant_id = revision.tenant_id
        AND report.id = revision.report_id
       JOIN service.cases service_case
         ON service_case.tenant_id = report.tenant_id
        AND service_case.id = report.case_id
       JOIN crm.contacts customer
         ON customer.tenant_id = service_case.tenant_id
        AND customer.id = service_case.customer_contact_id
       JOIN service.visits visit
         ON visit.tenant_id = report.tenant_id
        AND visit.id = report.visit_id
       JOIN service.technicians technician
         ON technician.tenant_id = visit.tenant_id
        AND technician.id = visit.technician_id
      WHERE revision.tenant_id = platform.current_tenant_id()
        AND ($1::text IS NULL OR revision.status = $1)
        AND ($2 = '' OR service_case.reference ILIKE '%' || $2 || '%'
          OR service_case.title ILIKE '%' || $2 || '%'
          OR customer.name ILIKE '%' || $2 || '%'
          OR technician.full_name ILIKE '%' || $2 || '%')
        AND ($3::timestamptz IS NULL OR
          (revision.updated_at, revision.id) <
          ($3::timestamptz, $4::uuid))
      ORDER BY revision.updated_at DESC, revision.id DESC
      LIMIT $5`,
    [
      options.status ?? null,
      query,
      cursorDate?.toISOString() ?? null,
      options.cursor?.id ?? null,
      limit + 1,
    ],
  );
  const hasMore = rows.length > limit;
  const selected = hasMore ? rows.slice(0, limit) : rows;
  const last = selected.at(-1);
  return {
    reports: selected.map(serviceReportSummary),
    nextCursor:
      hasMore && last !== undefined
        ? { updatedAt: last.updated_at.toISOString(), id: last.id }
        : null,
  };
}

export async function openReportDraft(
  sql: postgres.TransactionSql,
  actorUserId: string,
  caseId: string,
  visitId: string,
  requestId: string = randomUUID(),
): Promise<ReportRevision> {
  await requireFieldService(sql);
  const reports = await sql<{ id: string }[]>`
    INSERT INTO service.reports(tenant_id, case_id, visit_id)
    SELECT platform.current_tenant_id(), visit.case_id, visit.id
    FROM service.visits visit
    WHERE visit.id=${visitId}::uuid AND visit.case_id=${caseId}::uuid
      AND visit.status <> 'cancelled'
    ON CONFLICT (tenant_id, visit_id) DO UPDATE SET visit_id = EXCLUDED.visit_id
    RETURNING id
  `;
  const reportId = reports[0]?.id;
  if (reportId === undefined)
    throw new Error("Report creation returned no identifier");
  const drafts = await sql<
    {
      id: string;
      report_id: string;
      version: number;
      status: ReportRevision["status"];
      diagnosis: string | null;
      work_performed: string | null;
      part_replaced: boolean | null;
      replacement_part_details: string | null;
      technician_notes: string | null;
      finalized_at: Date | null;
    }[]
  >`
    SELECT id, report_id, version, status, diagnosis, work_performed,
           part_replaced, replacement_part_details, technician_notes, finalized_at
    FROM service.report_revisions
    WHERE report_id = ${reportId}::uuid AND status IN ('draft','review_required')
    ORDER BY version DESC LIMIT 1
  `;
  if (drafts[0] !== undefined) return reportRevision(drafts[0]);
  const rows = await sql<
    {
      id: string;
      report_id: string;
      version: number;
      status: ReportRevision["status"];
      diagnosis: string | null;
      work_performed: string | null;
      part_replaced: boolean | null;
      replacement_part_details: string | null;
      technician_notes: string | null;
      finalized_at: Date | null;
    }[]
  >`
    INSERT INTO service.report_revisions(
      tenant_id, report_id, version, created_by_user_id,
      customer_snapshot, product_snapshot, supersedes_revision_id
    ) SELECT
      platform.current_tenant_id(), ${reportId}::uuid,
      coalesce(max(version), 0) + 1, ${actorUserId}::uuid,
      jsonb_build_object('contactId', service_case.customer_contact_id),
      jsonb_build_object(
        'type', service_case.product_type,
        'model', service_case.product_model,
        'serialNumber', service_case.serial_number
      ),
      (SELECT prior.id FROM service.report_revisions prior
       WHERE prior.report_id = ${reportId}::uuid AND prior.status = 'finalized'
       ORDER BY prior.version DESC LIMIT 1)
    FROM service.reports report
    JOIN service.cases service_case ON service_case.id = report.case_id
    LEFT JOIN service.report_revisions existing ON existing.report_id = report.id
    WHERE report.id = ${reportId}::uuid
    GROUP BY service_case.customer_contact_id, service_case.product_type,
             service_case.product_model, service_case.serial_number
    RETURNING id, report_id, version, status, diagnosis, work_performed,
      part_replaced, replacement_part_details, technician_notes, finalized_at
  `;
  const row = rows[0];
  if (row === undefined)
    throw new Error("Report draft creation returned no row");
  await sql`
    INSERT INTO audit.records(
      tenant_id, actor_user_id, action, target_type, target_id, request_id, metadata
    ) VALUES (
      platform.current_tenant_id(), ${actorUserId}::uuid,
      'field_service.report.revision_created', 'report_revision', ${row.id}::uuid,
      ${requestId}, ${sql.json({ caseId, visitId, version: row.version })}
    )
  `;
  return reportRevision(row);
}

export async function saveReportDraft(
  sql: postgres.TransactionSql,
  actorUserId: string,
  revisionId: string,
  input: {
    readonly diagnosis?: string | null;
    readonly workPerformed?: string | null;
    readonly partReplaced?: boolean | null;
    readonly replacementPartDetails?: string | null;
    readonly technicianNotes?: string | null;
    readonly customerSnapshot?: Readonly<Record<string, unknown>>;
    readonly productSnapshot?: Readonly<Record<string, unknown>>;
  },
  requestId: string = randomUUID(),
): Promise<ReportRevision> {
  await requireFieldService(sql);
  const rows = await sql<
    {
      id: string;
      report_id: string;
      version: number;
      status: ReportRevision["status"];
      diagnosis: string | null;
      work_performed: string | null;
      part_replaced: boolean | null;
      replacement_part_details: string | null;
      technician_notes: string | null;
      finalized_at: Date | null;
    }[]
  >`
    UPDATE service.report_revisions SET
      diagnosis = CASE WHEN ${input.diagnosis !== undefined}
        THEN ${nullableText(input.diagnosis, 10_000)} ELSE diagnosis END,
      work_performed = CASE WHEN ${input.workPerformed !== undefined}
        THEN ${nullableText(input.workPerformed, 10_000)} ELSE work_performed END,
      part_replaced = CASE WHEN ${input.partReplaced !== undefined}
        THEN ${input.partReplaced ?? null} ELSE part_replaced END,
      replacement_part_details = CASE WHEN ${input.replacementPartDetails !== undefined}
        THEN ${nullableText(input.replacementPartDetails, 2_000)}
        ELSE replacement_part_details END,
      technician_notes = CASE WHEN ${input.technicianNotes !== undefined}
        THEN ${nullableText(input.technicianNotes, 10_000)} ELSE technician_notes END,
      customer_snapshot = CASE WHEN ${input.customerSnapshot !== undefined}
        THEN ${sql.json(databaseJson(input.customerSnapshot ?? {}))} ELSE customer_snapshot END,
      product_snapshot = CASE WHEN ${input.productSnapshot !== undefined}
        THEN ${sql.json(databaseJson(input.productSnapshot ?? {}))} ELSE product_snapshot END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${revisionId}::uuid AND status IN ('draft','review_required')
    RETURNING id, report_id, version, status, diagnosis, work_performed,
      part_replaced, replacement_part_details, technician_notes, finalized_at
  `;
  const row = rows[0];
  if (row === undefined)
    throw new TypeError("Editable report revision was not found");
  const changedFields: string[] = [];
  if (input.diagnosis !== undefined) changedFields.push("diagnosis");
  if (input.workPerformed !== undefined) changedFields.push("workPerformed");
  if (input.partReplaced !== undefined) changedFields.push("partReplaced");
  if (input.replacementPartDetails !== undefined)
    changedFields.push("replacementPartDetails");
  if (input.technicianNotes !== undefined)
    changedFields.push("technicianNotes");
  if (input.customerSnapshot !== undefined)
    changedFields.push("customerSnapshot");
  if (input.productSnapshot !== undefined)
    changedFields.push("productSnapshot");
  await sql`
    INSERT INTO audit.records(
      tenant_id, actor_user_id, action, target_type, target_id, request_id, metadata
    ) VALUES (
      platform.current_tenant_id(), ${actorUserId}::uuid,
      'field_service.report.draft_saved', 'report_revision', ${revisionId}::uuid,
      ${requestId}, ${sql.json({ changedFields: changedFields.sort() })}
    )
  `;
  return reportRevision(row);
}

export async function linkReportAttachment(
  sql: postgres.TransactionSql,
  actorUserId: string | null,
  input: {
    readonly caseId: string;
    readonly visitId?: string | null;
    readonly reportRevisionId?: string | null;
    readonly messageId?: string | null;
    readonly objectId: string;
    readonly category:
      | "fault"
      | "module"
      | "product_label"
      | "repair"
      | "environment"
      | "document"
      | "customer_photo"
      | "arrival_signature"
      | "departure_signature";
    readonly source: "customer" | "technician" | "operator" | "system";
    readonly caption?: string | null;
  },
): Promise<string> {
  await requireFieldService(sql);
  const rows = await sql<{ id: string }[]>`
    INSERT INTO service.report_attachments(
      tenant_id, case_id, visit_id, report_revision_id, message_id, object_id,
      category, source, processing_status, caption, created_by_user_id
    ) SELECT
      platform.current_tenant_id(), ${input.caseId}::uuid,
      ${input.visitId ?? null}::uuid, ${input.reportRevisionId ?? null}::uuid,
      ${input.messageId ?? null}::uuid, object.id, ${input.category}, ${input.source},
      CASE WHEN object.status = 'available' THEN 'available' ELSE 'pending' END,
      ${nullableText(input.caption, 500)}, ${actorUserId}::uuid
    FROM objects.object_metadata object
    WHERE object.id = ${input.objectId}::uuid AND object.deleted_at IS NULL
    ON CONFLICT (tenant_id, object_id, case_id) DO UPDATE SET
      caption = coalesce(EXCLUDED.caption, service.report_attachments.caption)
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (id === undefined) throw new TypeError("Attachment object was not found");
  return id;
}

export async function queueAttachmentOcr(
  sql: postgres.TransactionSql,
  attachmentId: string,
  sourceChecksum: string,
): Promise<string> {
  const feature = await requireFieldService(sql);
  if (!feature.ocrEnabled)
    throw new TypeError("OCR is not enabled for this tenant");
  const rows = await sql<{ id: string; attempt: number }[]>`
    INSERT INTO service.ocr_results(
      tenant_id, attachment_id, source_checksum, attempt,
      confirmed_fields, manually_confirmed_fields
    ) VALUES (
      platform.current_tenant_id(), ${attachmentId}::uuid,
      ${requiredText(sourceChecksum, "Source checksum", 128)},
      (SELECT coalesce(max(attempt), 0) + 1 FROM service.ocr_results
       WHERE attachment_id = ${attachmentId}::uuid),
      coalesce((SELECT confirmed_fields FROM service.ocr_results
        WHERE attachment_id=${attachmentId}::uuid
        ORDER BY attempt DESC, id DESC LIMIT 1), '{}'::jsonb),
      coalesce((SELECT manually_confirmed_fields FROM service.ocr_results
        WHERE attachment_id=${attachmentId}::uuid
        ORDER BY attempt DESC, id DESC LIMIT 1), ARRAY[]::text[])
    ) RETURNING id, attempt
  `;
  const row = rows[0];
  if (row === undefined)
    throw new Error("OCR record creation returned no identifier");
  await sql`
    INSERT INTO ops.jobs(
      tenant_id, queue, job_type, reference_type, reference_id, payload,
      idempotency_key, max_attempts
    ) VALUES (
      platform.current_tenant_id(), 'field_service', 'field_service.ocr',
      'ocr_result', ${row.id}::uuid,
      ${sql.json({ ocrResultId: row.id, attachmentId })},
      ${`field-service:ocr:${attachmentId}:${String(row.attempt)}`}, 5
    ) ON CONFLICT DO NOTHING
  `;
  return row.id;
}

interface ServiceOcrQueueItemRow {
  readonly id: string;
  readonly attachment_id: string;
  readonly object_id: string;
  readonly case_id: string;
  readonly case_reference: string;
  readonly case_title: string;
  readonly customer_name: string;
  readonly service_location_name: string | null;
  readonly category: string;
  readonly source: string;
  readonly attachment_processing_status: string;
  readonly evidence_status: ServiceOcrQueueItem["evidenceStatus"];
  readonly content_type: string;
  readonly status: ServiceOcrStatus;
  readonly proposed_fields: unknown;
  readonly confirmed_fields: unknown;
  readonly manually_confirmed_fields: string[];
  readonly confidence: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly provenance: unknown;
  readonly error_safe: string | null;
  readonly attempt: number;
  readonly created_at: Date;
  readonly completed_at: Date | null;
  readonly sort_priority: number;
}

function serviceOcrQueueItem(row: ServiceOcrQueueItemRow): ServiceOcrQueueItem {
  return {
    id: row.id,
    attachmentId: row.attachment_id,
    objectId: row.object_id,
    caseId: row.case_id,
    caseReference: row.case_reference,
    caseTitle: row.case_title,
    customerName: row.customer_name,
    serviceLocationName: row.service_location_name,
    category: row.category,
    source: row.source,
    attachmentProcessingStatus: row.attachment_processing_status,
    evidenceStatus: row.evidence_status,
    contentType: row.content_type,
    status: row.status,
    proposedFields: storedTextRecord(row.proposed_fields),
    confirmedFields: storedTextRecord(row.confirmed_fields),
    manuallyConfirmedFields: row.manually_confirmed_fields,
    confidence: row.confidence === null ? null : Number(row.confidence),
    provider: row.provider,
    model: row.model,
    provenance: objectRecord(row.provenance),
    errorSafe: row.error_safe,
    attempt: row.attempt,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

/**
 * Tenant-scoped operator projection of the latest OCR attempt for each piece
 * of service evidence. Counts are exact for the current search across every
 * visible latest attempt; the selected view is applied only to the page rows.
 */
export async function listServiceOcrQueuePage(
  sql: postgres.TransactionSql,
  options: {
    readonly view?: ServiceOcrQueueView;
    readonly query?: string;
    readonly limit?: number;
    readonly cursor?: ServiceOcrQueueCursor;
  } = {},
): Promise<ServiceOcrQueuePage> {
  const view = options.view ?? "all";
  const query = options.query?.trim() ?? "";
  const limit = options.limit ?? 50;
  if (!serviceOcrQueueViews.includes(view))
    throw new TypeError("OCR queue view is invalid");
  if (query.length > 500) throw new TypeError("OCR queue search is too long");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new TypeError("OCR queue limit is out of range");
  if (
    options.cursor !== undefined &&
    !serviceOcrStatuses.includes(options.cursor.status)
  )
    throw new TypeError("OCR queue cursor status is invalid");
  const cursorDate =
    options.cursor === undefined
      ? undefined
      : new Date(options.cursor.createdAt);
  if (cursorDate !== undefined && Number.isNaN(cursorDate.valueOf()))
    throw new TypeError("OCR queue cursor timestamp is invalid");

  await requireFieldService(sql);
  const countRows = await sql<
    {
      all_count: number;
      attention_count: number;
      in_flight_count: number;
      completed_count: number;
    }[]
  >`
    WITH parameters AS (
      SELECT ${query}::text AS search_query
    ), visible_results AS (
      SELECT result.status
      FROM service.ocr_results result
      JOIN service.report_attachments attachment
        ON attachment.id=result.attachment_id
       AND attachment.tenant_id=result.tenant_id
      JOIN service.cases service_case
        ON service_case.id=attachment.case_id
       AND service_case.tenant_id=attachment.tenant_id
      JOIN crm.contacts contact
        ON contact.id=service_case.customer_contact_id
       AND contact.tenant_id=service_case.tenant_id
      LEFT JOIN crm.service_locations location
        ON location.id=service_case.service_location_id
       AND location.tenant_id=service_case.tenant_id
      JOIN objects.object_metadata object
        ON object.id=attachment.object_id
       AND object.tenant_id=attachment.tenant_id
      CROSS JOIN parameters
      WHERE result.tenant_id=platform.current_tenant_id()
        AND result.attempt=(
          SELECT max(latest.attempt)
          FROM service.ocr_results latest
          WHERE latest.tenant_id=result.tenant_id
            AND latest.attachment_id=result.attachment_id
        )
        AND (parameters.search_query='' OR
          service_case.reference ILIKE '%' || parameters.search_query || '%' OR
          service_case.title ILIKE '%' || parameters.search_query || '%' OR
          contact.name ILIKE '%' || parameters.search_query || '%' OR
          coalesce(location.name, '') ILIKE '%' || parameters.search_query || '%' OR
          coalesce(result.provider, '') ILIKE '%' || parameters.search_query || '%' OR
          coalesce(result.model, '') ILIKE '%' || parameters.search_query || '%' OR
          result.proposed_fields::text ILIKE '%' || parameters.search_query || '%' OR
          result.confirmed_fields::text ILIKE '%' || parameters.search_query || '%')
    )
    SELECT count(*)::int AS all_count,
           count(*) FILTER (
             WHERE status IN ('review_required', 'failed')
           )::int AS attention_count,
           count(*) FILTER (
             WHERE status IN ('pending', 'processing')
           )::int AS in_flight_count,
           count(*) FILTER (WHERE status='confirmed')::int AS completed_count
    FROM visible_results
  `;
  const countRow = countRows[0];
  const counts: ServiceOcrQueueCounts = {
    all: countRow?.all_count ?? 0,
    attention: countRow?.attention_count ?? 0,
    inFlight: countRow?.in_flight_count ?? 0,
    completed: countRow?.completed_count ?? 0,
  };

  const rows = await sql<ServiceOcrQueueItemRow[]>`
    WITH parameters AS (
      SELECT ${query}::text AS search_query,
             ${view}::text AS selected_view,
             ${options.cursor?.status ?? null}::text AS cursor_status,
             ${cursorDate?.toISOString() ?? null}::timestamptz AS cursor_created_at,
             ${options.cursor?.id ?? null}::uuid AS cursor_id
    ), visible_results AS (
      SELECT result.id, result.attachment_id, attachment.object_id,
             service_case.id AS case_id,
             service_case.reference AS case_reference,
             service_case.title AS case_title,
             contact.name AS customer_name,
             location.name AS service_location_name,
             attachment.category, attachment.source,
             attachment.processing_status AS attachment_processing_status,
             object.status AS evidence_status, object.content_type,
             result.status, result.proposed_fields, result.confirmed_fields,
             result.manually_confirmed_fields, result.confidence,
             result.provider, result.model, result.provenance,
             result.error_safe, result.attempt, result.created_at,
             result.completed_at,
             CASE result.status
               WHEN 'review_required' THEN 0
               WHEN 'failed' THEN 1
               WHEN 'processing' THEN 2
               WHEN 'pending' THEN 3
               ELSE 4
             END AS sort_priority
      FROM service.ocr_results result
      JOIN service.report_attachments attachment
        ON attachment.id=result.attachment_id
       AND attachment.tenant_id=result.tenant_id
      JOIN service.cases service_case
        ON service_case.id=attachment.case_id
       AND service_case.tenant_id=attachment.tenant_id
      JOIN crm.contacts contact
        ON contact.id=service_case.customer_contact_id
       AND contact.tenant_id=service_case.tenant_id
      LEFT JOIN crm.service_locations location
        ON location.id=service_case.service_location_id
       AND location.tenant_id=service_case.tenant_id
      JOIN objects.object_metadata object
        ON object.id=attachment.object_id
       AND object.tenant_id=attachment.tenant_id
      CROSS JOIN parameters
      WHERE result.tenant_id=platform.current_tenant_id()
        AND result.attempt=(
          SELECT max(latest.attempt)
          FROM service.ocr_results latest
          WHERE latest.tenant_id=result.tenant_id
            AND latest.attachment_id=result.attachment_id
        )
        AND (parameters.search_query='' OR
          service_case.reference ILIKE '%' || parameters.search_query || '%' OR
          service_case.title ILIKE '%' || parameters.search_query || '%' OR
          contact.name ILIKE '%' || parameters.search_query || '%' OR
          coalesce(location.name, '') ILIKE '%' || parameters.search_query || '%' OR
          coalesce(result.provider, '') ILIKE '%' || parameters.search_query || '%' OR
          coalesce(result.model, '') ILIKE '%' || parameters.search_query || '%' OR
          result.proposed_fields::text ILIKE '%' || parameters.search_query || '%' OR
          result.confirmed_fields::text ILIKE '%' || parameters.search_query || '%')
    )
    SELECT visible_results.*
    FROM visible_results
    CROSS JOIN parameters
    WHERE (parameters.selected_view='all'
      OR (parameters.selected_view='attention' AND
        visible_results.status IN ('review_required', 'failed'))
      OR (parameters.selected_view='in_flight' AND
        visible_results.status IN ('pending', 'processing'))
      OR (parameters.selected_view='completed' AND
        visible_results.status='confirmed'))
      AND (parameters.cursor_status IS NULL
        OR visible_results.sort_priority > CASE parameters.cursor_status
          WHEN 'review_required' THEN 0
          WHEN 'failed' THEN 1
          WHEN 'processing' THEN 2
          WHEN 'pending' THEN 3
          ELSE 4
        END
        OR (visible_results.sort_priority = CASE parameters.cursor_status
            WHEN 'review_required' THEN 0
            WHEN 'failed' THEN 1
            WHEN 'processing' THEN 2
            WHEN 'pending' THEN 3
            ELSE 4
          END
          AND (visible_results.created_at, visible_results.id) <
            (parameters.cursor_created_at, parameters.cursor_id)))
    ORDER BY visible_results.sort_priority,
             visible_results.created_at DESC, visible_results.id DESC
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const selected = hasMore ? rows.slice(0, limit) : rows;
  const last = selected.at(-1);
  return {
    items: selected.map(serviceOcrQueueItem),
    counts,
    nextCursor:
      hasMore && last !== undefined
        ? {
            status: last.status,
            createdAt: last.created_at.toISOString(),
            id: last.id,
          }
        : null,
  };
}

/** Compatibility projection for callers that need a bounded, unfiltered list. */
export async function listServiceOcrQueue(
  sql: postgres.TransactionSql,
  limit = 200,
): Promise<readonly ServiceOcrQueueItem[]> {
  return (await listServiceOcrQueuePage(sql, { view: "all", limit })).items;
}

function safeOcrCorrections(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("OCR corrections must be an object");
  const source = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(source).some(
      (key) => !["productType", "productModel", "serialNumber"].includes(key),
    )
  )
    throw new TypeError("OCR corrections contain an unsupported field");
  const fields: Record<string, string> = {};
  for (const [key, raw] of Object.entries(source)) {
    if (typeof raw !== "string")
      throw new TypeError("OCR correction values must be text");
    const text = raw.trim();
    if (text.length > 500) throw new TypeError("OCR correction is too long");
    if (text !== "") fields[key] = text;
  }
  return fields;
}

export async function confirmOcrCorrections(
  sql: postgres.TransactionSql,
  actorUserId: string,
  ocrResultId: string,
  corrections: unknown,
  requestId: string,
): Promise<void> {
  await requireFieldService(sql);
  const fields = safeOcrCorrections(corrections);
  if (Object.keys(fields).length === 0)
    throw new TypeError("Enter at least one confirmed OCR field");
  const rows = await sql<{ id: string; report_revision_id: string | null }[]>`
    UPDATE service.ocr_results result SET
      confirmed_fields = result.confirmed_fields || ${sql.json(fields)},
      manually_confirmed_fields = ARRAY(
        SELECT DISTINCT field FROM unnest(
          result.manually_confirmed_fields ||
          ${Object.keys(fields)}::text[]
        ) field ORDER BY field
      ),
      status='confirmed', error_safe=NULL, completed_at=CURRENT_TIMESTAMP
    FROM service.report_attachments attachment
    WHERE result.id=${ocrResultId}::uuid
      AND attachment.id=result.attachment_id
      AND result.status IN ('review_required','failed','confirmed')
    RETURNING result.id, attachment.report_revision_id
  `;
  const row = rows[0];
  if (row === undefined)
    throw new TypeError("Reviewable OCR result was not found");
  if (row.report_revision_id !== null)
    await sql`
      UPDATE service.report_revisions SET
        product_snapshot=product_snapshot || ${sql.json(fields)},
        manual_corrections=manual_corrections ||
          jsonb_build_object('ocr', ${sql.json(fields)}),
        updated_at=CURRENT_TIMESTAMP
      WHERE id=${row.report_revision_id}::uuid
        AND status IN ('draft','review_required')
    `;
  await sql`
    INSERT INTO audit.records(
      tenant_id, actor_user_id, action, target_type, target_id,
      request_id, metadata
    ) VALUES (
      platform.current_tenant_id(), ${actorUserId}::uuid,
      'field_service.ocr.corrected', 'ocr_result', ${ocrResultId}::uuid,
      ${requestId}, ${sql.json({ fields: Object.keys(fields).sort() })}
    )
  `;
}

export async function finalizeReportRevision(
  sql: postgres.TransactionSql,
  actorUserId: string,
  revisionId: string,
  requestId: string = randomUUID(),
): Promise<ReportRevision> {
  await requireFieldService(sql);
  const rows = await sql<
    {
      id: string;
      report_id: string;
      version: number;
      status: ReportRevision["status"];
      diagnosis: string | null;
      work_performed: string | null;
      part_replaced: boolean | null;
      replacement_part_details: string | null;
      technician_notes: string | null;
      finalized_at: Date | null;
      arrival_signed: boolean;
      departure_signed: boolean;
      has_fault_photo: boolean;
      has_module_photo: boolean;
    }[]
  >`
    SELECT revision.id, revision.report_id, revision.version, revision.status,
           revision.diagnosis, revision.work_performed, revision.part_replaced,
           revision.replacement_part_details, revision.technician_notes,
           revision.finalized_at,
           visit.arrival_signature_object_id IS NOT NULL AS arrival_signed,
           visit.departure_signature_object_id IS NOT NULL AS departure_signed,
           EXISTS (
             SELECT 1 FROM service.report_attachments attachment
             WHERE attachment.report_revision_id = revision.id
               AND attachment.category = 'fault'
               AND attachment.processing_status = 'available'
           ) AS has_fault_photo,
           EXISTS (
             SELECT 1 FROM service.report_attachments attachment
             WHERE attachment.report_revision_id = revision.id
               AND attachment.category = 'module'
               AND attachment.processing_status = 'available'
           ) AS has_module_photo
    FROM service.report_revisions revision
    JOIN service.reports report ON report.id = revision.report_id
    JOIN service.visits visit ON visit.id = report.visit_id
    WHERE revision.id = ${revisionId}::uuid
      AND revision.status IN ('draft','review_required')
    FOR UPDATE OF revision
  `;
  const row = rows[0];
  if (row === undefined)
    throw new TypeError("Editable report revision was not found");
  const errors = reportCompletionErrors({
    arrivalSigned: row.arrival_signed,
    departureSigned: row.departure_signed,
    hasFaultPhoto: row.has_fault_photo,
    hasModulePhoto: row.has_module_photo,
    diagnosis: row.diagnosis,
    workPerformed: row.work_performed,
    partReplaced: row.part_replaced,
    replacementPartDetails: row.replacement_part_details,
  });
  if (errors.length > 0)
    throw new TypeError(`Report is incomplete: ${errors.join("; ")}`);
  await sql`
    UPDATE service.report_revisions prior SET
      status='superseded', updated_at=CURRENT_TIMESTAMP
    WHERE prior.report_id=${row.report_id}::uuid
      AND prior.status='finalized' AND prior.id<>${revisionId}::uuid
  `;
  const updated = await sql<
    {
      id: string;
      report_id: string;
      version: number;
      status: ReportRevision["status"];
      diagnosis: string | null;
      work_performed: string | null;
      part_replaced: boolean | null;
      replacement_part_details: string | null;
      technician_notes: string | null;
      finalized_at: Date | null;
    }[]
  >`
    UPDATE service.report_revisions revision SET
      status = 'finalized', finalized_at = clock_timestamp(),
      finalized_by_user_id = ${actorUserId}::uuid,
      customer_snapshot = revision.customer_snapshot || jsonb_build_object(
        'signedDocument', jsonb_build_object(
          'schemaVersion', 1,
          'serviceCase', jsonb_build_object(
            'id', service_case.id,
            'reference', service_case.reference,
            'customerContactId', service_case.customer_contact_id,
            'customerName', customer.name,
            'serviceLocationId', service_case.service_location_id,
            'serviceLocationName', location.name,
            'serviceLocationAddress', location.address,
            'status', service_case.status,
            'title', service_case.title,
            'faultDescription', service_case.fault_description,
            'warrantyStatus', service_case.warranty_status,
            'productType', service_case.product_type,
            'productModel', service_case.product_model,
            'serialNumber', service_case.serial_number,
            'priority', service_case.priority,
            'createdAt', service_case.created_at,
            'updatedAt', service_case.updated_at
          ),
          'customer', jsonb_build_object(
            'contactId', customer.id,
            'nationalIdMasked', CASE WHEN customer_profile.national_id_hint IS NULL
              THEN NULL ELSE repeat('•', 6) || customer_profile.national_id_hint END,
            'preferredLanguage', customer_profile.preferred_language,
            'address', customer_profile.address
          ),
          'visit', jsonb_build_object(
            'id', visit.id,
            'caseId', visit.case_id,
            'appointmentId', visit.appointment_id,
            'technicianId', visit.technician_id,
            'visitNumber', visit.visit_number,
            'status', visit.status,
            'arrivalAt', visit.arrival_at,
            'departureAt', visit.departure_at,
            'durationSeconds', CASE
              WHEN visit.arrival_at IS NULL OR visit.departure_at IS NULL THEN NULL
              ELSE greatest(
                0,
                round(extract(epoch FROM visit.departure_at - visit.arrival_at))
              )::integer
            END,
            'arrivalSignatureObjectId', visit.arrival_signature_object_id,
            'departureSignatureObjectId', visit.departure_signature_object_id,
            'arrivalIdentity', visit.arrival_identity,
            'departureIdentity', visit.departure_identity
          ),
          'technician', jsonb_build_object(
            'id', technician.id,
            'linkedUserId', technician.linked_user_id,
            'employeeIdentifier', technician.employee_identifier,
            'fullName', technician.full_name,
            'phone', technician.phone,
            'email', technician.email,
            'identityVerification', technician.identity_verification,
            'active', technician.active
          )
        )
      ),
      branding_snapshot = jsonb_build_object(
        'businessName', coalesce(
          settings.business_name,
          settings.display_name,
          platform.current_tenant_name()
        ),
        'logoVersion', settings.logo_updated_at,
        'logoData', CASE WHEN settings.logo_data IS NULL
          THEN NULL ELSE encode(settings.logo_data, 'base64') END,
        'logoContentType', settings.logo_content_type,
        'accentToken', settings.accent_token,
        'reportHeader', settings.report_header,
        'reportFooter', settings.report_footer,
        'businessEmail', settings.business_email,
        'businessPhone', settings.business_phone,
        'businessAddress', settings.business_address,
        'locale', settings.locale,
        'timezone', settings.timezone
      ), updated_at = CURRENT_TIMESTAMP
    FROM service.reports report
    JOIN service.cases service_case
      ON service_case.id = report.case_id
     AND service_case.tenant_id = report.tenant_id
    JOIN crm.contacts customer
      ON customer.id = service_case.customer_contact_id
     AND customer.tenant_id = service_case.tenant_id
    LEFT JOIN crm.customer_profiles customer_profile
      ON customer_profile.contact_id = customer.id
     AND customer_profile.tenant_id = customer.tenant_id
    LEFT JOIN crm.service_locations location
      ON location.id = service_case.service_location_id
     AND location.tenant_id = service_case.tenant_id
    JOIN service.visits visit
      ON visit.id = report.visit_id
     AND visit.tenant_id = report.tenant_id
    JOIN service.technicians technician
      ON technician.id = visit.technician_id
     AND technician.tenant_id = visit.tenant_id
    JOIN crm.tenant_settings settings ON settings.tenant_id = report.tenant_id
    WHERE revision.id = ${revisionId}::uuid
      AND report.id = revision.report_id
      AND settings.tenant_id = platform.current_tenant_id()
    RETURNING revision.id, revision.report_id, revision.version, revision.status,
      revision.diagnosis, revision.work_performed, revision.part_replaced,
      revision.replacement_part_details, revision.technician_notes,
      revision.finalized_at
  `;
  const finalized = updated[0];
  if (finalized === undefined) throw new Error("Report finalization failed");
  await sql`
    UPDATE service.visits visit SET status='reported', updated_at=CURRENT_TIMESTAMP
    FROM service.reports report
    WHERE report.id=${row.report_id}::uuid AND visit.id=report.visit_id
      AND visit.status='departed'
  `;
  await sql`
    INSERT INTO audit.records(
      tenant_id, actor_user_id, action, target_type, target_id, request_id, metadata
    ) VALUES (
      platform.current_tenant_id(), ${actorUserId}::uuid,
      'field_service.report.finalized', 'report_revision', ${revisionId}::uuid,
      ${requestId}, ${sql.json({ reportId: row.report_id, version: row.version })}
    )
  `;
  return reportRevision(finalized);
}

interface IntakeDraftRecord {
  readonly id: string;
  readonly conversation_id: string;
  readonly reporting_contact_id: string;
  readonly customer_contact_id: string | null;
  readonly customer_resolution_status:
    | "unresolved"
    | "reporting_contact"
    | "matched"
    | "created"
    | "conflict"
    | "invalid_phone";
  readonly customer_resolution_evidence: Readonly<Record<string, unknown>>;
  readonly correlation_key: string;
  readonly status:
    | "collecting"
    | "awaiting_confirmation"
    | "confirmed"
    | "handed_off"
    | "expired";
  readonly collected_fields: ServiceIntakeFields;
  readonly national_id_hint: string | null;
  readonly national_id_blind_index?: string | null;
  readonly required_field_overrides: Readonly<Record<string, unknown>>;
}

export interface ServiceIntakeDraft {
  readonly id: string;
  readonly conversationId: string;
  readonly reportingContactId: string;
  readonly customerContactId: string | null;
  readonly customerResolutionStatus: IntakeDraftRecord["customer_resolution_status"];
  readonly correlationKey: string;
  readonly status: IntakeDraftRecord["status"];
  readonly fields: ServiceIntakeFields;
  readonly nationalIdMasked: string | null;
  readonly missingFields: readonly IntakeRequiredField[];
}

function intakeDraft(row: IntakeDraftRecord): ServiceIntakeDraft {
  const overrides = Object.entries(row.required_field_overrides)
    .filter(([, value]) => value === true)
    .map(([key]) => key as IntakeRequiredField);
  const fields = {
    ...row.collected_fields,
    ...(row.national_id_hint === null ? {} : { nationalId: "protected" }),
  };
  const missingFields = [...missingIntakeFields(fields, overrides)];
  if (
    row.customer_resolution_status === "invalid_phone" &&
    !missingFields.includes("customerPhone")
  )
    missingFields.unshift("customerPhone");
  return {
    id: row.id,
    conversationId: row.conversation_id,
    reportingContactId: row.reporting_contact_id,
    customerContactId: row.customer_contact_id,
    customerResolutionStatus: row.customer_resolution_status,
    correlationKey: row.correlation_key,
    status: row.status,
    fields,
    nationalIdMasked: maskedNationalId(row.national_id_hint),
    missingFields,
  };
}

interface IntakeCustomerResolution {
  readonly customerContactId: string | null;
  readonly status: IntakeDraftRecord["customer_resolution_status"];
  readonly evidence: Readonly<Record<string, unknown>>;
}

async function resolveIntakeCustomer(
  sql: postgres.TransactionSql,
  input: {
    readonly reportingContactId: string;
    readonly customerPhone?: string;
    readonly nationalIdBlindIndex?: string | null;
  },
): Promise<IntakeCustomerResolution> {
  const suppliedPhone = input.customerPhone?.trim();
  const normalizedPhone =
    suppliedPhone === undefined || suppliedPhone === ""
      ? undefined
      : normalizeE164(suppliedPhone);
  if (
    suppliedPhone !== undefined &&
    suppliedPhone !== "" &&
    normalizedPhone === undefined
  )
    return {
      customerContactId: null,
      status: "invalid_phone",
      evidence: { phoneValid: false },
    };
  const nationalMatches =
    input.nationalIdBlindIndex === undefined ||
    input.nationalIdBlindIndex === null
      ? []
      : await sql<{ contact_id: string }[]>`
          SELECT contact_id FROM crm.customer_profiles
          WHERE national_id_blind_index=${input.nationalIdBlindIndex}
        `;
  const phoneMatches =
    normalizedPhone === undefined
      ? []
      : await sql<
          { contact_id: string; national_id_blind_index: string | null }[]
        >`
          SELECT DISTINCT identity.contact_id, profile.national_id_blind_index
          FROM crm.contact_channel_identities identity
          LEFT JOIN crm.customer_profiles profile
            ON profile.tenant_id=identity.tenant_id
           AND profile.contact_id=identity.contact_id
          WHERE identity.normalized_value=${normalizedPhone}
            AND identity.channel IN ('phone','whatsapp')
            AND identity.validation_status <> 'revoked'
        `;
  const nationalIds = [
    ...new Set(nationalMatches.map((row) => row.contact_id)),
  ];
  const phoneIds = [...new Set(phoneMatches.map((row) => row.contact_id))];
  const suppliedNationalId = input.nationalIdBlindIndex ?? null;
  const phoneHasDifferentNationalId = phoneMatches.some(
    (row) =>
      suppliedNationalId !== null &&
      row.national_id_blind_index !== null &&
      row.national_id_blind_index !== suppliedNationalId,
  );
  const conflictingMatches =
    phoneHasDifferentNationalId ||
    nationalIds.length > 1 ||
    phoneIds.length > 1 ||
    (nationalIds.length === 1 &&
      phoneIds.length === 1 &&
      nationalIds[0] !== phoneIds[0]);
  if (conflictingMatches)
    return {
      customerContactId: null,
      status: "conflict",
      evidence: {
        phoneMatchCount: phoneIds.length,
        nationalIdMatchCount: nationalIds.length,
        conflictingProtectedIdentity: phoneHasDifferentNationalId,
      },
    };
  const customerContactId = nationalIds[0] ?? phoneIds[0] ?? null;
  if (customerContactId === null)
    return {
      customerContactId: null,
      status: "unresolved",
      evidence: {
        phoneMatchCount: phoneIds.length,
        nationalIdMatchCount: nationalIds.length,
      },
    };
  return {
    customerContactId,
    status:
      customerContactId === input.reportingContactId
        ? "reporting_contact"
        : "matched",
    evidence: {
      matchedBy: nationalIds.length === 1 ? "protected_national_id" : "phone",
      reportingContact: customerContactId === input.reportingContactId,
    },
  };
}

export async function openWhatsAppServiceIntake(
  sql: postgres.TransactionSql,
  input: {
    readonly conversationId: string;
    readonly reportingContactId: string;
    readonly messageId: string;
    readonly correlationKey: string;
    readonly occurredAt: string;
  },
): Promise<ServiceIntakeDraft> {
  const state = await requireFieldService(sql);
  if (!state.whatsAppIntakeEnabled)
    throw new TypeError("WhatsApp field-service intake is not enabled");
  const rows = await sql<IntakeDraftRecord[]>`
    INSERT INTO service.intake_drafts(
      tenant_id, conversation_id, reporting_contact_id, correlation_key,
      last_message_at
    ) VALUES (
      platform.current_tenant_id(), ${input.conversationId}::uuid,
      ${input.reportingContactId}::uuid,
      ${requiredText(input.correlationKey, "Correlation key", 200)},
      ${new Date(input.occurredAt)}
    ) ON CONFLICT (tenant_id, correlation_key) DO UPDATE SET
      last_message_at = GREATEST(
        service.intake_drafts.last_message_at, EXCLUDED.last_message_at
      ), updated_at = CURRENT_TIMESTAMP
    RETURNING id, conversation_id, reporting_contact_id, customer_contact_id,
      customer_resolution_status, customer_resolution_evidence,
      correlation_key, status, collected_fields, national_id_hint,
      national_id_blind_index,
      required_field_overrides
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("Intake creation returned no row");
  const linked = await sql<{ message_id: string }[]>`
    INSERT INTO service.intake_messages(tenant_id, intake_draft_id, message_id)
    SELECT platform.current_tenant_id(), ${row.id}::uuid, message.id
    FROM messaging.messages message
    WHERE message.id = ${input.messageId}::uuid
      AND message.conversation_id = ${input.conversationId}::uuid
    ON CONFLICT DO NOTHING RETURNING message_id
  `;
  if (linked.length === 0) {
    const exists = await sql<{ found: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM service.intake_messages
        WHERE intake_draft_id = ${row.id}::uuid
          AND message_id = ${input.messageId}::uuid
      ) AS found
    `;
    if (exists[0]?.found !== true)
      throw new TypeError(
        "The intake message does not belong to this conversation",
      );
  }
  return intakeDraft(row);
}

export async function findOpenWhatsAppServiceIntake(
  sql: postgres.TransactionSql,
  conversationId: string,
): Promise<ServiceIntakeDraft | undefined> {
  const state = await requireFieldService(sql);
  if (!state.whatsAppIntakeEnabled)
    throw new TypeError("WhatsApp field-service intake is not enabled");
  const rows = await sql<IntakeDraftRecord[]>`
    SELECT id, conversation_id, reporting_contact_id, customer_contact_id,
      customer_resolution_status, customer_resolution_evidence,
      correlation_key, status, collected_fields, national_id_hint,
      national_id_blind_index,
      required_field_overrides
    FROM service.intake_drafts
    WHERE conversation_id = ${conversationId}::uuid
      AND status IN ('collecting','awaiting_confirmation')
    ORDER BY updated_at DESC, id DESC LIMIT 1
  `;
  return rows[0] === undefined ? undefined : intakeDraft(rows[0]);
}

/**
 * Serializes intake correlation per conversation so concurrent or retried Meta
 * events join one open draft, while a later request can start a new case after
 * the previous draft reaches a terminal state.
 */
export async function captureWhatsAppServiceIntakeMessage(
  sql: postgres.TransactionSql,
  input: {
    readonly conversationId: string;
    readonly reportingContactId: string;
    readonly messageId: string;
    readonly occurredAt: string;
  },
): Promise<ServiceIntakeDraft> {
  await sql`
    SELECT pg_advisory_xact_lock(hashtextextended(
      platform.current_tenant_id()::text || ':field-intake:' ||
      ${input.conversationId}, 0
    ))
  `;
  const current = await findOpenWhatsAppServiceIntake(
    sql,
    input.conversationId,
  );
  return openWhatsAppServiceIntake(sql, {
    ...input,
    correlationKey:
      current?.correlationKey ??
      `whatsapp:${input.conversationId}:${createHash("sha256").update(input.messageId).digest("hex").slice(0, 24)}`,
  });
}

export async function handoffWhatsAppServiceIntake(
  sql: postgres.TransactionSql,
  intakeId: string,
): Promise<void> {
  const state = await requireFieldService(sql);
  if (!state.whatsAppIntakeEnabled)
    throw new TypeError("WhatsApp field-service intake is not enabled");
  await sql`
    UPDATE service.intake_drafts SET status='handed_off',
      updated_at=CURRENT_TIMESTAMP
    WHERE id=${intakeId}::uuid AND status IN ('collecting','awaiting_confirmation')
  `;
}

export async function updateWhatsAppServiceIntake(
  sql: postgres.TransactionSql,
  intakeId: string,
  proposal: unknown,
  nationalId?: ProtectedNationalIdEnvelope,
): Promise<ServiceIntakeDraft> {
  const state = await requireFieldService(sql);
  if (!state.whatsAppIntakeEnabled)
    throw new TypeError("WhatsApp field-service intake is not enabled");
  const safe = sanitizeIntakeProposal(proposal);
  const safeForStorage = { ...safe };
  delete safeForStorage.nationalId;
  const current = await sql<IntakeDraftRecord[]>`
    SELECT id, conversation_id, reporting_contact_id, customer_contact_id,
      customer_resolution_status, customer_resolution_evidence,
      correlation_key, status, collected_fields, national_id_hint,
      national_id_blind_index,
      required_field_overrides
    FROM service.intake_drafts
    WHERE id = ${intakeId}::uuid AND status IN ('collecting','awaiting_confirmation')
    FOR UPDATE
  `;
  const row = current[0];
  if (row === undefined) throw new TypeError("Open intake draft was not found");
  const fields = { ...row.collected_fields, ...safeForStorage };
  const resolution = await resolveIntakeCustomer(sql, {
    reportingContactId: row.reporting_contact_id,
    ...(fields.customerPhone === undefined
      ? {}
      : { customerPhone: fields.customerPhone }),
    nationalIdBlindIndex:
      nationalId?.blindIndex ?? row.national_id_blind_index ?? null,
  });
  const preview = {
    ...fields,
    ...(nationalId !== undefined || row.national_id_hint !== null
      ? { nationalId: "protected" }
      : {}),
  };
  const overrides = Object.entries(row.required_field_overrides)
    .filter(([, value]) => value === true)
    .map(([key]) => key as IntakeRequiredField);
  const status =
    resolution.status !== "invalid_phone" &&
    resolution.status !== "conflict" &&
    missingIntakeFields(preview, overrides).length === 0
      ? "awaiting_confirmation"
      : "collecting";
  const updated = await sql<IntakeDraftRecord[]>`
    UPDATE service.intake_drafts SET
      collected_fields = ${sql.json(fields)},
      national_id_ciphertext = CASE WHEN ${nationalId !== undefined}
        THEN ${nationalId?.ciphertext ?? null} ELSE national_id_ciphertext END,
      national_id_blind_index = CASE WHEN ${nationalId !== undefined}
        THEN ${nationalId?.blindIndex ?? null} ELSE national_id_blind_index END,
      national_id_hint = CASE WHEN ${nationalId !== undefined}
        THEN ${nationalId?.hint ?? null} ELSE national_id_hint END,
      customer_contact_id=${resolution.customerContactId}::uuid,
      customer_resolution_status=${resolution.status},
      customer_resolution_evidence=${sql.json(databaseJson(resolution.evidence))},
      status = ${status}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${intakeId}::uuid
    RETURNING id, conversation_id, reporting_contact_id, customer_contact_id,
      customer_resolution_status, customer_resolution_evidence,
      correlation_key, status, collected_fields, national_id_hint,
      national_id_blind_index,
      required_field_overrides
  `;
  const updatedRow = updated[0];
  if (updatedRow === undefined)
    throw new Error("Intake update returned no row");
  return intakeDraft(updatedRow);
}

export async function overrideIntakeRequirement(
  sql: postgres.TransactionSql,
  actorUserId: string,
  intakeId: string,
  field: IntakeRequiredField,
  reason: string,
  requestId: string,
): Promise<void> {
  await requireFieldService(sql);
  const explanation = requiredText(reason, "Override reason", 1_000);
  const rows = await sql<{ id: string }[]>`
    UPDATE service.intake_drafts SET
      required_field_overrides = required_field_overrides ||
        jsonb_build_object(${field}, true),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${intakeId}::uuid AND status IN ('collecting','awaiting_confirmation')
    RETURNING id
  `;
  if (rows.length === 0) throw new TypeError("Open intake draft was not found");
  await sql`
    INSERT INTO audit.records(
      tenant_id, actor_user_id, action, target_type, target_id, request_id, metadata
    ) VALUES (
      platform.current_tenant_id(), ${actorUserId}::uuid,
      'field_service.intake.requirement_overridden', 'intake_draft',
      ${intakeId}::uuid, ${requestId},
      ${sql.json({ field, reason: explanation })}
    )
  `;
}

export async function confirmWhatsAppServiceIntake(
  sql: postgres.TransactionSql,
  intakeId: string,
): Promise<ServiceCaseSummary> {
  const feature = await requireFieldService(sql);
  if (!feature.whatsAppIntakeEnabled)
    throw new TypeError("WhatsApp field-service intake is not enabled");
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM service.cases WHERE intake_draft_id = ${intakeId}::uuid
  `;
  if (existing[0] !== undefined) {
    const found = await getServiceCase(sql, existing[0].id);
    if (found === undefined)
      throw new Error("Confirmed intake case could not be read");
    return found;
  }
  const rows = await sql<
    (IntakeDraftRecord & {
      national_id_ciphertext: string | null;
      national_id_blind_index: string | null;
    })[]
  >`
    SELECT id, conversation_id, reporting_contact_id, customer_contact_id,
      customer_resolution_status, customer_resolution_evidence,
      correlation_key, status, collected_fields, national_id_hint,
      national_id_ciphertext, national_id_blind_index, required_field_overrides
    FROM service.intake_drafts WHERE id = ${intakeId}::uuid FOR UPDATE
  `;
  const row = rows[0];
  if (row === undefined) throw new TypeError("Intake draft was not found");
  const overrides = Object.entries(row.required_field_overrides)
    .filter(([, value]) => value === true)
    .map(([key]) => key as IntakeRequiredField);
  const fields: ServiceIntakeFields = {
    ...row.collected_fields,
    ...(row.national_id_ciphertext === null ? {} : { nationalId: "protected" }),
  };
  const missing = missingIntakeFields(fields, overrides);
  if (missing.length > 0)
    throw new TypeError(`Intake is incomplete: ${missing.join(", ")}`);
  const normalizedCustomerPhone =
    fields.customerPhone === undefined
      ? undefined
      : normalizeE164(fields.customerPhone);
  if (
    fields.customerPhone !== undefined &&
    normalizedCustomerPhone === undefined &&
    !overrides.includes("customerPhone")
  )
    throw new TypeError(
      "The customer phone must be a valid international number",
    );
  if (normalizedCustomerPhone !== undefined)
    await sql`
      SELECT pg_advisory_xact_lock(hashtextextended(
        platform.current_tenant_id()::text || ':customer-phone:' ||
        ${normalizedCustomerPhone}, 0
      ))
    `;
  const currentResolution = await resolveIntakeCustomer(sql, {
    reportingContactId: row.reporting_contact_id,
    ...(normalizedCustomerPhone === undefined
      ? {}
      : { customerPhone: normalizedCustomerPhone }),
    nationalIdBlindIndex: row.national_id_blind_index,
  });
  if (
    currentResolution.status === "conflict" ||
    currentResolution.status === "invalid_phone"
  )
    throw new TypeError(
      "Customer identity evidence conflicts and requires an authorized human review",
    );
  let customerContactId = currentResolution.customerContactId;
  let resolutionStatus = currentResolution.status;
  if (customerContactId === null) {
    const contacts = await sql<{ id: string }[]>`
      INSERT INTO crm.contacts(
        tenant_id, name, lifecycle_status, metadata,
        voice_consent, whatsapp_consent
      ) VALUES (
        platform.current_tenant_id(),
        ${requiredText(
          fields.customerName ??
            (overrides.includes("customerName") ? "Unidentified customer" : ""),
          "Customer name",
          160,
        )},
        'active',
        ${sql.json({
          source: "field_service_intake",
          reportingContactId: row.reporting_contact_id,
        })},
        'unknown', 'unknown'
      ) RETURNING id
    `;
    const createdContactId = contacts[0]?.id;
    if (createdContactId === undefined)
      throw new Error("Customer creation returned no identifier");
    if (normalizedCustomerPhone !== undefined) {
      const identities = await sql<{ id: string }[]>`
        INSERT INTO crm.contact_channel_identities(
          tenant_id, contact_id, channel, normalized_value, display_value,
          validation_status, is_primary, provider
        ) VALUES (
          platform.current_tenant_id(), ${createdContactId}::uuid, 'phone',
          ${normalizedCustomerPhone}, ${fields.customerPhone ?? normalizedCustomerPhone},
          'unverified', true, 'field_service_intake'
        ) ON CONFLICT (tenant_id, channel, normalized_value)
          WHERE normalized_value IS NOT NULL DO NOTHING
        RETURNING id
      `;
      if (identities[0] === undefined) {
        await sql`DELETE FROM crm.contacts WHERE id=${createdContactId}::uuid`;
        const racedResolution = await resolveIntakeCustomer(sql, {
          reportingContactId: row.reporting_contact_id,
          customerPhone: normalizedCustomerPhone,
          nationalIdBlindIndex: row.national_id_blind_index,
        });
        if (
          racedResolution.customerContactId === null ||
          racedResolution.status === "conflict" ||
          racedResolution.status === "invalid_phone"
        )
          throw new TypeError(
            "Customer identity changed during confirmation and requires review",
          );
        customerContactId = racedResolution.customerContactId;
        resolutionStatus = racedResolution.status;
      } else {
        customerContactId = createdContactId;
        resolutionStatus = "created";
      }
    } else {
      customerContactId = createdContactId;
      resolutionStatus = "created";
    }
  }
  await sql`
    UPDATE service.intake_drafts SET
      customer_contact_id=${customerContactId}::uuid,
      customer_resolution_status=${resolutionStatus},
      customer_resolution_evidence=${sql.json({
        ...currentResolution.evidence,
        resolvedAtConfirmation: true,
      })},
      updated_at=CURRENT_TIMESTAMP
    WHERE id=${intakeId}::uuid
  `;
  if (
    row.national_id_ciphertext !== null &&
    row.national_id_blind_index !== null &&
    row.national_id_hint !== null
  )
    await updateCustomerDossier(sql, customerContactId, {
      nationalId: {
        ciphertext: row.national_id_ciphertext,
        blindIndex: row.national_id_blind_index,
        hint: row.national_id_hint,
      },
      address: fields.serviceAddress ?? null,
    });
  const locationId = await createServiceLocation(sql, {
    customerContactId,
    name: fields.storeName ?? "Service location",
    address: fields.serviceAddress ?? null,
    latitude: fields.latitude ?? null,
    longitude: fields.longitude ?? null,
  });
  const created = await createServiceCase(
    sql,
    { service: "whatsapp-intake" },
    {
      customerContactId,
      reportingContactId: row.reporting_contact_id,
      serviceLocationId: locationId,
      intakeDraftId: row.id,
      conversationId: row.conversation_id,
      title: fields.faultDescription?.slice(0, 200) ?? "Service request",
      faultDescription: fields.faultDescription ?? "Service request",
      warrantyStatus: fields.warrantyStatus ?? "unknown",
      ...(fields.productType === undefined
        ? {}
        : { productType: fields.productType }),
      ...(fields.productModel === undefined
        ? {}
        : { productModel: fields.productModel }),
      ...(fields.serialNumber === undefined
        ? {}
        : { serialNumber: fields.serialNumber }),
      source: "whatsapp",
    },
  );
  await sql`
    INSERT INTO service.report_attachments(
      tenant_id, case_id, message_id, object_id, category, source,
      processing_status, created_by_user_id
    )
    SELECT platform.current_tenant_id(), ${created.id}::uuid, message.id,
           message.object_id,
           CASE WHEN message.content_type='image'
             THEN 'customer_photo' ELSE 'document' END,
           'customer', 'available', NULL
    FROM service.intake_messages intake_message
    JOIN messaging.messages message
      ON message.id=intake_message.message_id
     AND message.tenant_id=intake_message.tenant_id
    JOIN objects.object_metadata object
      ON object.id=message.object_id AND object.tenant_id=message.tenant_id
    WHERE intake_message.intake_draft_id=${intakeId}::uuid
      AND message.content_type IN ('image','document')
      AND object.status='available' AND object.deleted_at IS NULL
    ON CONFLICT (tenant_id, object_id, case_id) DO NOTHING
  `;
  await sql`
    UPDATE service.intake_drafts SET status = 'confirmed',
      confirmed_at = clock_timestamp(), updated_at = CURRENT_TIMESTAMP
    WHERE id = ${intakeId}::uuid
  `;
  await sql`
    INSERT INTO audit.records(
      tenant_id, action, target_type, target_id, metadata
    ) VALUES (
      platform.current_tenant_id(), 'field_service.intake.customer_resolved',
      'intake_draft', ${intakeId}::uuid,
      ${sql.json({
        customerContactId,
        reportingContactId: row.reporting_contact_id,
        resolutionStatus,
        caseId: created.id,
      })}
    )
  `;
  return created;
}

export async function linkCaseConversation(
  sql: postgres.TransactionSql,
  caseId: string,
  conversationId: string,
  relationship: "intake" | "relevant" | "resolved_ambiguity",
  actorUserId: string | null,
  requestId?: string,
): Promise<void> {
  await requireFieldService(sql);
  const linked = await sql<{ case_id: string }[]>`
    INSERT INTO service.case_conversations(
      tenant_id, case_id, conversation_id, relationship, linked_by_user_id
    )
    SELECT service_case.tenant_id, service_case.id, conversation.id,
           ${relationship}, ${actorUserId}::uuid
    FROM service.cases service_case
    JOIN messaging.conversations conversation
      ON conversation.tenant_id=service_case.tenant_id
     AND conversation.id=${conversationId}::uuid
     AND conversation.contact_id IN (
       service_case.customer_contact_id,
       coalesce(service_case.reporting_contact_id, service_case.customer_contact_id)
     )
    WHERE service_case.id=${caseId}::uuid
      AND (${relationship} <> 'intake'
        OR service_case.conversation_id=conversation.id)
    ON CONFLICT (tenant_id, case_id, conversation_id) DO UPDATE SET
      relationship = EXCLUDED.relationship,
      linked_by_user_id = EXCLUDED.linked_by_user_id,
      linked_at = CURRENT_TIMESTAMP
    RETURNING case_id
  `;
  if (linked[0] === undefined)
    throw new TypeError("Conversation does not match the case customer");
  if (actorUserId !== null)
    await sql`
      INSERT INTO audit.records(
        tenant_id, actor_user_id, action, target_type, target_id,
        request_id, metadata
      ) VALUES (
        platform.current_tenant_id(), ${actorUserId}::uuid,
        'field_service.conversation.linked', 'service_case', ${caseId}::uuid,
        ${requestId ?? null},
        ${sql.json({ conversationId, relationship })}
      )
    `;
}

export async function linkCaseCall(
  sql: postgres.TransactionSql,
  actorUserId: string,
  caseId: string,
  sessionId: string,
  relationship: "intake" | "diagnostic" | "follow_up" | "resolved_ambiguity",
  requestId?: string,
): Promise<void> {
  await requireFieldService(sql);
  const linked = await sql<{ case_id: string }[]>`
    INSERT INTO service.case_calls(
      tenant_id, case_id, session_id, relationship, linked_by_user_id
    )
    SELECT service_case.tenant_id, service_case.id, session.session_id,
           ${relationship}, ${actorUserId}::uuid
    FROM service.cases service_case
    JOIN public.sessions session
      ON session.tenant_id=service_case.tenant_id
     AND session.session_id=${sessionId}::uuid
    WHERE service_case.id=${caseId}::uuid
      AND (
        session.contact_id IN (
          service_case.customer_contact_id,
          coalesce(service_case.reporting_contact_id, service_case.customer_contact_id)
        ) OR EXISTS (
          SELECT 1
          FROM service.current_tenant_voice_admission_conversations(
            session.session_id
          ) admission
          JOIN service.case_conversations conversation_link
            ON conversation_link.tenant_id=service_case.tenant_id
           AND conversation_link.case_id=service_case.id
           AND conversation_link.conversation_id=admission.source_conversation_id
        )
      )
    ON CONFLICT (tenant_id, case_id, session_id) DO UPDATE SET
      relationship = EXCLUDED.relationship,
      linked_by_user_id = EXCLUDED.linked_by_user_id,
      linked_at = CURRENT_TIMESTAMP
    RETURNING case_id
  `;
  if (linked[0] === undefined)
    throw new TypeError("Call does not match trusted case evidence");
  await sql`
    INSERT INTO audit.records(
      tenant_id, actor_user_id, action, target_type, target_id,
      request_id, metadata
    ) VALUES (
      platform.current_tenant_id(), ${actorUserId}::uuid,
      'field_service.call.linked', 'service_case', ${caseId}::uuid,
      ${requestId ?? null}, ${sql.json({ sessionId, relationship })}
    )
  `;
}

export async function listServiceCaseLinkCandidates(
  sql: postgres.TransactionSql,
  caseId: string,
): Promise<ServiceCaseLinkCandidates> {
  await requireFieldService(sql);
  const [conversations, calls] = await Promise.all([
    sql<
      {
        id: string;
        status: string;
        last_message_at: Date | null;
        linked: boolean;
        linked_case_count: string;
      }[]
    >`
      SELECT conversation.id, conversation.status, conversation.last_message_at,
             coalesce(bool_or(link.case_id=${caseId}::uuid), false) AS linked,
             count(DISTINCT link.case_id) AS linked_case_count
      FROM service.cases service_case
      JOIN messaging.conversations conversation
        ON conversation.tenant_id=service_case.tenant_id
       AND conversation.contact_id IN (
         service_case.customer_contact_id,
         coalesce(service_case.reporting_contact_id, service_case.customer_contact_id)
       )
      LEFT JOIN service.case_conversations link
        ON link.tenant_id=conversation.tenant_id
       AND link.conversation_id=conversation.id
      WHERE service_case.id=${caseId}::uuid
      GROUP BY conversation.id, conversation.status, conversation.last_message_at
      ORDER BY conversation.last_message_at DESC NULLS LAST, conversation.id DESC
      LIMIT 100
    `,
    sql<
      {
        session_id: string;
        status: string;
        direction: string;
        started_at: Date;
        linked: boolean;
        linked_case_count: string;
      }[]
    >`
      SELECT session.session_id, session.status::text, session.direction::text,
             session.created_at AS started_at,
             coalesce(bool_or(link.case_id=${caseId}::uuid), false) AS linked,
             count(DISTINCT link.case_id) AS linked_case_count
      FROM service.cases service_case
      JOIN public.sessions session
        ON session.tenant_id=service_case.tenant_id
       AND (
         session.contact_id IN (
           service_case.customer_contact_id,
           coalesce(service_case.reporting_contact_id, service_case.customer_contact_id)
         ) OR EXISTS (
            SELECT 1
            FROM service.current_tenant_voice_admission_conversations(
              session.session_id
            ) admission
            JOIN messaging.conversations conversation
              ON conversation.tenant_id=service_case.tenant_id
             AND conversation.id=admission.source_conversation_id
             AND conversation.contact_id IN (
               service_case.customer_contact_id,
               coalesce(service_case.reporting_contact_id, service_case.customer_contact_id)
             )
         )
       )
      LEFT JOIN service.case_calls link
        ON link.tenant_id=session.tenant_id AND link.session_id=session.session_id
      WHERE service_case.id=${caseId}::uuid
      GROUP BY session.session_id, session.status, session.direction,
               session.created_at
      ORDER BY session.created_at DESC, session.session_id DESC
      LIMIT 100
    `,
  ]);
  return {
    conversations: conversations.map((row) => ({
      id: row.id,
      status: row.status,
      lastMessageAt: row.last_message_at?.toISOString() ?? null,
      linked: row.linked,
      linkedCaseCount: Number(row.linked_case_count),
    })),
    calls: calls.map((row) => ({
      sessionId: row.session_id,
      status: row.status,
      direction: row.direction,
      startedAt: row.started_at.toISOString(),
      linked: row.linked,
      linkedCaseCount: Number(row.linked_case_count),
    })),
  };
}

export async function getServiceCaseDossier(
  sql: postgres.TransactionSql,
  caseId: string,
): Promise<ServiceCaseDossier | undefined> {
  await requireFieldService(sql);
  return getServiceCaseDossierRecord(sql, caseId);
}

async function getServiceCaseDossierRecord(
  sql: postgres.TransactionSql,
  caseId: string,
): Promise<ServiceCaseDossier | undefined> {
  const serviceCaseRecord = await getServiceCaseRecord(sql, caseId);
  if (serviceCaseRecord === undefined) return undefined;
  const [
    customer,
    appointments,
    visits,
    reports,
    conversations,
    calls,
    summaries,
    audit,
    attachments,
    ocrResults,
    statusHistory,
  ] = await Promise.all([
    getCustomerDossier(sql, serviceCaseRecord.customerContactId),
    listServiceAppointmentRecords(sql, caseId),
    sql<
      {
        id: string;
        case_id: string;
        appointment_id: string | null;
        technician_id: string;
        visit_number: number;
        status: ServiceVisit["status"];
        arrival_at: Date | null;
        departure_at: Date | null;
        arrival_signature_object_id: string | null;
        departure_signature_object_id: string | null;
        arrival_identity: Readonly<Record<string, unknown>> | null;
        departure_identity: Readonly<Record<string, unknown>> | null;
      }[]
    >`
        SELECT id, case_id, appointment_id, technician_id, visit_number,
               status, arrival_at, departure_at, arrival_signature_object_id,
               departure_signature_object_id, arrival_identity, departure_identity
        FROM service.visits WHERE case_id = ${caseId}::uuid
        ORDER BY visit_number, id
      `,
    sql<
      {
        id: string;
        report_id: string;
        version: number;
        status: ReportRevision["status"];
        diagnosis: string | null;
        work_performed: string | null;
        part_replaced: boolean | null;
        replacement_part_details: string | null;
        technician_notes: string | null;
        finalized_at: Date | null;
      }[]
    >`
        SELECT revision.id, revision.report_id, revision.version, revision.status,
               revision.diagnosis, revision.work_performed, revision.part_replaced,
               revision.replacement_part_details, revision.technician_notes,
               revision.finalized_at
        FROM service.report_revisions revision
        JOIN service.reports report ON report.id = revision.report_id
        WHERE report.case_id = ${caseId}::uuid
        ORDER BY revision.created_at DESC, revision.id DESC
      `,
    sql<{ conversation_id: string }[]>`
        SELECT conversation_id FROM service.case_conversations
        WHERE case_id = ${caseId}::uuid ORDER BY linked_at, conversation_id
      `,
    sql<{ session_id: string }[]>`
        SELECT session_id FROM service.case_calls
        WHERE case_id = ${caseId}::uuid ORDER BY linked_at, session_id
      `,
    sql<
      {
        source_kind: "whatsapp" | "call" | "dossier";
        status: string;
        summary: string | null;
      }[]
    >`
        SELECT source_kind, status, summary FROM service.case_summaries
        WHERE case_id = ${caseId}::uuid ORDER BY created_at DESC, id DESC
      `,
    sql<{ action: string; occurred_at: Date }[]>`
        SELECT action, occurred_at FROM audit.records
        WHERE (target_type = 'service_case' AND target_id = ${caseId}::uuid)
           OR (action LIKE 'field_service.%' AND metadata->>'caseId' = ${caseId})
        ORDER BY occurred_at DESC, id DESC LIMIT 200
      `,
    sql<
      {
        id: string;
        object_id: string;
        visit_id: string | null;
        report_revision_id: string | null;
        category: string;
        source: string;
        processing_status: string;
        content_type: string;
        byte_size: string;
        caption: string | null;
        created_at: Date;
      }[]
    >`
        SELECT attachment.id, attachment.object_id, attachment.visit_id,
               attachment.report_revision_id, attachment.category,
               attachment.source, attachment.processing_status,
               object.content_type, object.byte_size, attachment.caption,
               attachment.created_at
        FROM service.report_attachments attachment
        JOIN objects.object_metadata object ON object.id = attachment.object_id
        WHERE attachment.case_id = ${caseId}::uuid AND object.deleted_at IS NULL
        ORDER BY attachment.created_at, attachment.id
      `,
    sql<
      {
        id: string;
        attachment_id: string;
        status: ServiceOcrSummary["status"];
        proposed_fields: unknown;
        confirmed_fields: unknown;
        manually_confirmed_fields: string[];
        confidence: string | null;
        error_safe: string | null;
        attempt: number;
      }[]
    >`
        SELECT result.id, result.attachment_id, result.status,
               result.proposed_fields, result.confirmed_fields,
               result.manually_confirmed_fields, result.confidence,
               result.error_safe, result.attempt
        FROM service.ocr_results result
        JOIN service.report_attachments attachment
          ON attachment.id=result.attachment_id
        WHERE attachment.case_id=${caseId}::uuid
          AND result.attempt=(
            SELECT max(latest.attempt) FROM service.ocr_results latest
            WHERE latest.attachment_id=result.attachment_id
          )
        ORDER BY result.created_at, result.id
      `,
    sql<
      {
        from_status: string | null;
        to_status: string;
        reason: string | null;
        changed_at: Date;
      }[]
    >`
        SELECT from_status, to_status, reason, occurred_at AS changed_at
        FROM service.case_status_history
        WHERE case_id = ${caseId}::uuid
        ORDER BY occurred_at, id
      `,
  ]);
  if (customer === undefined)
    throw new Error("Case customer could not be read");
  const [conversationHistory, callHistory] = await Promise.all([
    Promise.all(
      conversations.map(async (row) => ({
        conversationId: row.conversation_id,
        messages: await listMessages(sql, row.conversation_id),
      })),
    ),
    calls.length === 0
      ? Promise.resolve([])
      : sql<
          {
            session_id: string;
            status: string;
            direction: string;
            outcome: string | null;
            answered: boolean | null;
            started_at: Date;
            ended_at: Date | null;
            recording_object_id: string | null;
            transcript_object_id: string | null;
          }[]
        >`
          SELECT session_id, status, direction::text, outcome, answered,
                 created_at AS started_at, ended_at, recording_object_id,
                 transcript_object_id
          FROM public.sessions
          WHERE session_id = ANY(${calls.map((row) => row.session_id)}::uuid[])
          ORDER BY started_at, session_id
        `,
  ]);
  return {
    serviceCase: serviceCaseRecord,
    customer,
    appointments,
    visits: visits.map(visit),
    reports: reports.map(reportRevision),
    conversationIds: conversations.map((row) => row.conversation_id),
    callSessionIds: calls.map((row) => row.session_id),
    conversations: conversationHistory,
    calls: callHistory.map((row) => ({
      sessionId: row.session_id,
      status: row.status,
      direction: row.direction,
      outcome: row.outcome,
      answered: row.answered,
      startedAt: row.started_at.toISOString(),
      endedAt: row.ended_at?.toISOString() ?? null,
      recordingObjectId: row.recording_object_id,
      transcriptObjectId: row.transcript_object_id,
      recordingStatus:
        row.recording_object_id === null ? "missing" : "available",
      transcriptStatus:
        row.transcript_object_id === null ? "missing" : "available",
    })),
    attachments: attachments.map((row) => ({
      id: row.id,
      objectId: row.object_id,
      visitId: row.visit_id,
      reportRevisionId: row.report_revision_id,
      category: row.category,
      source: row.source,
      processingStatus: row.processing_status,
      contentType: row.content_type,
      byteSize: Number(row.byte_size),
      caption: row.caption,
      createdAt: row.created_at.toISOString(),
    })),
    ocrResults: ocrResults.map((row) => ({
      id: row.id,
      attachmentId: row.attachment_id,
      status: row.status,
      proposedFields: storedTextRecord(row.proposed_fields),
      confirmedFields: storedTextRecord(row.confirmed_fields),
      manuallyConfirmedFields: row.manually_confirmed_fields,
      confidence: row.confidence === null ? null : Number(row.confidence),
      errorSafe: row.error_safe,
      attempt: row.attempt,
    })),
    statusHistory: statusHistory.map((row) => ({
      fromStatus: row.from_status,
      toStatus: row.to_status,
      reason: row.reason,
      changedAt: row.changed_at.toISOString(),
    })),
    summaries: summaries.map((row) => ({
      sourceKind: row.source_kind,
      status: row.status,
      summary: row.summary,
    })),
    audit: audit.map((row) => ({
      action: row.action,
      occurredAt: row.occurred_at.toISOString(),
    })),
  };
}

function objectRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function recordText(
  record: Readonly<Record<string, unknown>>,
  key: string,
  fallback: string | null = null,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

/**
 * Reads an immutable signed report using its captured customer/product and
 * tenant-branding snapshots. Superseded revisions remain part of the durable
 * report history; current tenant branding is deliberately not read.
 */
export async function getServiceReportDocument(
  sql: postgres.TransactionSql,
  revisionId: string,
): Promise<ServiceReportDocument | undefined> {
  await requireFieldService(sql);
  const rows = await sql<
    {
      case_id: string;
      visit_id: string;
      customer_snapshot: unknown;
      product_snapshot: unknown;
      branding_snapshot: unknown;
    }[]
  >`
    SELECT report.case_id, report.visit_id, revision.customer_snapshot,
           revision.product_snapshot, revision.branding_snapshot
    FROM service.report_revisions revision
    JOIN service.reports report ON report.id=revision.report_id
    WHERE revision.id=${revisionId}::uuid
      AND revision.status IN ('finalized', 'superseded')
  `;
  const row = rows[0];
  if (row === undefined) return undefined;
  const customerSnapshot = objectRecord(row.customer_snapshot);
  const signedSnapshot = signedReportFinalizationSnapshot(
    customerSnapshot,
    row.case_id,
    row.visit_id,
  );
  const dossier = await getServiceCaseDossier(sql, row.case_id);
  if (dossier === undefined) return undefined;
  const revision = dossier.reports.find((item) => item.id === revisionId);
  const visitRecord =
    signedSnapshot?.visit ??
    dossier.visits.find((item) => item.id === row.visit_id);
  const technician =
    signedSnapshot?.technician ??
    (await listTechnicians(sql, true)).find(
      (item) => item.id === visitRecord?.technicianId,
    );
  if (
    revision === undefined ||
    visitRecord === undefined ||
    technician === undefined
  )
    throw new Error("Finalized report relationships could not be read");
  const branding = objectRecord(row.branding_snapshot);
  return {
    revision,
    serviceCase: signedSnapshot?.serviceCase ?? dossier.serviceCase,
    customer:
      signedSnapshot === undefined
        ? dossier.customer
        : { ...dossier.customer, ...signedSnapshot.customer },
    visit: visitRecord,
    technician,
    customerSnapshot,
    productSnapshot: objectRecord(row.product_snapshot),
    branding: {
      businessName:
        recordText(branding, "businessName", "Service report") ??
        "Service report",
      logoData: recordText(branding, "logoData"),
      logoContentType: recordText(branding, "logoContentType"),
      accentToken: recordText(branding, "accentToken"),
      reportHeader: recordText(branding, "reportHeader"),
      reportFooter: recordText(branding, "reportFooter"),
      businessEmail: recordText(branding, "businessEmail"),
      businessPhone: recordText(branding, "businessPhone"),
      businessAddress: recordText(branding, "businessAddress"),
      locale: recordText(branding, "locale", "en") ?? "en",
      timezone: recordText(branding, "timezone", "UTC") ?? "UTC",
    },
    attachments: dossier.attachments.filter(
      (attachment) =>
        attachment.reportRevisionId === revisionId ||
        (attachment.visitId === row.visit_id &&
          (attachment.category === "arrival_signature" ||
            attachment.category === "departure_signature")),
    ),
  };
}

/**
 * Administrative archive access deliberately remains available while the
 * feature is disabled. It is read-only and never queues provider side effects.
 */
export async function listServiceCasesForArchive(
  sql: postgres.TransactionSql,
): Promise<{
  readonly records: readonly ServiceCaseSummary[];
  readonly maximumRecords: number;
  readonly complete: boolean;
}> {
  const maximumRecords = 25_000;
  const rows = await sql.unsafe<ServiceCaseRow[]>(
    `${caseProjection}
     ORDER BY service_case.updated_at DESC, service_case.id DESC LIMIT 25001`,
  );
  return {
    records: rows.slice(0, maximumRecords).map(serviceCase),
    maximumRecords,
    complete: rows.length <= maximumRecords,
  };
}

/**
 * Reads a preserved case dossier for a tenant administrator. Unlike the normal
 * workspace path this remains available while the optional module is disabled,
 * and it never schedules work or invokes a provider.
 */
export async function getServiceCaseDossierForArchive(
  sql: postgres.TransactionSql,
  caseId: string,
): Promise<ServiceCaseDossier | undefined> {
  return getServiceCaseDossierRecord(sql, caseId);
}

export async function registerFieldServiceObject(
  sql: postgres.TransactionSql,
  actorUserId: string,
  input: {
    readonly caseId: string;
    readonly category: string;
    readonly contentType: string;
    readonly byteSize: number;
    readonly checksum: string;
    readonly storageBackend: "local" | "gcs";
    readonly storageKey: string;
  },
): Promise<string> {
  await requireFieldService(sql);
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 1)
    throw new TypeError("Attachment size is invalid");
  const rows = await sql<{ id: string }[]>`
    INSERT INTO objects.object_metadata(
      tenant_id, created_by_user_id, owner_type, owner_id, category,
      content_type, byte_size, checksum, storage_backend, storage_key, status
    ) SELECT
      platform.current_tenant_id(), ${actorUserId}::uuid, 'service_case',
      service_case.id, ${requiredText(input.category, "Object category", 80)},
      ${requiredText(input.contentType, "Content type", 160)}, ${input.byteSize},
      ${requiredText(input.checksum, "Checksum", 128)}, ${input.storageBackend},
      ${requiredText(input.storageKey, "Storage key", 500)}, 'pending'
    FROM service.cases service_case WHERE service_case.id = ${input.caseId}::uuid
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (id === undefined) throw new TypeError("Service case was not found");
  return id;
}

export async function markFieldServiceObjectAvailable(
  sql: postgres.TransactionSql,
  objectId: string,
): Promise<boolean> {
  await requireFieldService(sql);
  const rows = await sql<{ id: string }[]>`
    UPDATE objects.object_metadata SET status = 'available',
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${objectId}::uuid AND owner_type = 'service_case'
      AND status = 'pending' RETURNING id
  `;
  return rows.length === 1;
}

export async function getFieldServiceObjectMetadata(
  sql: postgres.TransactionSql,
  objectId: string,
): Promise<FieldServiceObjectMetadata | undefined> {
  await requireFieldService(sql);
  return getFieldServiceObjectMetadataRecord(sql, objectId);
}

/** Authorized archive downloads remain available after tenant deactivation. */
export async function getFieldServiceObjectMetadataForArchive(
  sql: postgres.TransactionSql,
  objectId: string,
): Promise<FieldServiceObjectMetadata | undefined> {
  return getFieldServiceObjectMetadataRecord(sql, objectId);
}

async function getFieldServiceObjectMetadataRecord(
  sql: postgres.TransactionSql,
  objectId: string,
): Promise<FieldServiceObjectMetadata | undefined> {
  const rows = await sql<
    {
      id: string;
      case_id: string;
      category: string;
      content_type: string;
      byte_size: string;
      checksum: string;
      storage_backend: "local" | "gcs";
      storage_key: string;
      status: FieldServiceObjectMetadata["status"];
    }[]
  >`
    SELECT object.id,
           CASE WHEN object.owner_type='service_case' THEN object.owner_id
                ELSE linked.case_id END AS case_id,
           object.category, object.content_type, object.byte_size, object.checksum,
           object.storage_backend, object.storage_key, object.status
    FROM objects.object_metadata object
    LEFT JOIN LATERAL (
      SELECT attachment.case_id
      FROM service.report_attachments attachment
      WHERE attachment.object_id=object.id
      ORDER BY attachment.created_at, attachment.id LIMIT 1
    ) linked ON true
    WHERE object.id = ${objectId}::uuid
      AND object.deleted_at IS NULL
      AND ((object.owner_type='service_case' AND object.owner_id IS NOT NULL)
        OR (object.owner_type='message' AND linked.case_id IS NOT NULL))
  `;
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        id: row.id,
        caseId: row.case_id,
        category: row.category,
        contentType: row.content_type,
        byteSize: Number(row.byte_size),
        checksum: row.checksum,
        storageBackend: row.storage_backend,
        storageKey: row.storage_key,
        status: row.status,
      };
}
