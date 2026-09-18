import { describe, expect, it } from "vitest";

import { capabilityRequiredFeature } from "./agent-capabilities.js";
import {
  tenantFeatureKeys,
  tenantFeatureRegistry,
  tenantTemplateRegistry,
} from "./tenant-features.js";

describe("tenant operations configuration", () => {
  it("defines every dependency through the canonical catalog", () => {
    expect(Object.keys(tenantFeatureRegistry).sort()).toEqual(
      [...tenantFeatureKeys].sort(),
    );
    for (const feature of Object.values(tenantFeatureRegistry))
      for (const dependency of feature.dependencies)
        expect(tenantFeatureKeys).toContain(dependency);
    expect(tenantFeatureRegistry.technicians.dependencies).toContain(
      "field_service",
    );
    expect(tenantFeatureRegistry.ocr.dependencies).toContain("documents");
  });

  it("keeps the four starting points materially different", () => {
    expect(tenantTemplateRegistry.field_service.features).toContain(
      "field_service",
    );
    expect(tenantTemplateRegistry.field_service.features).not.toContain(
      "leads",
    );
    expect(tenantTemplateRegistry.lead_generation.features).toContain("leads");
    expect(tenantTemplateRegistry.lead_generation.features).not.toContain(
      "tickets",
    );
    expect(tenantTemplateRegistry.customer_support.features).toContain(
      "tickets",
    );
    expect(tenantTemplateRegistry.blank.features).toEqual(["contacts"]);
  });

  it("maps executable agent capabilities back to tenant modules", () => {
    expect(capabilityRequiredFeature("lead.write")).toBe("leads");
    expect(capabilityRequiredFeature("lead.finalize")).toBe("leads");
    expect(capabilityRequiredFeature("ticket.open")).toBe("tickets");
  });
});
