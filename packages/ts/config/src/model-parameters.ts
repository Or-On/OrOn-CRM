import { agentRuntimePolicy } from "./runtime-policy.generated.js";

/** Endpoint-specific parameters, recomputed for each physical attempt. */
export function compatibleModelParameters(
  baseUrl: string,
  model: string,
  temperature: number,
): { reasoning_effort?: "none" | "minimal"; temperature?: number } {
  const google =
    new URL(baseUrl).hostname === "generativelanguage.googleapis.com";
  if (!google) return { temperature };
  const capability = Object.entries(agentRuntimePolicy.models).find(
    ([name]) => name === model,
  )?.[1];
  if (capability)
    return {
      reasoning_effort: capability.reasoningEffort,
      ...(capability.sampling ? { temperature } : {}),
    };
  if (model.startsWith("gemini-3") || model.startsWith("gemini-2.5-pro"))
    return { reasoning_effort: "minimal", temperature };
  if (model.startsWith("gemini-2.5-flash"))
    return { reasoning_effort: "none", temperature };
  return { temperature };
}

/** A configured fallback uses this route's credential/endpoint, never another tenant's. */
export function assertCompatibleFallback(
  baseUrl: string,
  model: string,
  fallback?: string,
): void {
  if (fallback === undefined) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(fallback))
    throw new TypeError("Invalid fallback model");
  const hostname = new URL(baseUrl).hostname;
  if (
    hostname === "generativelanguage.googleapis.com" &&
    (!model.startsWith("gemini-") ||
      !Object.hasOwn(agentRuntimePolicy.models, fallback))
  )
    throw new TypeError("Unsupported Gemini fallback model");
  if (hostname === "api.openai.com" && fallback.startsWith("gemini-"))
    throw new TypeError("Fallback provider mismatch");
}
