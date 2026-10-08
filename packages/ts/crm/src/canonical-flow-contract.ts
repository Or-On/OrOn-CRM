import type { JsonValue } from "./types.js";

export const supportedChannels = ["voice", "whatsapp"] as const;
export type SupportedChannel = (typeof supportedChannels)[number];
export type FlowNodeType =
  "start" | "end" | "message.send" | "voice.call" | "crm.update" | "handoff";
const flowNodeTypes: readonly FlowNodeType[] = [
  "start",
  "end",
  "message.send",
  "voice.call",
  "crm.update",
  "handoff",
];

export interface CanonicalFlowNode {
  readonly id: string;
  readonly type: FlowNodeType;
  readonly label?: string;
  readonly configuration?: Readonly<Record<string, JsonValue>>;
}

export interface CanonicalFlowEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  /** Optional channel scope; omitted edges retain their existing behavior. */
  readonly channels?: readonly SupportedChannel[];
}

export type ReferencePolicy = "pinned" | "follow_published";

export function parseReferencePolicy(value: unknown): ReferencePolicy {
  if (value === undefined || value === "pinned") return "pinned";
  if (value === "follow_published") return value;
  throw new TypeError("reference policy must be pinned or follow_published");
}

export interface CanonicalFlow {
  readonly agentReferencePolicy?: ReferencePolicy;
  readonly layout?: {
    readonly version: 1;
    readonly positions: Readonly<
      Record<string, { readonly x: number; readonly y: number }>
    >;
  };
  readonly schemaVersion: "1.0";
  readonly channels: readonly SupportedChannel[];
  readonly nodes: readonly CanonicalFlowNode[];
  readonly edges: readonly CanonicalFlowEdge[];
}

export function parseCanonicalFlow(value: unknown): CanonicalFlow {
  if (value === null || typeof value !== "object")
    throw new TypeError("flow must be an object");
  const record = value as Readonly<Record<string, unknown>>;
  if (
    record.schemaVersion !== "1.0" ||
    !Array.isArray(record.channels) ||
    !Array.isArray(record.nodes) ||
    !Array.isArray(record.edges)
  )
    throw new TypeError("flow must use canonical schema version 1.0");
  if (record.nodes.length > 100 || record.edges.length > 200)
    throw new TypeError("flow exceeds the supported size");
  const channels = record.channels.map((channel) => {
    if (
      typeof channel !== "string" ||
      !supportedChannels.includes(channel as SupportedChannel)
    )
      throw new TypeError("flow contains an unsupported channel");
    return channel as SupportedChannel;
  });
  const nodes = record.nodes.map((node) => {
    if (node === null || typeof node !== "object")
      throw new TypeError("flow nodes must be objects");
    const candidate = node as Readonly<Record<string, unknown>>;
    if (
      typeof candidate.id !== "string" ||
      !/^[\w-]{1,64}$/u.test(candidate.id) ||
      typeof candidate.type !== "string" ||
      !flowNodeTypes.includes(candidate.type as FlowNodeType)
    )
      throw new TypeError("flow node id/type is invalid");
    const configuration = candidate.configuration;
    const label = candidate.label;
    if (
      label !== undefined &&
      (typeof label !== "string" ||
        label.trim().length === 0 ||
        label.trim().length > 120)
    )
      throw new TypeError("flow node label must contain 1ג€“120 characters");
    if (
      configuration !== undefined &&
      (configuration === null ||
        typeof configuration !== "object" ||
        Array.isArray(configuration))
    )
      throw new TypeError("node configuration must be an object");
    // JSON round-trip detaches the persisted immutable version from caller objects.
    const encoded = JSON.stringify(configuration ?? {});
    if (encoded.length > 64_000)
      throw new TypeError("node configuration is too large");
    JSON.parse(encoded, (key: string, entry: unknown) => {
      if (
        /^(?:access_?token|api_?key|app_?secret|password|private_?key|secret)$/iu.test(
          key,
        )
      )
        throw new TypeError("credentials must never be embedded in flows");
      return entry;
    });
    return {
      id: candidate.id,
      type: candidate.type as FlowNodeType,
      ...(label === undefined ? {} : { label: label.trim() }),
      ...(configuration === undefined
        ? {}
        : { configuration: JSON.parse(encoded) as Record<string, JsonValue> }),
    };
  });
  const edges = record.edges.map((edge) => {
    if (edge === null || typeof edge !== "object")
      throw new TypeError("flow edges must be objects");
    const candidate = edge as Readonly<Record<string, unknown>>;
    if (
      typeof candidate.id !== "string" ||
      !/^[\w-]{1,64}$/u.test(candidate.id) ||
      typeof candidate.source !== "string" ||
      !/^[\w-]{1,64}$/u.test(candidate.source) ||
      typeof candidate.target !== "string" ||
      !/^[\w-]{1,64}$/u.test(candidate.target)
    )
      throw new TypeError("flow edge id/source/target is invalid");
    const edgeChannels = candidate.channels;
    if (
      edgeChannels !== undefined &&
      (!Array.isArray(edgeChannels) ||
        edgeChannels.length === 0 ||
        edgeChannels.some(
          (channel: unknown) =>
            typeof channel !== "string" ||
            !channels.includes(channel as SupportedChannel),
        ))
    )
      throw new TypeError(
        "flow edge channels must be supported selected channels",
      );
    return {
      id: candidate.id,
      source: candidate.source,
      target: candidate.target,
      ...(edgeChannels === undefined
        ? {}
        : {
            channels: sortedUniqueChannels(edgeChannels as SupportedChannel[]),
          }),
    };
  });
  const agentReferencePolicy = parseReferencePolicy(
    record.agentReferencePolicy,
  );
  let layout: CanonicalFlow["layout"];
  if (record.layout !== undefined) {
    const candidate = record.layout as Record<string, unknown>;
    if (
      !candidate ||
      candidate.version !== 1 ||
      !candidate.positions ||
      typeof candidate.positions !== "object" ||
      Array.isArray(candidate.positions)
    )
      throw new TypeError("layout must use version 1 and node positions");
    const positions: Record<string, { x: number; y: number }> = {};
    for (const [id, value] of Object.entries(candidate.positions)) {
      const position = value as Record<string, unknown>;
      if (
        !nodes.some((node) => node.id === id) ||
        !position ||
        typeof position.x !== "number" ||
        typeof position.y !== "number" ||
        !Number.isFinite(position.x) ||
        !Number.isFinite(position.y) ||
        Math.abs(position.x) > 100000 ||
        Math.abs(position.y) > 100000
      )
        throw new TypeError("layout references an invalid node or position");
      positions[id] = { x: position.x, y: position.y };
    }
    layout = { version: 1, positions };
  }
  return {
    schemaVersion: "1.0",
    channels,
    nodes,
    edges,
    ...(record.agentReferencePolicy === undefined
      ? {}
      : { agentReferencePolicy }),
    ...(layout === undefined ? {} : { layout }),
  };
}

