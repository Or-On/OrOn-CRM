// Generated from control-api OpenAPI. Do not edit by hand.

import type { LiveStatus, ReadyStatus, VoiceSessionList } from "./schema";

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

  public async listVoiceSessions(): Promise<ApiResponse<VoiceSessionList>> {
    return this.request<VoiceSessionList>("/api/v1/voice/sessions");
  }

  public async getLiveness(): Promise<ApiResponse<LiveStatus>> {
    return this.request<LiveStatus>("/health/live");
  }

  public async getReadiness(): Promise<ApiResponse<ReadyStatus>> {
    return this.request<ReadyStatus>("/health/ready");
  }

  private async request<T>(path: string): Promise<ApiResponse<T>> {
    const response = await this.fetcher(new URL(path, this.baseUrl));
    return {
      data: (await response.json()) as T,
      ok: response.ok,
      status: response.status,
    };
  }
}
