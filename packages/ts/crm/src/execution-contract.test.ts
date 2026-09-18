import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildAgentExecutionContract,
  executionConfigurationHash,
  executionContractDiagnostics,
  executionContractPreview,
  ExecutionContractError,
  type AgentVersionRow,
  type ExecutionContractInput,
} from "./execution-contract.js";
import { parseLeadFieldSchema } from "./lead-schema.js";

const schema = parseLeadFieldSchema({
  schemaVersion: "1.0",
  fields: [
    {
      key: "preferred_name",
      label: "Preferred name",
      type: "text",
      required: true,
    },
    { key: "company", label: "Company", type: "text", required: false },
  ],
});

function version(overrides: Partial<AgentVersionRow> = {}): AgentVersionRow {
  return {
    agentProfileId: "00000000-0000-4000-8000-000000000001",
    agentProfileVersionId: "00000000-0000-4000-8000-000000000002",
    version: 3,
    systemPrompt: "You are the Hebrew-speaking lead coordinator.",
    locale: "he",
    channelCapabilities: ["voice", "whatsapp"],
    toolPermissions: ["lead.write"],
    channelConfiguration: { roleTitle: "the lead coordinator" },
    publishedAt: new Date("2026-09-01T00:00:00.000Z"),
    validationStatus: "valid",
    ...overrides,
  };
}

function input(
  overrides: Partial<ExecutionContractInput> = {},
): ExecutionContractInput {
  return {
    tenantId: "00000000-0000-4000-8000-0000000000aa",
    contactId: "00000000-0000-4000-8000-0000000000bb",
    channel: "whatsapp",
    interaction: {
      kind: "whatsapp_conversation",
      id: "00000000-0000-4000-8000-0000000000cc",
      ownershipEpoch: "7",
    },
    authorizedUserId: "00000000-0000-4000-8000-0000000000dd",
    assignmentSource: "explicit_assignment",
    version: version(),
    ...overrides,
  };
}

describe("the contract resolves one explicit configuration", () => {
  it("pins the exact assigned version, prompt, role and capabilities", () => {
    const contract = buildAgentExecutionContract(input());

    expect(contract.agentProfileVersionId).toBe(
      "00000000-0000-4000-8000-000000000002",
    );
    expect(contract.agentVersion).toBe(3);
    expect(contract.agentPrompt).toBe(
      "You are the Hebrew-speaking lead coordinator.",
    );
    expect(contract.roleTitle).toBe("the lead coordinator");
    // lead.write implies lead.read: writing blind would overwrite.
    expect(contract.capabilities).toEqual(["lead.read", "lead.write"]);
    expect(contract.assignmentSource).toBe("explicit_assignment");
  });

  it("refuses a version other than the one the operator assigned", () => {
    expect(() =>
      buildAgentExecutionContract(
        input({
          expectedAgentVersionId: "00000000-0000-4000-8000-00000000ffff",
        }),
      ),
    ).toThrow(/does not match the assigned one/u);
  });

  it("refuses to run a draft", () => {
    expect(() =>
      buildAgentExecutionContract(
        input({ version: version({ publishedAt: null }) }),
      ),
    ).toThrow(/draft/u);
  });

  it("refuses a version that was never validated", () => {
    expect(() =>
      buildAgentExecutionContract(
        input({ version: version({ validationStatus: "invalid" }) }),
      ),
    ).toThrow(/not valid/u);
  });

  it("refuses a channel the published version does not cover", () => {
    expect(() =>
      buildAgentExecutionContract(
        input({ version: version({ channelCapabilities: ["voice"] }) }),
      ),
    ).toThrow(/does not support the whatsapp channel/u);
  });

  it("refuses an empty prompt rather than running an anonymous agent", () => {
    expect(() =>
      buildAgentExecutionContract(
        input({ version: version({ systemPrompt: "   " }) }),
      ),
    ).toThrow(ExecutionContractError);
  });

  it("drops a stored permission the platform no longer recognises", () => {
    const contract = buildAgentExecutionContract(
      input({
        version: version({ toolPermissions: ["lead.read", "legacy.freeform"] }),
      }),
    );

    expect(contract.capabilities).toEqual(["lead.read"]);
  });

  it("carries the originating conversation and handoff of a continued interaction", () => {
    const contract = buildAgentExecutionContract(
      input({
        channel: "voice",
        interaction: {
          kind: "voice_session",
          id: "session-1",
          ownershipEpoch: null,
        },
        assignmentSource: "handoff",
        originatingConversationId: "00000000-0000-4000-8000-0000000000cc",
        handoffId: "00000000-0000-4000-8000-0000000000ee",
        leadId: "00000000-0000-4000-8000-0000000000ff",
      }),
    );

    expect(contract.originatingConversationId).toBe(
      "00000000-0000-4000-8000-0000000000cc",
    );
    expect(contract.handoffId).toBe("00000000-0000-4000-8000-0000000000ee");
    expect(contract.leadId).toBe("00000000-0000-4000-8000-0000000000ff");
  });
});

