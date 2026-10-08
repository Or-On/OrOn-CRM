import { assertCompatibleFallback } from "@or-on/config";
/** Ports must be supplied by the server; no request/model-authored routing input. */
export interface ModelRoutingScope {
  readonly tenantId: string;
  readonly agentVersionId: string;
  readonly actorUserId: string;
  readonly channel: "whatsapp" | "voice";
}

export interface PublishedModelBinding {
  readonly tenantId: string;
  readonly agentVersionId: string;
  readonly published: boolean;
  readonly validationStatus: string;
  readonly authorized: boolean;
  readonly modelConfigurationId: string | null;
}

export interface ModelConfigurationRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly provider: string;
  readonly model: string;
  readonly credentialId: string | null;
  readonly enabled: boolean;
  readonly settings: unknown;
  readonly dailyRequestLimit: number | null;
}

export interface ModelRoutingPorts<Credential> {
  /** Recheck published version, channel and current authorizing membership. */
  readonly readPublishedBinding: (
    scope: ModelRoutingScope,
  ) => Promise<PublishedModelBinding | null>;
  readonly readConfiguration: (
    tenantId: string,
    configurationId: string,
  ) => Promise<ModelConfigurationRecord | null>;
  /** Must verify credential tenant/kind and decrypt using authorized server keys. */
  readonly resolveCredential?: (
    tenantId: string,
    credentialId: string,
    provider: "openai" | "gemini",
  ) => Promise<Credential | null>;
  /** Atomic durable reservation, before EVERY physical attempt including retries. */
  readonly reserveDailyAttempt?: (
    tenantId: string,
    configurationId: string,
    limit: number,
  ) => Promise<boolean>;
}

export type TrustedModelRoute<Credential> =
  | { readonly status: "legacy" }
  | { readonly status: "blocked"; readonly reason: string }
  | {
      readonly status: "configured";
      readonly configurationId: string;
      readonly provider: "openai" | "gemini";
      readonly model: string;
      readonly baseUrl: string;
      readonly credential: Credential;
      readonly settings: Readonly<{
        fallbackModel?: string;
        temperature?: number;
        maxTokens?: number;
        timeoutMs?: number;
      }>;
      readonly beforeAttempt: () => Promise<void>;
    };

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
class ModelRoutingAttemptError extends Error {}

export function parseTrustedModelSettings(value: unknown): {
  fallbackModel?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
} | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        !["temperature", "maxTokens", "timeoutMs", "fallbackModel"].includes(
          key,
        ),
    )
  )
    return null;
  const result: {
    fallbackModel?: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  } = {};
  if (record.fallbackModel !== undefined) {
    if (
      typeof record.fallbackModel !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(record.fallbackModel)
    )
      return null;
    result.fallbackModel = record.fallbackModel;
  }
  if (record.temperature !== undefined) {
    if (
      typeof record.temperature !== "number" ||
      !Number.isFinite(record.temperature) ||
      record.temperature < 0 ||
      record.temperature > 2
    )
      return null;
    result.temperature = record.temperature;
  }
  for (const key of ["maxTokens", "timeoutMs"] as const) {
    const candidate = record[key];
    if (candidate === undefined) continue;
    const maximum = key === "maxTokens" ? 8192 : 60000;
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate < 1 ||
      candidate > maximum
    )
      return null;
    result[key] = candidate;
  }
  return result;
}

