import { redirect } from "next/navigation";
import {
  getFieldServiceFeatureState,
  getTenantSettings,
  listContacts,
  listServiceAppointments,
  listServiceCasePage,
  listTeamMembers,
  listTechnicians,
} from "@or-on/crm";
import { isAuthorized } from "@or-on/auth";

import { AccessDenied } from "../../i18n/access-denied";
import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../features/auth";
import { FieldServiceWorkspace } from "../../features/field-service";

export default async function FieldServicePage() {
  try {
    const data = await withCurrentTenant(
      "field-service:read",
      async (sql, session) => {
        const feature = await getFieldServiceFeatureState(sql);
        if (!feature.effective)
          throw new ForbiddenError("Field service disabled");
        const principal = {
          role: session.tenant.role,
          isSuperuser: session.isSuperuser,
        };
        const canManage = isAuthorized(principal, "field-service:manage");
        const [
          casePage,
          appointments,
          technicians,
          contacts,
          settings,
          teamMembers,
        ] = await Promise.all([
          listServiceCasePage(sql, { limit: 50 }),
          listServiceAppointments(sql),
          listTechnicians(sql, canManage),
          listContacts(sql, { limit: 100 }),
          getTenantSettings(sql),
          canManage ? listTeamMembers(sql) : Promise.resolve([]),
        ]);
        return {
          appointments,
          cases: casePage.cases,
          nextCaseCursor: casePage.nextCursor,
          contacts,
          feature,
          technicians,
          technicianAccounts: teamMembers.filter(
            (member) => member.role === "technician",
          ),
          timezone: settings.timezone,
          canManage,
          canOperate: isAuthorized(principal, "field-service:operate"),
        };
      },
    );
    return (
      <main className="page page--wide page--field-service page--workspace-premium">
        <FieldServiceWorkspace {...data} />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const metadata = { title: "Field service" };
