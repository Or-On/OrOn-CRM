import { notFound, redirect } from "next/navigation";
import {
  getFieldServiceFeatureState,
  getTenantSettings,
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
import {
  dossierForVoiceAccess,
  linkCandidatesForVoiceAccess,
  ServiceCaseWorkspace,
  uuidPattern,
} from "../../../../features/field-service";

export default async function ServiceCasePage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  if (!uuidPattern.test(id)) notFound();

  let data;
  try {
    data = await withCurrentTenant(
      "field-service:read",
      async (sql, session) => {
        const feature = await getFieldServiceFeatureState(sql);
        if (!feature.effective)
          throw new ForbiddenError("Field service disabled");
        const canManage = isAuthorized(
          { role: session.tenant.role, isSuperuser: session.isSuperuser },
          "field-service:manage",
        );
        const canReadVoice = isAuthorized(
          { role: session.tenant.role, isSuperuser: session.isSuperuser },
          "voice:read",
        );
        const [dossier, technicians, linkCandidates, settings] =
          await Promise.all([
            getServiceCaseDossier(sql, id),
            listTechnicians(sql),
            canManage
              ? listServiceCaseLinkCandidates(sql, id)
              : Promise.resolve(undefined),
            getTenantSettings(sql),
          ]);
        return {
          dossier:
            dossier === undefined
              ? undefined
              : dossierForVoiceAccess(dossier, canReadVoice),
          technicians,
          timezone: settings.timezone,
          feature,
          canManage,
          linkCandidates:
            linkCandidates === undefined
              ? undefined
              : linkCandidatesForVoiceAccess(linkCandidates, canReadVoice),
          canOperate: isAuthorized(
            { role: session.tenant.role, isSuperuser: session.isSuperuser },
            "field-service:operate",
          ),
          canReadVoice,
        };
      },
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
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
        timezone={data.timezone}
      />
    </main>
  );
}
