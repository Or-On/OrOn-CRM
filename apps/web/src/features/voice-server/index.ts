import { ControlApiClient } from "@or-on/api-client";
import { loadConfig } from "@or-on/config";

import {
  currentRawSession,
  issueControlApiGrant,
  UnauthenticatedError,
} from "../auth";

export async function voiceClient(
  capability: "voice:read" | "voice:write",
): Promise<ControlApiClient> {
  const resolved = await currentRawSession();
  if (resolved === undefined) throw new UnauthenticatedError();
  const assertion = await issueControlApiGrant(resolved.session, capability);
  const config = loadConfig(process.env, { service: "web" });
  return new ControlApiClient(config.controlApiUrl, (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${assertion}`);
    return fetch(input, { ...init, cache: "no-store", headers });
  });
}
