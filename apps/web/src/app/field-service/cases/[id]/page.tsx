import { notFound, redirect } from "next/navigation";
import {
  getFieldServiceFeatureState,
  getServiceCaseDossier,
  listServiceCaseLinkCandidates,
  listTechnicians,
} from "@or-on/crm";
import { isAuthorized } from "@or-on/auth";

import { AccessDenied } from "../../../../i18n/access-denied";
import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../../../features/auth";
import { ServiceCaseWorkspace } from "../../../../features/field-service";

export default async function ServiceCasePage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  try {
    const { id } = await params;
    const data = await withCurrentTenant(
      "field-service:read",
      async (sql, session) => {
        const feature = await getFieldServiceFeatureState(sql);
        if (!feature.effective)
          throw new ForbiddenError("Field service disabled");
        const canManage = isAuthorized(
          { role: session.tenant.role, isSuperuser: session.isSuperuser },
          "field-service:manage",
        );
        const [dossier, technicians, linkCandidates] = await Promise.all([
          getServiceCaseDossier(sql, id),
          listTechnicians(sql),
          canManage
            ? listServiceCaseLinkCandidates(sql, id)
            : Promise.resolve(undefined),
        ]);
        return {
          dossier,
          technicians,
          feature,
          canManage,
          linkCandidates,
          canOperate: isAuthorized(
            { role: session.tenant.role, isSuperuser: session.isSuperuser },
            "field-service:operate",
          ),
          canReadVoice: isAuthorized(
            { role: session.tenant.role, isSuperuser: session.isSuperuser },
            "voice:read",
          ),
        };
      },
    );
    if (data.dossier === undefined) notFound();
    return (
      <main className="page page--wide page--field-service page--workspace-premium">
        <ServiceCaseWorkspace
          canOperate={data.canOperate}
          canManage={data.canManage}
          canReadVoice={data.canReadVoice}
          dossier={data.dossier}
          feature={data.feature}
          linkCandidates={data.linkCandidates}
          technicians={data.technicians}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
