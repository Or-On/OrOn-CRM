import { validateTenantSupportText } from "@or-on/crm/support-profile-text";

/** Tenant-authored business information, never action or publication authority. */
export interface TenantBusinessContext {
  readonly businessDescription?: string;
  readonly productsAndServices?: readonly string[];
}

/** Project only business prose from the current tenant's scoped settings lookup. */
export function tenantBusinessContext(
  profile: unknown,
): TenantBusinessContext | undefined {
  if (profile === null || typeof profile !== "object" || Array.isArray(profile))
    return undefined;
  const input = profile as Readonly<Record<string, unknown>>;
  const selected = {
    ...(input.businessDescription === undefined ||
    input.businessDescription === null
      ? {}
      : { businessDescription: input.businessDescription }),
    ...(input.productsAndServices === undefined
      ? {}
      : { productsAndServices: input.productsAndServices }),
  };
  validateTenantSupportText(selected);
  if (Object.keys(selected).length === 0) return undefined;
  return {
    ...(typeof selected.businessDescription === "string"
      ? { businessDescription: selected.businessDescription }
      : {}),
    ...(Array.isArray(selected.productsAndServices)
      ? {
          productsAndServices: [
            ...(selected.productsAndServices as readonly string[]),
          ],
        }
      : {}),
  };
}
