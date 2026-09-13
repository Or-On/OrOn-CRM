import { issueServiceAssertion, type Role } from "@or-on/auth";

export interface AutomaticCallRequest {
  readonly actorRole: Role;
  readonly actorUserId: string;
  readonly agentVersionId?: string;
  readonly conversationContext: string;
  readonly conversationId: string;
  readonly contactId: string;
  readonly destination: string;
  readonly flowId: string;
  readonly flowVersion?: number;
  readonly idempotencyKey: string;
  readonly jobId: string;
  readonly tenantId: string;
}

export interface AutomaticCallResult {
  readonly created: boolean;
  readonly sessionId: string;
}

export interface AutomaticCallProvider {
  place(request: AutomaticCallRequest): Promise<AutomaticCallResult>;
}

export class AutomaticCallProviderError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
    this.name = "AutomaticCallProviderError";
  }
}

const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;

export class DispatcherAutomaticCallProvider implements AutomaticCallProvider {
  public constructor(
    private readonly options: {
      readonly dispatcherUrl: string;
      readonly enabled: boolean;
      readonly serviceSecret: string | undefined;
      readonly timeoutMs?: number;
    },
  ) {}

  public async place(
    request: AutomaticCallRequest,
  ): Promise<AutomaticCallResult> {
    if (!this.options.enabled)
      throw new AutomaticCallProviderError("automatic_calls_disabled", false);
    if (this.options.serviceSecret === undefined)
      throw new AutomaticCallProviderError("call_auth_unavailable", false);
    if (
      (request.agentVersionId !== undefined &&
        !uuidPattern.test(request.agentVersionId)) ||
      (request.flowVersion !== undefined &&
        (!Number.isSafeInteger(request.flowVersion) || request.flowVersion < 1))
    )
      throw new AutomaticCallProviderError("call_binding_invalid", false);

    const assertion = await issueServiceAssertion({
      audience: "dispatcher",
      capability: "voice:dial",
      identity: {
        role: request.actorRole,
        sessionId: request.jobId,
        tenantId: request.tenantId,
        userId: request.actorUserId,
      },
      secret: this.options.serviceSecret,
    });
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 15_000,
    );
    try {
      const response = await fetch(
        new URL("/api/v1/dispatch/outbound", this.options.dispatcherUrl),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${assertion}`,
            "content-type": "application/json",
            "idempotency-key": request.idempotencyKey,
          },
          body: JSON.stringify({
            caller_gender: null,
            contact_id: request.contactId,
            conversation_context: request.conversationContext,
            explicit_approval: true,
            flow_id: request.flowId,
            ...(request.agentVersionId === undefined
              ? {}
              : { agent_version_id: request.agentVersionId }),
            ...(request.flowVersion === undefined
              ? {}
              : { flow_version: request.flowVersion }),
            idempotency_key: request.idempotencyKey,
            phone_number: request.destination,
            source_conversation_id: request.conversationId,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const retryable =
          response.status === 408 ||
          response.status === 409 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;
        throw new AutomaticCallProviderError(
          `call_http_${String(response.status)}`,
          retryable,
        );
      }
      const payload: unknown = await response.json().catch(() => undefined);
      if (
        payload === null ||
        typeof payload !== "object" ||
        !("session_id" in payload) ||
        typeof payload.session_id !== "string" ||
        !uuidPattern.test(payload.session_id) ||
        !("created" in payload) ||
        typeof payload.created !== "boolean"
      )
        throw new AutomaticCallProviderError("call_invalid_output", false);
      return { created: payload.created, sessionId: payload.session_id };
    } catch (error) {
      if (error instanceof AutomaticCallProviderError) throw error;
      if (error instanceof Error && error.name === "AbortError")
        throw new AutomaticCallProviderError("call_timeout", true);
      throw new AutomaticCallProviderError("call_transport_error", true);
    } finally {
      clearTimeout(timeout);
    }
  }
}
