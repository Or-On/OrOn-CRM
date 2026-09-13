import {
  compileCanonicalFlow,
  type CanonicalFlow,
  type CanonicalFlowNode,
  type SupportedChannel,
} from "./cross-channel.js";
import type { JsonValue } from "./types.js";

/** Phase 6 supports a single ordered path per channel, not implicit parallelism. */
export function executablePath(
  flow: CanonicalFlow,
  channel: SupportedChannel,
): readonly CanonicalFlowNode[] {
  const adapter = compileCanonicalFlow(flow)[channel];
  if (adapter === undefined)
    throw new TypeError("flow does not support this channel");
  const start = adapter.nodes.find((node) => node.type === "start");
  if (start === undefined) throw new TypeError("flow start is missing");
  const result: CanonicalFlowNode[] = [];
  let current: CanonicalFlowNode | undefined = start;
  while (current !== undefined) {
    if (result.some((node) => node.id === current?.id))
      throw new TypeError("cyclic flows are unsupported");
    result.push(current);
    const outgoing = adapter.edges.filter(
      (edge) => edge.source === current?.id,
    );
    if (current.type === "end") {
      if (outgoing.length)
        throw new TypeError("end nodes cannot have outgoing edges");
      break;
    }
    if (outgoing.length !== 1)
      throw new TypeError("each channel must have one unambiguous path to end");
    current = adapter.nodes.find((node) => node.id === outgoing[0]?.target);
  }
  if (result.length !== adapter.nodes.length || result.at(-1)?.type !== "end")
    throw new TypeError(
      "all channel nodes must be reachable from start to end",
    );
  for (const node of result) validateAction(node);
  return result;
}

export function configurationText(
  config: Readonly<Record<string, JsonValue>>,
  key: string,
): string {
  const value = config[key];
  if (typeof value !== "string" || !value.trim() || value.length > 4096)
    throw new TypeError(`flow configuration requires ${key}`);
  return value;
}

export function validateAction(node: CanonicalFlowNode): void {
  const cfg = node.configuration ?? {};
  const keys: Record<CanonicalFlowNode["type"], readonly string[]> = {
    start: [],
    end: [],
    "voice.call": ["flowId", "flowVersion", "agentVersionId"],
    "message.send": ["kind", "text", "template_name", "language", "variables"],
    "crm.update": ["field", "value"],
    handoff: ["reason"],
  };
  if (Object.keys(cfg).some((key) => !keys[node.type].includes(key)))
    throw new TypeError(
      "unsupported action configuration; credentials must never be embedded",
    );
  switch (node.type) {
    case "start":
    case "end":
      return;
    case "message.send":
      if (
        cfg.kind !== undefined &&
        cfg.kind !== "text" &&
        cfg.kind !== "template"
      )
        throw new TypeError("unsupported message kind");
      if (cfg.kind === "template") {
        configurationText(cfg, "template_name");
        configurationText(cfg, "language");
        templateParameters(cfg.variables);
      } else configurationText(cfg, "text");
      return;
    case "crm.update":
      if (
        !["name", "email", "company"].includes(configurationText(cfg, "field"))
      )
        throw new TypeError(
          "only name, email and company are supported CRM flow fields",
        );
      configurationText(cfg, "value");
      return;
    case "handoff":
      configurationText(cfg, "reason");
      return;
    case "voice.call":
      if (
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(
          configurationText(cfg, "flowId"),
        ) ||
        (cfg.agentVersionId !== undefined &&
          !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(
            configurationText(cfg, "agentVersionId"),
          )) ||
        typeof cfg.flowVersion !== "number" ||
        !Number.isInteger(cfg.flowVersion) ||
        cfg.flowVersion < 1
      )
        throw new TypeError(
          "voice action requires immutable retained flow, version, and optional agent version IDs",
        );
  }
}

/** WACRM engine.ts interpolation semantics; only explicit safe context is supplied. */
export function interpolateAutomation(
  value: string,
  variables: Readonly<Record<string, JsonValue>>,
): string {
  return value.replace(/\{\{\s*([\w.]+)\s*\}\}/gu, (_, key: string) => {
    const [namespace, property] = key.split(".");
    return namespace === "vars" && property
      ? scalarText(variables[property] ?? "")
      : "";
  });
}

function scalarText(value: JsonValue | undefined): string {
  if (typeof value === "object" && value !== null)
    throw new TypeError("template values must be scalar");
  return String(value ?? "");
}

/** Retains WACRM's numeric template-variable order (1,2,...,10, not 1,10,2). */
export function templateParameters(
  value: JsonValue | undefined,
): readonly string[] {
  if (value === undefined) return [];
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("template variables must be an object");
  const variables = value as Readonly<Record<string, JsonValue>>;
  return Object.keys(variables)
    .sort((a, b) => {
      const left = Number(a),
        right = Number(b);
      if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
      if (Number.isFinite(left)) return -1;
      if (Number.isFinite(right)) return 1;
      return a.localeCompare(b);
    })
    .map((key) => scalarText(variables[key]));
}
