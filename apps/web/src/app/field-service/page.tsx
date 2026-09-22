import { redirect } from "next/navigation";
import {
  getFieldServiceFeatureState,
  getServiceDirectory,
  getTechnicianSessionContext,
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
        const canOperate = isAuthorized(principal, "field-service:operate");
        const isTechnician = session.tenant.role === "technician";
        // The physical technician belongs to this browser session, not to
        // the (possibly shared) platform account.
        const technicianSession = isTechnician
          ? await getTechnicianSessionContext(sql)
          : undefined;
        const [
          casePage,
          appointments,
          technicians,
          contacts,
          settings,
          teamMembers,
          directory,
        ] = await Promise.all([
          listServiceCasePage(sql, { limit: 50 }),
          listServiceAppointments(sql),
          listTechnicians(sql, canManage),
          listContacts(sql, { limit: 100 }),
          getTenantSettings(sql),
          canManage ? listTeamMembers(sql) : Promise.resolve([]),
          canManage || (isTechnician && canOperate)
            ? getServiceDirectory(sql)
            : Promise.resolve({ stores: [] }),
        ]);
        return {
          appointments,
          cases: casePage.cases,
          nextCaseCursor: casePage.nextCursor,
          contacts,
          serviceStores: directory.stores,
          feature,
          technicians,
          technicianAccounts: teamMembers.filter(
            (member) => member.role === "technician",
          ),
          timezone: settings.timezone,
          canManage,
          isTechnician,
          canOperate,
          ...(technicianSession === undefined ? {} : { technicianSession }),
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

export const metadata = { title: "Field Service" };
