/**
 * Explicit, reviewable agent capabilities.
 *
 * A prompt describes behaviour; it never grants a permission. An agent may only
 * perform a business action when an operator selected the matching capability
 * on the published version, so an agent that merely *promises* to save leads
 * still cannot write one, and a customer saying "save a lead" cannot conjure
 * the ability either.
 *
 * Capabilities live in `agents.agent_profile_versions.tool_permissions`, which
 * is already immutable per published version. Nothing else needs to be pinned.
 */

import type { SupportedChannel } from "./cross-channel.js";
import { supportedChannels } from "./cross-channel.js";
import type { TenantFeatureKey } from "./tenant-features.js";

export const agentCapabilities = [
  "lead.read",
  "lead.write",
  "lead.finalize",
  "lead.follow_up",
  // Escalating to a person is always allowed; opening or updating the
  // customer's support ticket while doing so is a grant. A lead coordinator's
  // escalation is not a support issue, and a survey's is not either.
  "ticket.open",
] as const;

export type AgentCapability = (typeof agentCapabilities)[number];

export function capabilityRequiredFeature(
  capability: AgentCapability,
): TenantFeatureKey {
  switch (capability) {
    case "lead.read":
    case "lead.write":
    case "lead.finalize":
    case "lead.follow_up":
      return "leads";
    case "ticket.open":
      return "tickets";
  }
}

/**
 * Which channels can actually execute a capability, checked at publication.
 *
 * Resolved when asked rather than at module load: `cross-channel.ts` imports
 * these checks back for the publication boundary, and reading its channel list
 * eagerly would make this pair sensitive to which module loads first. The
 * switch stays exhaustive, so a new capability has to state its channels.
 */
function capabilityChannels(
  capability: AgentCapability,
): readonly SupportedChannel[] {
  switch (capability) {
    case "lead.read":
    case "lead.write":
    case "lead.finalize":
    case "lead.follow_up":
    case "ticket.open":
      // A WhatsApp escalation opens the ticket; a call only ever updates the
      // ticket its callback already belongs to. Both channels may hold it.
      return supportedChannels;
  }
}

export function isAgentCapability(value: unknown): value is AgentCapability {
  return (
    typeof value === "string" &&
    agentCapabilities.includes(value as AgentCapability)
  );
}

/**
 * Read a stored `tool_permissions` array.
 *
 * Unknown entries are dropped rather than rejected: earlier versions stored
 * free-form strings, and a historical row must stay readable. Dropping is safe
 * because an unrecognised entry can never authorise anything.
 */
export function parseAgentCapabilities(
  value: unknown,
): readonly AgentCapability[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isAgentCapability))].sort();
}

/** Reject unknown capabilities at the authoring boundary, unlike stored reads. */
export function requireAgentCapabilities(
  value: readonly unknown[],
): readonly AgentCapability[] {
  if (value.length > agentCapabilities.length)
    throw new TypeError("too many capabilities requested");
  for (const entry of value)
    if (!isAgentCapability(entry))
      throw new TypeError(`unsupported agent capability: ${String(entry)}`);
  return [...new Set(value as readonly AgentCapability[])].sort();
}

export function hasCapability(
  granted: readonly AgentCapability[],
  required: AgentCapability,
): boolean {
  return granted.includes(required);
}

export class CapabilityDeniedError extends Error {
  readonly capability: AgentCapability;
  constructor(capability: AgentCapability) {
    super(`agent is not authorized for ${capability}`);
    this.name = "CapabilityDeniedError";
    this.capability = capability;
  }
}

export function assertCapability(
  granted: readonly AgentCapability[],
  required: AgentCapability,
): void {
  if (!hasCapability(granted, required))
    throw new CapabilityDeniedError(required);
}

/**
 * `lead.write` without `lead.read` would force blind overwrites, and finalising
 * or arranging follow-up presupposes collected data, so both imply the reads.
 */
export function effectiveCapabilities(
  selected: readonly AgentCapability[],
): readonly AgentCapability[] {
  const result = new Set(selected);
  if (
    result.has("lead.write") ||
    result.has("lead.finalize") ||
    result.has("lead.follow_up")
  )
    result.add("lead.read");
  return [...result].sort();
}

export interface CapabilityChannelConflict {
  readonly capability: AgentCapability;
  readonly channel: SupportedChannel;
}

export function capabilityChannelConflicts(
  capabilities: readonly AgentCapability[],
  channels: readonly SupportedChannel[],
): readonly CapabilityChannelConflict[] {
  const conflicts: CapabilityChannelConflict[] = [];
  for (const capability of capabilities)
    for (const channel of channels)
      if (!capabilityChannels(capability).includes(channel))
        conflicts.push({ capability, channel });
  return conflicts;
}
