import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { isAuthorized } from "@or-on/auth";
import {
  getFieldServiceFeatureState,
  getTenantSettings,
  listServiceOcrQueuePage,
} from "@or-on/crm";

import { AccessDenied } from "../../../i18n/access-denied";
import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../../features/auth";
import { OcrReviewWorkspace } from "../../../features/field-service";

export default async function FieldServiceOcrPage() {
  try {
    const data = await withCurrentTenant(
      "field-service:read",
      async (sql, session) => {
        const feature = await getFieldServiceFeatureState(sql);
        if (!feature.effective)
          throw new ForbiddenError("Field service disabled");
        const [initialPage, settings] = await Promise.all([
          listServiceOcrQueuePage(sql, { view: "attention", limit: 24 }),
          getTenantSettings(sql),
        ]);
        return {
          canOperate: isAuthorized(
            {
              role: session.tenant.role,
              isSuperuser: session.isSuperuser,
            },
            "field-service:operate",
          ),
          feature,
          initialPage,
          timezone: settings.timezone,
        };
      },
    );
    return (
      <main className="page page--wide page--field-service page--workspace-premium">
        <OcrReviewWorkspace {...data} />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const metadata: Metadata = {
  title: "Field Service OCR review",
  description: "Tenant-scoped Field Service OCR review queue.",
};
