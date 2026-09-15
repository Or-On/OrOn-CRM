import { NextResponse } from "next/server";

import { getFieldServiceObjectMetadataForArchive } from "@or-on/crm";

import { withCurrentTenant } from "../../../../../../../features/auth";
import { crmErrorResponse } from "../../../../../../../features/crm-route";
import { readPrivateObject } from "../../../../../../../features/private-objects";
import { uuid } from "../../../../../../../features/field-service";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/settings/field-service/archive/objects/[id]">,
) {
  try {
    const { id } = await context.params;
    const objectId = uuid(id, "Archive object");
    const metadata = await withCurrentTenant(
      "tenant:manage",
      async (sql, session) => {
        const record = await getFieldServiceObjectMetadataForArchive(
          sql,
          objectId,
        );
        if (record?.status !== "available") return undefined;
        await sql`
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id, metadata
          ) VALUES (
            platform.current_tenant_id(), ${session.userId}::uuid,
            'field_service.archive.object_downloaded', 'service_case',
            ${record.caseId}::uuid,
            ${sql.json({
              category: record.category,
              objectId: record.id,
            })}
          )
        `;
        return record;
      },
    );
    if (metadata === undefined)
      return NextResponse.json(
        { error: "Archive object not found" },
        { status: 404 },
      );
    if (metadata.storageBackend !== "local")
      return NextResponse.json(
        { error: "The configured private object adapter is unavailable" },
        { status: 503 },
      );
    const bytes = await readPrivateObject(metadata.storageKey, metadata);
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="${metadata.id}"`,
        "content-length": String(bytes.byteLength),
        "content-type": metadata.contentType,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
