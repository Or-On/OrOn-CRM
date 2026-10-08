import {
  resolveTrustedModelRoute,
  type ModelConfigurationRecord,
} from "./trusted-model-routing.js";
import type {
  ModelCredentialEnvelope,
  ResolvedModelCredential,
} from "./model-credentials.js";
import {
  OpenAiCompatibleFieldServiceProvider,
  type FieldServiceAiProvider,
} from "./field-service-provider.js";

/** Only the fenced SQL projection can supply this, never a model or HTTP input. */
export interface FieldIntakeModelProjection {
  tenantId: string;
  agentVersionId: string;
  ownershipEpoch: string;
  actorUserId: string;
  configuration: ModelConfigurationRecord | null;
  credential: ModelCredentialEnvelope | null;
}

export async function fieldIntakeModel(
  projection: FieldIntakeModelProjection,
  deployment: FieldServiceAiProvider | undefined,
  decrypt:
    | ((envelope: ModelCredentialEnvelope) => ResolvedModelCredential)
    | undefined,
): Promise<FieldServiceAiProvider> {
  if (projection.configuration === null) {
    if (!deployment) throw new TypeError("field_service_ai_unavailable");
    return deployment;
  }
  const configuration = projection.configuration;
  const envelope = projection.credential;
  const route = await resolveTrustedModelRoute(
    {
      tenantId: projection.tenantId,
      agentVersionId: projection.agentVersionId,
      actorUserId: projection.actorUserId,
      channel: "whatsapp",
    },
    {
      readPublishedBinding: () =>
        Promise.resolve({
          tenantId: projection.tenantId,
          agentVersionId: projection.agentVersionId,
          published: true,
          validationStatus: "valid",
          authorized: true,
          modelConfigurationId: configuration.id,
        }),
      readConfiguration: () => Promise.resolve(configuration),
      resolveCredential: (tenant, id, provider) =>
        Promise.resolve(
          decrypt &&
            envelope?.tenantId === tenant &&
            envelope.credentialId === id &&
            envelope.modelConfigurationId === configuration.id &&
            envelope.provider === provider
            ? decrypt(envelope)
            : null,
        ),
      // The SQL projection reserves and revalidates the ENTIRE sealed snapshot
      // in the same transaction as each durable attempt start, not here.
      reserveDailyAttempt: () => Promise.resolve(false),
    },
  );
  if (route.status !== "configured")
    throw new TypeError("field_service_model_unavailable");
  return new OpenAiCompatibleFieldServiceProvider({
    apiKey: route.credential.apiKey,
    baseUrl: route.baseUrl,
    model: route.model,
    ...route.settings,
  });
}
