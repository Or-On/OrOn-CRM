/** Platform management is available only while working in the main Or-On tenant. */
export const MAIN_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export function canManageTenants(
  isSuperuser: boolean,
  activeTenantId: string,
): boolean {
  return isSuperuser && activeTenantId === MAIN_TENANT_ID;
}
