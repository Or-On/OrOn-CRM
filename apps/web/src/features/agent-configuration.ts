/**
 * Request parsing shared by the agent create and revise routes.
 *
 * Both entry points have to read the same selection the same way, or an
 * operator could revise an agent into a configuration the create screen would
 * have rejected.
 */

import {
  agentCapabilities,
  requireAgentCapabilities,
  supportedChannels,
  type AgentCapability,
  type SupportedChannel,
} from "@or-on/crm";

export function channels(value: unknown): readonly SupportedChannel[] {
  if (!Array.isArray(value)) throw new TypeError("channels must be an array");
  const parsed = value.filter(
    (entry): entry is SupportedChannel =>
      typeof entry === "string" &&
      supportedChannels.includes(entry as SupportedChannel),
  );
  if (parsed.length !== value.length)
    throw new TypeError("only voice and whatsapp channels are supported");
  return parsed;
}

/**
 * Read the capability selection the operator actually ticked.
 *
 * An unknown entry is rejected rather than dropped: the publish screen shows
 * this list as the agent's real permissions, so silently discarding one would
 * let it claim an action the runtime will refuse.
 */
export function capabilities(value: unknown): readonly AgentCapability[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new TypeError(
      `capabilities must be an array of ${agentCapabilities.join(", ")}`,
    );
  return requireAgentCapabilities(value);
}
