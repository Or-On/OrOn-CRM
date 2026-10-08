import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  fieldIntakeModel,
  type FieldIntakeModelProjection,
} from "./field-intake-model.js";
import {
  createModelCredentialResolver,
  sealModelCredential,
} from "./model-credentials.js";
import type {
  FieldServiceAiProvider,
  FieldServiceAttemptHooks,
} from "./field-service-provider.js";

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const key = randomBytes(32),
    tenantId = randomUUID(),
    id = randomUUID(),
    credentialId = randomUUID();
  const projection: FieldIntakeModelProjection = {
    tenantId,
    agentVersionId: randomUUID(),
    ownershipEpoch: "1",
    actorUserId: randomUUID(),
    configuration: {
      id,
      tenantId,
      credentialId,
      provider: "gemini",
      model: "gemini-3.5-flash-lite",
      enabled: true,
      settings: {
        fallbackModel: "gemini-3.1-flash-lite",
        maxTokens: 100,
        timeoutMs: 3000,
      },
      dailyRequestLimit: 2,
    },
    credential: sealModelCredential(
      { tenantId, modelConfigurationId: id, credentialId, provider: "gemini" },
      "fictional-tenant-key",
      key,
    ),
  };
  return {
    projection,
    decrypt: createModelCredentialResolver(new Map([["env:model:v2", key]])),
  };
}
const deployment: FieldServiceAiProvider = {
  providerName: "fictional",
  modelName: "deployment",
  extractIntake: vi.fn(),
  extractProductLabel: vi.fn(),
  summarizeEvidence: vi.fn(),
};
it("only a null binding permits the deployment route", async () => {
  const { projection } = fixture();
  await expect(
    fieldIntakeModel(
      { ...projection, configuration: null, credential: null },
      deployment,
      undefined,
    ),
  ).resolves.toBe(deployment);
  await expect(
    fieldIntakeModel(projection, deployment, undefined),
  ).rejects.toThrow("unavailable");
});
it("uses the tenant key, endpoint, settings and distinct fallback model", async () => {
  const { projection, decrypt } = fixture();
  const provider = await fieldIntakeModel(projection, deployment, decrypt);
  const transport = vi
    .fn()
    .mockResolvedValueOnce(new Response("busy", { status: 429 }))
    .mockResolvedValueOnce(
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({ summary: "Synthetic summary" }),
            },
          },
        ],
      }),
    );
  vi.stubGlobal("fetch", transport);
  const beforeAttempt = vi
    .fn<FieldServiceAttemptHooks["beforeAttempt"]>()
    .mockResolvedValue(undefined);
  const onAttempt = vi
    .fn<FieldServiceAttemptHooks["onAttempt"]>()
    .mockResolvedValue(undefined);
  const hooks: FieldServiceAttemptHooks = { beforeAttempt, onAttempt };
  await expect(
    provider.summarizeEvidence(
      { sourceKind: "call", locale: "he", evidence: "Synthetic" },
      hooks,
    ),
  ).resolves.toBe("Synthetic summary");
  expect(transport).toHaveBeenCalledTimes(2);
  for (const [index, model] of [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
  ].entries()) {
    const call = transport.mock.calls[index] as
      [string, RequestInit] | undefined;
    expect(call?.[0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    expect(call?.[1].headers).toMatchObject({
      authorization: "Bearer fictional-tenant-key",
    });
    if (typeof call?.[1].body !== "string")
      throw new Error("missing JSON body");
    const body = JSON.parse(call[1].body) as Record<string, unknown>;
    expect(body).toMatchObject({
      model,
      max_tokens: 100,
      reasoning_effort: "minimal",
    });
    if (index === 0) expect(body).not.toHaveProperty("temperature");
  }
  expect(beforeAttempt).toHaveBeenCalledTimes(2);
  expect(onAttempt).toHaveBeenCalledTimes(2);
});
it("rejects foreign or disabled explicit configurations without a deployment fallback", async () => {
  const { projection, decrypt } = fixture();
  if (!projection.configuration || !projection.credential)
    throw new Error("fixture missing");
  for (const patch of [
    { configuration: { ...projection.configuration, tenantId: randomUUID() } },
    { configuration: { ...projection.configuration, enabled: false } },
    { credential: { ...projection.credential, tenantId: randomUUID() } },
  ])
    await expect(
      fieldIntakeModel({ ...projection, ...patch }, deployment, decrypt),
    ).rejects.toThrow();
});