/** NULL binding alone preserves legacy deployment routing. All explicit failures close. */
export async function resolveTrustedModelRoute<Credential>(
  scope: ModelRoutingScope,
  ports: ModelRoutingPorts<Credential>,
): Promise<TrustedModelRoute<Credential>> {
  const blocked = (reason: string): TrustedModelRoute<Credential> => ({
    status: "blocked",
    reason,
  });
  if (
    ![scope.tenantId, scope.agentVersionId, scope.actorUserId].every((id) =>
      uuid.test(id),
    )
  )
    return blocked("scope_invalid");
  try {
    const binding = await ports.readPublishedBinding(scope);
    if (
      binding?.tenantId !== scope.tenantId ||
      binding.agentVersionId !== scope.agentVersionId ||
      !binding.published ||
      binding.validationStatus !== "valid" ||
      !binding.authorized
    )
      return blocked("published_binding_unauthorized");
    if (binding.modelConfigurationId === null) return { status: "legacy" };
    if (!uuid.test(binding.modelConfigurationId))
      return blocked("configuration_invalid");
    const configuration = await ports.readConfiguration(
      scope.tenantId,
      binding.modelConfigurationId,
    );
    if (
      configuration?.tenantId !== scope.tenantId ||
      configuration.id !== binding.modelConfigurationId ||
      !configuration.enabled
    )
      return blocked("configuration_unavailable");
    const provider = configuration.provider;
    if (provider !== "openai" && provider !== "gemini")
      return blocked("provider_unsupported");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(configuration.model))
      return blocked("model_invalid");
    if ((provider === "gemini") !== configuration.model.startsWith("gemini-"))
      return blocked("model_provider_mismatch");
    const settings = parseTrustedModelSettings(configuration.settings);
    if (!settings) return blocked("settings_unsupported");
    try {
      assertCompatibleFallback(
        provider === "gemini"
          ? "https://generativelanguage.googleapis.com"
          : "https://api.openai.com",
        configuration.model,
        settings.fallbackModel,
      );
    } catch {
      return blocked("fallback_unsupported");
    }
    const limit = configuration.dailyRequestLimit;
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1))
      return blocked("quota_invalid");
    if (limit !== null && !ports.reserveDailyAttempt)
      return blocked("quota_reservation_unavailable");
    if (
      !configuration.credentialId ||
      !uuid.test(configuration.credentialId) ||
      !ports.resolveCredential
    )
      return blocked("credential_resolution_unavailable");
    const credential = await ports.resolveCredential(
      scope.tenantId,
      configuration.credentialId,
      provider,
    );
    if (credential === null) return blocked("credential_unavailable");
    const beforeAttempt = async () => {
      try {
        // Recheck current configuration/authority immediately before spending.
        const current = await ports.readPublishedBinding(scope);
        const latest = await ports.readConfiguration(
          scope.tenantId,
          configuration.id,
        );
        if (
          !current?.authorized ||
          !current.published ||
          current.validationStatus !== "valid" ||
          current.tenantId !== scope.tenantId ||
          current.agentVersionId !== scope.agentVersionId ||
          current.modelConfigurationId !== configuration.id ||
          latest?.tenantId !== scope.tenantId ||
          latest.id !== configuration.id ||
          !latest.enabled ||
          latest.provider !== provider ||
          latest.model !== configuration.model ||
          latest.credentialId !== configuration.credentialId ||
          latest.dailyRequestLimit !== limit ||
          JSON.stringify(parseTrustedModelSettings(latest.settings)) !==
            JSON.stringify(settings)
        )
          throw new ModelRoutingAttemptError("model_route_changed");
        if (limit !== null) {
          const reserve = ports.reserveDailyAttempt;
          if (
            !reserve ||
            !(await reserve(scope.tenantId, configuration.id, limit))
          )
            throw new ModelRoutingAttemptError("model_daily_quota_exhausted");
        }
      } catch (error) {
        if (error instanceof ModelRoutingAttemptError) throw error;
        throw new ModelRoutingAttemptError(
          "model_routing_dependency_unavailable",
        );
      }
    };
    return {
      status: "configured",
      configurationId: configuration.id,
      provider,
      model: configuration.model,
      baseUrl:
        provider === "openai"
          ? "https://api.openai.com/v1"
          : "https://generativelanguage.googleapis.com/v1beta/openai",
      credential,
      settings,
      beforeAttempt,
    };
  } catch {
    // Never propagate database/decryption exceptions containing confidential data.
    return blocked("routing_dependency_unavailable");
  }
}

export interface TrustedChannelCredentialPorts<Credential> {
  /** Server tenant scope + exact active Meta WhatsApp channel, including account. */
  readonly readChannel: (
    tenantId: string,
    channelId: string,
  ) => Promise<{
    readonly tenantId: string;
    readonly channelId: string;
    readonly kind: string;
    readonly provider: string;
    readonly status: string;
    readonly providerAccountId: string | null;
    readonly credentialId: string | null;
  } | null>;
  readonly resolveCredential?: (
    tenantId: string,
    credentialId: string,
    provider: "meta",
  ) => Promise<Credential | null>;
}

/** Resolves an explicit channel credential without substituting deployment tokens. */
export async function resolveTrustedChannelCredential<Credential>(
  tenantId: string,
  channelId: string,
  ports: TrustedChannelCredentialPorts<Credential>,
): Promise<
  | { readonly status: "legacy" }
  | { readonly status: "blocked"; readonly reason: string }
  | {
      readonly status: "configured";
      readonly providerAccountId: string;
      readonly credential: Credential;
    }
> {
  if (!uuid.test(tenantId) || !uuid.test(channelId))
    return { status: "blocked", reason: "channel_scope_invalid" };
  try {
    const channel = await ports.readChannel(tenantId, channelId);
    if (
      channel?.tenantId !== tenantId ||
      channel.channelId !== channelId ||
      channel.kind !== "whatsapp" ||
      channel.provider !== "meta" ||
      channel.status !== "active" ||
      !channel.providerAccountId
    )
      return { status: "blocked", reason: "channel_unavailable" };
    if (channel.credentialId === null) return { status: "legacy" };
    if (!uuid.test(channel.credentialId) || !ports.resolveCredential)
      return {
        status: "blocked",
        reason: "channel_credential_resolution_unavailable",
      };
    const credential = await ports.resolveCredential(
      tenantId,
      channel.credentialId,
      "meta",
    );
    if (credential === null)
      return { status: "blocked", reason: "channel_credential_unavailable" };
    return {
      status: "configured",
      providerAccountId: channel.providerAccountId,
      credential,
    };
  } catch {
    return { status: "blocked", reason: "channel_dependency_unavailable" };
  }
}