export interface FlowValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface CompiledAdapter {
  readonly schemaVersion: "oron-flow.v1" | "wacrm-automation.v1";
  readonly nodes: readonly CanonicalFlowNode[];
  readonly edges: readonly CanonicalFlowEdge[];
}

export type CompiledAdapters = Readonly<
  Partial<Record<SupportedChannel, CompiledAdapter>>
>;

const nodeChannels: Readonly<
  Record<FlowNodeType, readonly SupportedChannel[]>
> = {
  start: supportedChannels,
  end: supportedChannels,
  "message.send": ["whatsapp"],
  "voice.call": ["voice"],
  "crm.update": supportedChannels,
  handoff: supportedChannels,
};

export function sortedUniqueChannels(
  channels: readonly SupportedChannel[],
): readonly SupportedChannel[] {
  return [...new Set(channels)].sort();
}

export function validateCanonicalFlow(flow: CanonicalFlow): FlowValidation {
  const errors: string[] = [];
  const channels = sortedUniqueChannels(flow.channels);
  if (channels.length === 0) errors.push("at least one channel is required");
  if (channels.length !== flow.channels.length)
    errors.push("flow channels must not be duplicated");
  if (channels.some((channel) => !supportedChannels.includes(channel)))
    errors.push("flow contains an unsupported channel");

  const ids = new Set<string>();
  for (const node of flow.nodes) {
    if (node.id.trim() === "") errors.push("node IDs must not be empty");
    if (ids.has(node.id)) errors.push(`duplicate node ID: ${node.id}`);
    ids.add(node.id);
    if (!(node.type in nodeChannels)) {
      errors.push(`node ${node.id} has an unsupported type`);
      continue;
    }
    if (!nodeChannels[node.type].some((channel) => channels.includes(channel)))
      errors.push(`node ${node.id} is unsupported by the selected channels`);
  }
  if (flow.nodes.filter((node) => node.type === "start").length !== 1)
    errors.push("flow must contain exactly one start node");
  if (!flow.nodes.some((node) => node.type === "end"))
    errors.push("flow must contain at least one end node");
  const edgeIds = new Set<string>();
  for (const edge of flow.edges) {
    if (
      edge.channels !== undefined &&
      (edge.channels.length === 0 ||
        edge.channels.some((channel) => !channels.includes(channel)))
    )
      errors.push(`edge ${edge.id} has invalid channel scope`);
    if (edgeIds.has(edge.id)) errors.push(`duplicate edge ID: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!ids.has(edge.source) || !ids.has(edge.target))
      errors.push(`edge ${edge.id} references a missing node`);
    if (edge.source === edge.target)
      errors.push(`edge ${edge.id} cannot connect a node to itself`);
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)].sort() };
}

function compileAdapter(
  flow: CanonicalFlow,
  channel: SupportedChannel,
): CompiledAdapter {
  const nodes = flow.nodes
    .filter((node) => nodeChannels[node.type].includes(channel))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const ids = new Set(nodes.map((node) => node.id));
  const edges = flow.edges
    .filter(
      (edge) =>
        ids.has(edge.source) &&
        ids.has(edge.target) &&
        (edge.channels === undefined || edge.channels.includes(channel)),
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: channel === "voice" ? "oron-flow.v1" : "wacrm-automation.v1",
    nodes,
    edges,
  };
}

export function compileCanonicalFlow(flow: CanonicalFlow): CompiledAdapters {
  const validation = validateCanonicalFlow(flow);
  if (!validation.valid)
    throw new TypeError(
      `invalid canonical flow: ${validation.errors.join("; ")}`,
    );
  return Object.fromEntries(
    sortedUniqueChannels(flow.channels).map((channel) => [
      channel,
      compileAdapter(flow, channel),
    ]),
  );
}
