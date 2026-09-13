import { ControlApiClient } from "@or-on/api-client";
import { loadConfig } from "@or-on/config";

import {
  currentRawSession,
  issueControlApiGrant,
  UnauthenticatedError,
  withFreshCurrentTenant,
} from "../auth";

export async function voiceClient(
  capability: "voice:read" | "voice:write",
  options: {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly freshAuthorization?: boolean;
  } = {},
): Promise<ControlApiClient> {
  const resolved = options.freshAuthorization
    ? await withFreshCurrentTenant(
        capability === "voice:read" ? "voice:read" : "voice:operate",
        (_sql, session) => Promise.resolve({ session }),
      )
    : await currentRawSession();
  if (resolved === undefined) throw new UnauthenticatedError();
  const assertion = await issueControlApiGrant(resolved.session, capability);
  const config = loadConfig(process.env, { service: "web" });
  return new ControlApiClient(config.controlApiUrl, (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${assertion}`);
    const timeoutSignal =
      options.timeoutMs === undefined
        ? undefined
        : AbortSignal.timeout(options.timeoutMs);
    const requestSignals = [init?.signal, options.signal].filter(
      (signal): signal is AbortSignal =>
        signal !== undefined && signal !== null,
    );
    const initialSignal =
      requestSignals.length > 0 ? AbortSignal.any(requestSignals) : undefined;
    const signal =
      timeoutSignal === undefined
        ? initialSignal
        : initialSignal === undefined
          ? timeoutSignal
          : AbortSignal.any([initialSignal, timeoutSignal]);
    return fetch(input, {
      ...init,
      cache: "no-store",
      headers,
      ...(signal === undefined ? {} : { signal }),
    });
  });
}

export async function voiceRecordingResponse(
  sessionId: string,
): Promise<Response> {
  const resolved = await currentRawSession();
  if (resolved === undefined) throw new UnauthenticatedError();
  const assertion = await issueControlApiGrant(resolved.session, "voice:read");
  const config = loadConfig(process.env, { service: "web" });
  const url = new URL(
    `/api/v1/voice/sessions/${encodeURIComponent(sessionId)}/recording`,
    config.controlApiUrl,
  );
  return fetch(url, {
    cache: "no-store",
    headers: { authorization: `Bearer ${assertion}` },
  });
}
