/** Browser-safe limits shared by the settings form and persistence validator.
 * These are business facts, never authority to enable tools or publish knowledge.
 * Keep the voice-runtime limits in dispatcher_runtime.support_context aligned.
 */
export const tenantSupportTextLimits = {
  businessDescription: 12_000,
  productsAndServices: 64,
  productOrService: 4_000,
  profileBytes: 65_536,
} as const;

export function validateTenantSupportText(profile: {
  readonly businessDescription?: unknown;
  readonly productsAndServices?: unknown;
}): void {
  const description = profile.businessDescription;
  if (
    description !== undefined &&
    (typeof description !== "string" ||
      description.trim().length === 0 ||
      description.length > tenantSupportTextLimits.businessDescription)
  )
    throw new TypeError("tenant business description exceeds text limits");
  const services = profile.productsAndServices;
  if (
    services !== undefined &&
    (!Array.isArray(services) ||
      services.length > tenantSupportTextLimits.productsAndServices ||
      services.some(
        (item) =>
          typeof item !== "string" ||
          item.trim().length === 0 ||
          item.length > tenantSupportTextLimits.productOrService,
      ))
  )
    throw new TypeError("tenant products and services exceed text limits");
  if (
    new TextEncoder().encode(JSON.stringify(profile)).byteLength >
    tenantSupportTextLimits.profileBytes
  )
    throw new TypeError("tenant support profile exceeds total text limit");
}
