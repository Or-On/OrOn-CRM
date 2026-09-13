// Generated from control-api OpenAPI. Do not edit by hand.

import type {
  AgentProviderEvaluationRequest,
  AgentProviderEvaluationResult,
  AudioPreviewRequest,
  AudioPreviewResult,
  CanonicalFlowContract,
  CanonicalFlowValidationResult,
  ComponentCatalog,
  FlowDocumentRequest,
  FlowList,
  FlowPublishResult,
  FlowValidationResult,
  LiveStatus,
  PhoneNumberList,
  PhoneNumberSummary,
  ReadyStatus,
  ReconciliationReport,
  RegisterPhoneNumberRequest,
  SimulatedCallRequest,
  SimulatedCallResult,
  VoiceCampaignCreate,
  VoiceCampaignList,
  VoiceCampaignRun,
  VoiceCampaignRunResult,
  VoiceCampaignSummary,
  VoiceControlCommand,
  VoiceControlStatus,
  VoiceSessionDetail,
  VoiceSessionList,
  VoiceSessionLookup,
} from "./schema";

export interface ApiResponse<T> {
  readonly data: T;
  readonly ok: boolean;
  readonly status: number;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class GeneratedControlApiClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  public async previewAgentAudio(
    body: AudioPreviewRequest,
  ): Promise<ApiResponse<AudioPreviewResult>> {
    return this.request<AudioPreviewResult>(
      "/api/v1/orchestration/agents/audio-preview",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  public async evaluateAgentProvider(
    body: AgentProviderEvaluationRequest,
  ): Promise<ApiResponse<AgentProviderEvaluationResult>> {
    return this.request<AgentProviderEvaluationResult>(
      "/api/v1/orchestration/agents/provider-evaluate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  public async validateCanonicalFlow(
    body: CanonicalFlowContract,
  ): Promise<ApiResponse<CanonicalFlowValidationResult>> {
    return this.request<CanonicalFlowValidationResult>(
      "/api/v1/orchestration/flows/validate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  public async listVoiceCampaigns(): Promise<ApiResponse<VoiceCampaignList>> {
    return this.request<VoiceCampaignList>("/api/v1/voice/campaigns");
  }

  public async createVoiceCampaign(
    body: VoiceCampaignCreate,
  ): Promise<ApiResponse<VoiceCampaignSummary>> {
    return this.request<VoiceCampaignSummary>("/api/v1/voice/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  public async runVoiceCampaign(
    body: VoiceCampaignRun,
  ): Promise<ApiResponse<VoiceCampaignRunResult>> {
    return this.request<VoiceCampaignRunResult>("/api/v1/voice/campaigns/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  public async getVoiceComponentCatalog(): Promise<
    ApiResponse<ComponentCatalog>
  > {
    return this.request<ComponentCatalog>("/api/v1/voice/component-catalog");
  }

  public async listVoiceFlows(): Promise<ApiResponse<FlowList>> {
    return this.request<FlowList>("/api/v1/voice/flows");
  }

  public async publishVoiceFlow(
    body: FlowDocumentRequest,
  ): Promise<ApiResponse<FlowPublishResult>> {
    return this.request<FlowPublishResult>("/api/v1/voice/flows/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  public async validateVoiceFlow(
    body: FlowDocumentRequest,
  ): Promise<ApiResponse<FlowValidationResult>> {
    return this.request<FlowValidationResult>("/api/v1/voice/flows/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  public async listVoicePhoneNumbers(): Promise<ApiResponse<PhoneNumberList>> {
    return this.request<PhoneNumberList>("/api/v1/voice/phone-numbers");
  }

  public async registerVoicePhoneNumber(
    body: RegisterPhoneNumberRequest,
  ): Promise<ApiResponse<PhoneNumberSummary>> {
    return this.request<PhoneNumberSummary>("/api/v1/voice/phone-numbers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  public async reconcileVoicePhoneNumbers(): Promise<
    ApiResponse<ReconciliationReport>
  > {
    return this.request<ReconciliationReport>(
      "/api/v1/voice/phone-numbers/reconciliation",
    );
  }

  public async getVoiceSession(
    body: VoiceSessionLookup,
  ): Promise<ApiResponse<VoiceSessionDetail>> {
    return this.request<VoiceSessionDetail>("/api/v1/voice/session-detail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  public async listVoiceSessions(): Promise<ApiResponse<VoiceSessionList>> {
    return this.request<VoiceSessionList>("/api/v1/voice/sessions");
  }

  public async getVoiceSessionControl(parameters: {
    readonly session_id: string;
  }): Promise<ApiResponse<VoiceControlStatus>> {
    return this.request<VoiceControlStatus>(
      `/api/v1/voice/sessions/${encodeURIComponent(String(parameters.session_id))}/control`,
    );
  }

  public async setVoiceSessionControl(
    parameters: { readonly session_id: string },
    body: VoiceControlCommand,
  ): Promise<ApiResponse<VoiceControlStatus>> {
    return this.request<VoiceControlStatus>(
      `/api/v1/voice/sessions/${encodeURIComponent(String(parameters.session_id))}/control`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  public async simulateVoiceCall(
    body: SimulatedCallRequest,
  ): Promise<ApiResponse<SimulatedCallResult>> {
    return this.request<SimulatedCallResult>("/api/v1/voice/simulated-calls", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  public async getLiveness(): Promise<ApiResponse<LiveStatus>> {
    return this.request<LiveStatus>("/health/live");
  }

  public async getReadiness(): Promise<ApiResponse<ReadyStatus>> {
    return this.request<ReadyStatus>("/health/ready");
  }

  private async request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<ApiResponse<T>> {
    const url = new URL(path, this.baseUrl);
    const response =
      init === undefined
        ? await this.fetcher(url)
        : await this.fetcher(url, init);
    return {
      data: (await response.json()) as T,
      ok: response.ok,
      status: response.status,
    };
  }
}
