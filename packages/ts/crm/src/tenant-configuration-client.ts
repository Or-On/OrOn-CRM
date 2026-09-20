/** Browser-safe template construction. No server CRM barrel imports. */
import { tenantTemplateRegistry } from "./tenant-features.js";
import { retailServiceWorkflowPolicy } from "./service-workflow.js";
import type { TenantConfiguration } from "./tenant-configuration.js";

export function configurationFromTemplate(
  key: keyof typeof tenantTemplateRegistry,
): TenantConfiguration {
  return {
    schemaVersion: 1,
    templateKey: key,
    features: tenantTemplateRegistry[key].features,
    featureConfiguration:
      key === "field_service"
        ? { field_service: { workflow: { ...retailServiceWorkflowPolicy } } }
        : {},
    processes: [],
  };
}
