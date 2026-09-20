import { describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import {
  configurationFromTemplate,
  parseTenantConfiguration,
  validateTenantConfiguration,
} from "./tenant-configuration.js";

describe("reviewed tenant packages", () => {
  it("supports the three business models without tenant-name conditions", () => {
    const leadSupport = parseTenantConfiguration(
      configurationFromTemplate("leads_support"),
    );
    const field = parseTenantConfiguration(
      configurationFromTemplate("field_service"),
    );
    const leads = parseTenantConfiguration(
      configurationFromTemplate("leads_only"),
    );
    expect(leadSupport.features).toEqual(
      expect.arrayContaining(["leads", "tickets", "whatsapp", "voice"]),
    );
    expect(leadSupport.features).not.toContain("technicians");
    expect(field.features).toEqual(
      expect.arrayContaining(["tickets", "field_service", "technicians"]),
    );
    expect(field.features).not.toContain("leads");
    expect(leads.features).toEqual(["contacts", "leads"]);
    const policy = field.featureConfiguration.field_service?.workflow as {
      requiredIntakeFields: readonly string[];
    };
    expect(policy.requiredIntakeFields).toContain("chainName");
    expect(policy.requiredIntakeFields).not.toContain("nationalId");
  });

  it("rejects unknown modules, missing dependencies and invalid policy data", () => {
    const base = configurationFromTemplate("blank");
    expect(() =>
      parseTenantConfiguration({
        ...base,
        features: ["contacts", "custom_code"],
      }),
    ).toThrow("Unknown module");
    expect(() =>
      parseTenantConfiguration({
        ...base,
        features: ["contacts", "technicians"],
      }),
    ).toThrow("requires Field service");
    expect(() =>
      parseTenantConfiguration({
        ...base,
        featureConfiguration: { leads: { code: "execute" } },
      }),
    ).toThrow();
    expect(() =>
      parseTenantConfiguration({
        ...base,
        featureConfiguration: { field_service: { workflow: { version: 1 } } },
      }),
    ).toThrow();
  });

  it("allows incomplete draft bindings but blocks publishing them", async () => {
    const configuration = parseTenantConfiguration({
      ...configurationFromTemplate("leads_support"),
      processes: [
        {
          name: "Inbound support",
          trigger: "voice.inbound",
          enabled: true,
          channel: "voice",
        },
      ],
    });
    const sql = vi.fn() as unknown as postgres.TransactionSql;
    await expect(
      validateTenantConfiguration(sql, configuration),
    ).rejects.toThrow("published agent and flow");
    expect(sql).not.toHaveBeenCalled();
  });

  it("checks proposed process permissions against the proposed package", async () => {
    const sql = vi.fn().mockResolvedValue([
      {
        channels: ["whatsapp"],
        flow_channels: ["whatsapp"],
        tool_permissions: ["ticket.open"],
        flow_agent: null,
      },
    ]) as unknown as postgres.TransactionSql;
    const configuration = parseTenantConfiguration({
      ...configurationFromTemplate("lead_generation"),
      processes: [
        {
          name: "Support",
          trigger: "whatsapp.new_conversation",
          enabled: true,
          channel: "whatsapp",
          agentProfileVersionId: "10000000-0000-4000-8000-000000000001",
          flowVersionId: "20000000-0000-4000-8000-000000000001",
        },
      ],
    });
    await expect(
      validateTenantConfiguration(sql, configuration),
    ).rejects.toThrow("enable Tickets");
  });

  it("rejects trigger/channel mismatches and ambiguous priority", async () => {
    const sql = vi.fn() as unknown as postgres.TransactionSql;
    const process = {
      name: "Support",
      trigger: "voice.inbound",
      enabled: true,
      channel: "whatsapp",
      agentProfileVersionId: "10000000-0000-4000-8000-000000000001",
      flowVersionId: "20000000-0000-4000-8000-000000000001",
    };
    await expect(
      validateTenantConfiguration(
        sql,
        parseTenantConfiguration({
          ...configurationFromTemplate("leads_support"),
          processes: [process],
        }),
      ),
    ).rejects.toThrow("channel does not match");
    await expect(
      validateTenantConfiguration(
        sql,
        parseTenantConfiguration({
          ...configurationFromTemplate("leads_support"),
          processes: [
            { ...process, channel: "voice" },
            { ...process, name: "Other", channel: null },
          ],
        }),
      ),
    ).rejects.toThrow("same routing priority");
  });
});
