import { NextResponse } from "next/server";

import {
  createSafeZipArchive,
  getCustomerDocumentObjectMetadata,
  getFieldServiceObjectMetadataForArchive,
  getServiceCaseDossierForArchive,
  safeArchiveSegment,
} from "@or-on/crm";

import { withCurrentTenant } from "../../../../../../features/auth";
import { crmErrorResponse } from "../../../../../../features/crm-route";
import { uuid } from "../../../../../../features/field-service";
import { readPrivateObject } from "../../../../../../features/private-objects";

function archiveName(reference: string): string {
  return reference.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 100) || "case";
}

function extension(contentType: string): string {
  return (
    {
      "application/pdf": ".pdf",
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
      "text/plain": ".txt",
    }[contentType] ?? ".bin"
  );
}

function exportRecord(
  dossier: NonNullable<
    Awaited<ReturnType<typeof getServiceCaseDossierForArchive>>
  >,
) {
  return {
    exportedAt: new Date().toISOString(),
    dossier: {
      ...dossier,
      attachments: dossier.attachments.map((attachment) => ({
        ...attachment,
        downloadPath: `/api/settings/field-service/archive/objects/${attachment.objectId}`,
      })),
      calls: dossier.calls.map((call) => ({
        ...call,
        detailPath: `/voice/calls/${call.sessionId}`,
      })),
      customer: {
        ...dossier.customer,
        documents: dossier.customer.documents.map((document) => ({
          ...document,
          downloadPath: `/api/crm/contacts/${dossier.customer.contactId}/documents/${document.id}`,
        })),
      },
    },
    schemaVersion: 1,
  } as const;
}

export async function GET(
  request: Request,
  context: RouteContext<"/api/settings/field-service/archive/[id]">,
) {
  try {
    const format = new URL(request.url).searchParams.get("format") ?? "json";
    if (format !== "json" && format !== "zip")
      throw new TypeError("Archive format must be json or zip");
    const { id } = await context.params;
    const caseId = uuid(id, "Service case");
    const result = await withCurrentTenant(
      "tenant:manage",
      async (sql, session) => {
        const dossier = await getServiceCaseDossierForArchive(sql, caseId);
        if (dossier === undefined) return undefined;
        const record = exportRecord(dossier);
        let zip: Buffer | undefined;
        if (format === "zip") {
          const uniqueAttachments = [
            ...new Map(
              dossier.attachments.map((attachment) => [
                attachment.objectId,
                attachment,
              ]),
            ).values(),
          ];
          const [attachmentMetadata, documentMetadata] = await Promise.all([
            Promise.all(
              uniqueAttachments.map((attachment) =>
                getFieldServiceObjectMetadataForArchive(
                  sql,
                  attachment.objectId,
                ),
              ),
            ),
            Promise.all(
              dossier.customer.documents.map((document) =>
                getCustomerDocumentObjectMetadata(
                  sql,
                  dossier.customer.contactId,
                  document.id,
                ),
              ),
            ),
          ]);
          const readableAttachments = attachmentMetadata.flatMap((metadata) =>
            metadata?.status === "available" ? [metadata] : [],
          );
          const readableDocuments = documentMetadata.flatMap((metadata) =>
            metadata?.status === "available" ? [metadata] : [],
          );
          if (readableAttachments.length + readableDocuments.length > 200)
            throw new TypeError(
              "The case archive contains more than 200 evidence files",
            );
          const expectedBytes = [
            ...readableAttachments,
            ...readableDocuments,
          ].reduce((total, metadata) => total + metadata.byteSize, 0);
          if (expectedBytes > 250 * 1024 * 1024)
            throw new TypeError(
              "The case archive exceeds the 250 MB evidence limit",
            );
          if (
            [...readableAttachments, ...readableDocuments].some(
              (metadata) => metadata.storageBackend !== "local",
            )
          )
            throw new Error(
              "The configured private object adapter is unavailable",
            );

          const entries: {
            path: string;
            bytes: Uint8Array | string;
            modifiedAt?: Date;
          }[] = [
            {
              path: "dossier.json",
              bytes: JSON.stringify(record, null, 2),
            },
          ];
          for (const metadata of readableAttachments) {
            const attachment = uniqueAttachments.find(
              (candidate) => candidate.objectId === metadata.id,
            );
            entries.push({
              path: `Evidence/${safeArchiveSegment(attachment?.category ?? "evidence")}-${metadata.id}${extension(metadata.contentType)}`,
              bytes: await readPrivateObject(metadata.storageKey, metadata),
            });
          }
          for (const metadata of readableDocuments)
            entries.push({
              path: `Customer documents/${metadata.id}-${safeArchiveSegment(metadata.displayName)}`,
              bytes: await readPrivateObject(metadata.storageKey, metadata),
            });
          zip = createSafeZipArchive(entries, {
            maximumEntries: 201,
            maximumUncompressedBytes: 251 * 1024 * 1024,
          });
        }
        await sql`
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id, metadata
          ) VALUES (
            platform.current_tenant_id(), ${session.userId}::uuid,
            'field_service.archive.dossier_exported', 'service_case',
            ${caseId}::uuid,
            ${sql.json({
              attachmentCount: dossier.attachments.length,
              callCount: dossier.calls.length,
              conversationCount: dossier.conversations.length,
              format,
              reportRevisionCount: dossier.reports.length,
            })}
          )
        `;
        return { dossier, record, zip };
      },
    );
    if (result === undefined)
      return NextResponse.json(
        { error: "Service case not found" },
        { status: 404 },
      );
    if (format === "zip") {
      if (result.zip === undefined)
        throw new Error("The case archive could not be generated");
      const name = archiveName(result.dossier.serviceCase.reference);
      return new NextResponse(Uint8Array.from(result.zip).buffer, {
        headers: {
          "cache-control": "private, no-store",
          "content-disposition": `attachment; filename="field-service-${name}.zip"`,
          "content-length": String(result.zip.byteLength),
          "content-type": "application/zip",
          "x-content-type-options": "nosniff",
        },
      });
    }
    return NextResponse.json(result.record, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="field-service-${archiveName(result.dossier.serviceCase.reference)}.json"`,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