describe("a pinned field schema travels with the version", () => {
  it("refuses to start when the pinned schema was not loaded", () => {
    expect(() =>
      buildAgentExecutionContract(
        input({
          version: version({
            channelConfiguration: {
              leadFieldSchemaId: "00000000-0000-4000-8000-000000000123",
            },
          }),
        }),
      ),
    ).toThrow(/pins a lead field schema that was not loaded/u);
  });

  it("refuses a schema that is not the pinned one", () => {
    expect(() =>
      buildAgentExecutionContract(
        input({
          version: version({
            channelConfiguration: {
              leadFieldSchemaId: "00000000-0000-4000-8000-000000000123",
            },
          }),
          leadFieldSchema: {
            id: "00000000-0000-4000-8000-000000000999",
            version: 1,
            schema,
          },
        }),
      ),
    ).toThrow(/not the one this agent version pins/u);
  });

  it("accepts the pinned schema and exposes its reviewed fields", () => {
    const contract = buildAgentExecutionContract(
      input({
        version: version({
          channelConfiguration: {
            leadFieldSchemaId: "00000000-0000-4000-8000-000000000123",
          },
        }),
        leadFieldSchema: {
          id: "00000000-0000-4000-8000-000000000123",
          version: 2,
          schema,
        },
      }),
    );

    expect(contract.leadFieldSchema?.version).toBe(2);
    expect(executionContractPreview(contract).leadFields).toEqual([
      "preferred_name",
      "company",
    ]);
  });
});

describe("diagnostics stay safe to log", () => {
  it("records identifiers and a hash, never the prompt or the customer", () => {
    const diagnostics = executionContractDiagnostics(
      buildAgentExecutionContract(input()),
    );
    const serialized = JSON.stringify(diagnostics);

    expect(serialized).not.toContain("lead coordinator");
    expect(serialized).not.toContain("0000000000bb");
    expect(diagnostics.agentVersionId).toBe(
      "00000000-0000-4000-8000-000000000002",
    );
    expect(diagnostics.assignmentSource).toBe("explicit_assignment");
    expect(diagnostics.configurationHash).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("gives the same hash to the same configuration and a different one to a revision", () => {
    const first = buildAgentExecutionContract(input());
    const same = buildAgentExecutionContract(input());
    const revised = buildAgentExecutionContract(
      input({ version: version({ systemPrompt: "A different objective." }) }),
    );
    const widened = buildAgentExecutionContract(
      input({
        version: version({ toolPermissions: ["lead.write", "lead.finalize"] }),
      }),
    );

    expect(executionConfigurationHash(same)).toBe(
      executionConfigurationHash(first),
    );
    expect(executionConfigurationHash(revised)).not.toBe(
      executionConfigurationHash(first),
    );
    expect(executionConfigurationHash(widened)).not.toBe(
      executionConfigurationHash(first),
    );
  });

  it("shows effective instructions only in the authorised preview", () => {
    const contract = buildAgentExecutionContract(input());

    expect(executionContractPreview(contract).agentPrompt).toBe(
      contract.agentPrompt,
    );
    expect(Object.keys(executionContractDiagnostics(contract))).not.toContain(
      "agentPrompt",
    );
  });
});

describe("voice and WhatsApp resolve the same contract", () => {
  /**
   * The Python voice runtime builds its own dictionary. A rename on one side
   * would leave the other channel silently reading `undefined`, so the field
   * names are asserted against the actual Python source rather than a copy.
   */
  it("uses the same field names in the Python voice resolver", () => {
    const source = readFileSync(
      new URL(
        "../../../../services/py/dispatcher/src/dispatcher_runtime/persistence.py",
        import.meta.url,
      ),
      "utf8",
    );
    const resolver = source.slice(
      source.indexOf("async def get_voice_configuration"),
      source.indexOf("async def get_identity_verification_requirements"),
    );

    expect(resolver).not.toBe("");
    for (const field of [
      "agentVersionId",
      "systemPrompt",
      "roleTitle",
      "capabilities",
      "leadFieldSchemaId",
    ])
      expect(resolver).toContain(`"${field}"`);
  });
});
