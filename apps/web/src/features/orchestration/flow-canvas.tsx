"use client";

import type { JsonValue } from "@or-on/crm";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";

interface FlowNodeData extends Record<string, unknown> {
  readonly identifier: string;
  readonly label: string;
  readonly typeLabel: string;
  readonly type: string;
}

type FlowNode = Node<FlowNodeData, "platformFlow">;

interface FlowShapeNode {
  readonly id: string;
  readonly label: string | undefined;
  readonly type: string;
}

interface FlowShapeEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

interface FlowShape {
  readonly nodes: readonly FlowShapeNode[];
  readonly edges: readonly FlowShapeEdge[];
}

type JsonObject = Readonly<Record<string, JsonValue>>;

function isRecord(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonArray(
  value: JsonValue | undefined,
): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function parseShape(definition: JsonValue | undefined): FlowShape {
  if (!isRecord(definition)) return { nodes: [], edges: [] };
  const rawNodes = definition.nodes;
  const rawEdges = definition.edges;
  if (!isJsonArray(rawNodes) || !isJsonArray(rawEdges))
    return { nodes: [], edges: [] };

  const nodes = rawNodes.flatMap((value) => {
    if (!isRecord(value) || typeof value.id !== "string") return [];
    return [
      {
        id: value.id,
        label:
          typeof value.label === "string"
            ? value.label
            : typeof value.name === "string"
              ? value.name
              : undefined,
        type: typeof value.type === "string" ? value.type : "unknown",
      },
    ];
  });
  const known = new Set(nodes.map((node) => node.id));
  const edges = rawEdges.flatMap((value) => {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      typeof value.source !== "string" ||
      typeof value.target !== "string" ||
      !known.has(value.source) ||
      !known.has(value.target)
    )
      return [];
    return [{ id: value.id, source: value.source, target: value.target }];
  });
  return { nodes, edges };
}

export function buildFlowElements(
  definition: JsonValue | undefined,
  labelForType: (type: string) => string,
): { readonly nodes: readonly FlowNode[]; readonly edges: readonly Edge[] } {
  const shape = parseShape(definition);
  const incoming = new Map(shape.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(
    shape.nodes.map((node) => [node.id, [] as string[]]),
  );
  for (const edge of shape.edges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }

  const depth = new Map<string, number>();
  const queue = shape.nodes
    .filter((node) => incoming.get(node.id) === 0)
    .map((node) => node.id);
  for (const id of queue) depth.set(id, 0);
  for (const source of queue) {
    for (const target of outgoing.get(source) ?? []) {
      incoming.set(target, (incoming.get(target) ?? 1) - 1);
      depth.set(
        target,
        Math.max(depth.get(target) ?? 0, (depth.get(source) ?? 0) + 1),
      );
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  for (const node of shape.nodes)
    if (!depth.has(node.id)) depth.set(node.id, 0);

  const rows = new Map<number, string[]>();
  for (const node of shape.nodes) {
    const nodeDepth = depth.get(node.id) ?? 0;
    rows.set(nodeDepth, [...(rows.get(nodeDepth) ?? []), node.id]);
  }

  return {
    nodes: shape.nodes.map((node) => {
      const nodeDepth = depth.get(node.id) ?? 0;
      const row = rows.get(nodeDepth) ?? [node.id];
      const rowIndex = row.indexOf(node.id);
      const typeLabel = labelForType(node.type);
      return {
        id: node.id,
        type: "platformFlow",
        position: {
          x: rowIndex * 250 - ((row.length - 1) * 250) / 2,
          y: nodeDepth * 144,
        },
        data: {
          identifier: node.id,
          label: node.label ?? typeLabel,
          typeLabel,
          type: node.type,
        },
      };
    }),
    edges: shape.edges.map((edge) => ({
      ...edge,
      markerEnd: { type: MarkerType.ArrowClosed },
      type: "smoothstep",
    })),
  };
}

function PlatformFlowNode({ data }: NodeProps<FlowNode>) {
  const visualType = ["start", "end", "handoff"].includes(data.type)
    ? data.type
    : "action";
  return (
    <div className={`flow-node flow-node--${visualType}`}>
      <Handle
        aria-hidden="true"
        isConnectable={false}
        position={Position.Top}
        type="target"
      />
      <span className="flow-node__type">{data.typeLabel}</span>
      <strong>{data.label}</strong>
      <Handle
        aria-hidden="true"
        isConnectable={false}
        position={Position.Bottom}
        type="source"
      />
    </div>
  );
}

const nodeTypes = { platformFlow: PlatformFlowNode };

export function FlowCanvas({
  ariaLabel,
  definition,
  emptyLabel,
  labelForType,
}: {
  readonly ariaLabel: string;
  readonly definition: JsonValue | undefined;
  readonly emptyLabel: string;
  readonly labelForType: (type: string) => string;
}) {
  const t = useTranslations();
  const [selected, setSelected] = useState<string | null>(null);
  const elements = useMemo(
    () => buildFlowElements(definition, labelForType),
    [definition, labelForType],
  );
  if (elements.nodes.length === 0)
    return <div className="flow-canvas flow-canvas--empty">{emptyLabel}</div>;

  return (
    <figure aria-label={ariaLabel} className="flow-canvas">
      <div className="flow-canvas__viewport">
        <ReactFlow
          edges={[...elements.edges]}
          edgesFocusable={false}
          elementsSelectable={false}
          fitView
          fitViewOptions={{ padding: 0.28 }}
          maxZoom={1.25}
          minZoom={0.45}
          nodes={[...elements.nodes]}
          nodesConnectable={false}
          nodesDraggable={false}
          nodesFocusable={false}
          nodeTypes={nodeTypes}
          panOnDrag
          preventScrolling={false}
          zoomOnDoubleClick={false}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <figcaption className="flow-canvas__caption">
        <strong>{t("premiumVoice.graphDetails")}</strong>
        <p>{t("premiumVoice.graphHint")}</p>
      </figcaption>
      <ol className="flow-canvas__steps">
        {elements.nodes.map((node) => (
          <li key={node.id}>
            <button
              type="button"
              aria-expanded={selected === node.id}
              onClick={() => setSelected(selected === node.id ? null : node.id)}
            >
              <span>{node.data.label}</span>
              <small>{node.data.typeLabel}</small>
            </button>
            {selected === node.id ? (
              <div className="flow-canvas__node-detail">
                <code dir="ltr">{node.data.identifier}</code>
                <strong>{t("premiumVoice.connections")}</strong>
                <p>
                  {elements.edges
                    .filter((edge) => edge.source === node.id)
                    .map(
                      (edge) =>
                        elements.nodes.find(
                          (target) => target.id === edge.target,
                        )?.data.label ?? edge.target,
                    )
                    .join(" · ") || t("premiumVoice.noConnections")}
                </p>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </figure>
  );
}
