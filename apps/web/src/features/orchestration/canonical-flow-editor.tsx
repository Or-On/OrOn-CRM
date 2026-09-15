"use client";

import type {
  CanonicalFlow,
  FlowNodeType,
  JsonValue,
  SupportedChannel,
} from "@or-on/crm";
import { Button, Checkbox, Input, Select, Textarea } from "@or-on/ui";
import { useTranslations } from "next-intl";
import { useRef, useState, type SyntheticEvent } from "react";

const nodeTypes: readonly FlowNodeType[] = [
  "start",
  "crm.update",
  "voice.call",
  "message.send",
  "handoff",
  "end",
];
const channels: readonly SupportedChannel[] = ["voice", "whatsapp"];

export interface FlowEditorNodeDraft {
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly type: FlowNodeType;
  readonly configuration: string;
}

export interface FlowEditorEdgeDraft {
  readonly key: string;
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface FlowEditorDraft {
  readonly channels: readonly SupportedChannel[];
  readonly nodes: readonly FlowEditorNodeDraft[];
  readonly edges: readonly FlowEditorEdgeDraft[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeType(value: unknown): value is FlowNodeType {
  return typeof value === "string" && nodeTypes.includes(value as FlowNodeType);
}

function isChannel(value: unknown): value is SupportedChannel {
  return (
    typeof value === "string" && channels.includes(value as SupportedChannel)
  );
}

export function flowEditorDraftFromDefinition(
  definition: JsonValue | undefined,
): FlowEditorDraft {
  if (!isRecord(definition)) return { channels: [], nodes: [], edges: [] };
  const selectedChannels = Array.isArray(definition.channels)
    ? definition.channels.filter(isChannel)
    : [];
  const nodes = Array.isArray(definition.nodes)
    ? definition.nodes.flatMap((candidate, index) => {
        if (
          !isRecord(candidate) ||
          typeof candidate.id !== "string" ||
          !isNodeType(candidate.type)
        )
          return [];
        return [
          {
            key: `node-${String(index)}`,
            id: candidate.id,
            label: typeof candidate.label === "string" ? candidate.label : "",
            type: candidate.type,
            configuration: isRecord(candidate.configuration)
              ? JSON.stringify(candidate.configuration, null, 2)
              : "{}",
          },
        ];
      })
    : [];
  const edges = Array.isArray(definition.edges)
    ? definition.edges.flatMap((candidate, index) => {
        if (
          !isRecord(candidate) ||
          typeof candidate.id !== "string" ||
          typeof candidate.source !== "string" ||
          typeof candidate.target !== "string"
        )
          return [];
        return [
          {
            key: `edge-${String(index)}`,
            id: candidate.id,
            source: candidate.source,
            target: candidate.target,
          },
        ];
      })
    : [];
  return { channels: selectedChannels, nodes, edges };
}

function configurationObject(
  source: string,
): Readonly<Record<string, JsonValue>> {
  const value: unknown = JSON.parse(source);
  if (!isRecord(value))
    throw new TypeError("node configuration must be a JSON object");
  return value as Readonly<Record<string, JsonValue>>;
}

export function canonicalFlowFromEditorDraft(
  draft: FlowEditorDraft,
): CanonicalFlow {
  return {
    schemaVersion: "1.0",
    channels: [...draft.channels],
    nodes: draft.nodes.map((node) => {
      const configuration = configurationObject(node.configuration);
      return {
        id: node.id.trim(),
        type: node.type,
        ...(node.label.trim() === "" ? {} : { label: node.label.trim() }),
        ...(Object.keys(configuration).length === 0 ? {} : { configuration }),
      };
    }),
    edges: draft.edges.map((edge) => ({
      id: edge.id.trim(),
      source: edge.source.trim(),
      target: edge.target.trim(),
    })),
  };
}

export function CanonicalFlowEditor({
  definition,
  disabled,
  flowId,
  version,
  labelForType,
  onSave,
}: {
  readonly definition: JsonValue | undefined;
  readonly disabled: boolean;
  readonly flowId: string;
  readonly version: number;
  readonly labelForType: (type: string) => string;
  readonly onSave: (flow: CanonicalFlow) => Promise<number | undefined>;
}) {
  const t = useTranslations();
  const initial = flowEditorDraftFromDefinition(definition);
  const [selectedChannels, setSelectedChannels] = useState(initial.channels);
  const [nodes, setNodes] = useState(initial.nodes);
  const [edges, setEdges] = useState(initial.edges);
  const [localError, setLocalError] = useState<string>();
  const [savedVersion, setSavedVersion] = useState<number>();
  const nextKey = useRef(nodes.length + edges.length);

  function setChannel(channel: SupportedChannel, checked: boolean) {
    setSelectedChannels(
      checked
        ? channels.filter(
            (candidate) =>
              candidate === channel || selectedChannels.includes(candidate),
          )
        : selectedChannels.filter((candidate) => candidate !== channel),
    );
    setSavedVersion(undefined);
  }

  function updateNode(
    key: string,
    update: Partial<Omit<FlowEditorNodeDraft, "key">>,
  ) {
    const previousId = nodes.find((node) => node.key === key)?.id;
    setNodes(
      nodes.map((node) => (node.key === key ? { ...node, ...update } : node)),
    );
    const nextId = update.id;
    if (previousId !== undefined && nextId !== undefined)
      setEdges(
        edges.map((edge) => ({
          ...edge,
          source: edge.source === previousId ? nextId : edge.source,
          target: edge.target === previousId ? nextId : edge.target,
        })),
      );
    setSavedVersion(undefined);
  }

  function updateEdge(
    key: string,
    update: Partial<Omit<FlowEditorEdgeDraft, "key">>,
  ) {
    setEdges(
      edges.map((edge) => (edge.key === key ? { ...edge, ...update } : edge)),
    );
    setSavedVersion(undefined);
  }

  function addNode() {
    let suffix = nodes.length + 1;
    const identifiers = new Set(nodes.map((node) => node.id));
    while (identifiers.has(`step-${String(suffix)}`)) suffix += 1;
    nextKey.current += 1;
    setNodes([
      ...nodes,
      {
        key: `added-node-${String(nextKey.current)}`,
        id: `step-${String(suffix)}`,
        label: "",
        type: "crm.update",
        configuration: '{\n  "field": "company",\n  "value": ""\n}',
      },
    ]);
    setSavedVersion(undefined);
  }

  function removeNode(key: string) {
    const removed = nodes.find((node) => node.key === key);
    setNodes(nodes.filter((node) => node.key !== key));
    if (removed !== undefined)
      setEdges(
        edges.filter(
          (edge) => edge.source !== removed.id && edge.target !== removed.id,
        ),
      );
    setSavedVersion(undefined);
  }

  function addEdge() {
    let suffix = edges.length + 1;
    const identifiers = new Set(edges.map((edge) => edge.id));
    while (identifiers.has(`edge-${String(suffix)}`)) suffix += 1;
    nextKey.current += 1;
    setEdges([
      ...edges,
      {
        key: `added-edge-${String(nextKey.current)}`,
        id: `edge-${String(suffix)}`,
        source: nodes[0]?.id ?? "",
        target: nodes[1]?.id ?? nodes[0]?.id ?? "",
      },
    ]);
    setSavedVersion(undefined);
  }

  function removeEdge(key: string) {
    setEdges(edges.filter((edge) => edge.key !== key));
    setSavedVersion(undefined);
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(undefined);
    setSavedVersion(undefined);
    if (selectedChannels.length === 0) {
      setLocalError(t("orchestration.flowEditorEmptyChannels"));
      return;
    }
    let flow: CanonicalFlow;
    try {
      flow = canonicalFlowFromEditorDraft({
        channels: selectedChannels,
        nodes,
        edges,
      });
    } catch {
      setLocalError(t("orchestration.flowEditorInvalidJson"));
      return;
    }
    const saved = await onSave(flow);
    if (saved !== undefined) setSavedVersion(saved);
  }

  return (
    <details className="canonical-flow-editor">
      <summary>{t("orchestration.flowEditorTitle")}</summary>
      <form onSubmit={(event) => void submit(event)}>
        <p className="canonical-flow-editor__hint">
          {t("orchestration.flowEditorHint", { version })}
        </p>

        <fieldset
          className="canonical-flow-editor__channels"
          disabled={disabled}
        >
          <legend>{t("orchestration.flowEditorChannels")}</legend>
          {channels.map((channel) => (
            <Checkbox
              checked={selectedChannels.includes(channel)}
              key={channel}
              onChange={(event) => setChannel(channel, event.target.checked)}
            >
              {t(`orchestration.${channel}`)}
            </Checkbox>
          ))}
        </fieldset>

        <fieldset
          className="canonical-flow-editor__collection"
          disabled={disabled}
        >
          <legend>{t("orchestration.flowEditorNodes")}</legend>
          <div className="canonical-flow-editor__items">
            {nodes.map((node, index) => {
              const headingId = `${flowId}-${node.key}-heading`;
              return (
                <section
                  aria-labelledby={headingId}
                  className="canonical-flow-editor__item"
                  key={node.key}
                >
                  <header>
                    <h4 id={headingId}>
                      {t("orchestration.flowEditorNode", {
                        index: index + 1,
                      })}
                    </h4>
                    <Button
                      aria-label={t("orchestration.flowEditorRemoveNode", {
                        id: node.id,
                      })}
                      onClick={() => removeNode(node.key)}
                      size="small"
                      type="button"
                      variant="quiet"
                    >
                      {t("orchestration.flowEditorRemove")}
                    </Button>
                  </header>
                  <div className="canonical-flow-editor__row">
                    <Input
                      id={`${flowId}-${node.key}-id`}
                      label={t("orchestration.flowEditorNodeId")}
                      maxLength={64}
                      onChange={(event) =>
                        updateNode(node.key, { id: event.target.value })
                      }
                      required
                      value={node.id}
                    />
                    <Input
                      id={`${flowId}-${node.key}-label`}
                      label={t("orchestration.flowEditorNodeLabel")}
                      maxLength={120}
                      onChange={(event) =>
                        updateNode(node.key, { label: event.target.value })
                      }
                      value={node.label}
                    />
                    <Select
                      id={`${flowId}-${node.key}-type`}
                      label={t("orchestration.flowEditorNodeType")}
                      onChange={(event) =>
                        updateNode(node.key, {
                          type: event.target.value as FlowNodeType,
                        })
                      }
                      value={node.type}
                    >
                      {nodeTypes.map((type) => (
                        <option key={type} value={type}>
                          {labelForType(type)}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Textarea
                    dir="ltr"
                    id={`${flowId}-${node.key}-configuration`}
                    label={t("orchestration.flowEditorNodeConfiguration")}
                    onChange={(event) =>
                      updateNode(node.key, {
                        configuration: event.target.value,
                      })
                    }
                    rows={5}
                    spellCheck={false}
                    value={node.configuration}
                  />
                  <small>
                    {t("orchestration.flowEditorConfigurationHint")}
                  </small>
                </section>
              );
            })}
          </div>
          <Button
            onClick={addNode}
            size="small"
            type="button"
            variant="secondary"
          >
            {t("orchestration.flowEditorAddNode")}
          </Button>
        </fieldset>

        <fieldset
          className="canonical-flow-editor__collection"
          disabled={disabled}
        >
          <legend>{t("orchestration.flowEditorEdges")}</legend>
          <div className="canonical-flow-editor__items">
            {edges.map((edge, index) => {
              const headingId = `${flowId}-${edge.key}-heading`;
              return (
                <section
                  aria-labelledby={headingId}
                  className="canonical-flow-editor__item"
                  key={edge.key}
                >
                  <header>
                    <h4 id={headingId}>
                      {t("orchestration.flowEditorEdge", {
                        index: index + 1,
                      })}
                    </h4>
                    <Button
                      aria-label={t("orchestration.flowEditorRemoveEdge", {
                        id: edge.id,
                      })}
                      onClick={() => removeEdge(edge.key)}
                      size="small"
                      type="button"
                      variant="quiet"
                    >
                      {t("orchestration.flowEditorRemove")}
                    </Button>
                  </header>
                  <div className="canonical-flow-editor__row">
                    <Input
                      id={`${flowId}-${edge.key}-id`}
                      label={t("orchestration.flowEditorEdgeId")}
                      maxLength={64}
                      onChange={(event) =>
                        updateEdge(edge.key, { id: event.target.value })
                      }
                      required
                      value={edge.id}
                    />
                    <Select
                      id={`${flowId}-${edge.key}-source`}
                      label={t("orchestration.flowEditorEdgeSource")}
                      onChange={(event) =>
                        updateEdge(edge.key, { source: event.target.value })
                      }
                      required
                      value={edge.source}
                    >
                      {nodes.map((node) => (
                        <option key={node.key} value={node.id}>
                          {node.label || node.id}
                        </option>
                      ))}
                    </Select>
                    <Select
                      id={`${flowId}-${edge.key}-target`}
                      label={t("orchestration.flowEditorEdgeTarget")}
                      onChange={(event) =>
                        updateEdge(edge.key, { target: event.target.value })
                      }
                      required
                      value={edge.target}
                    >
                      {nodes.map((node) => (
                        <option key={node.key} value={node.id}>
                          {node.label || node.id}
                        </option>
                      ))}
                    </Select>
                  </div>
                </section>
              );
            })}
          </div>
          <Button
            disabled={disabled || nodes.length < 2}
            onClick={addEdge}
            size="small"
            type="button"
            variant="secondary"
          >
            {t("orchestration.flowEditorAddEdge")}
          </Button>
        </fieldset>

        {localError === undefined ? null : (
          <p className="form-error" role="alert">
            {localError}
          </p>
        )}
        {savedVersion === undefined ? null : (
          <p className="canonical-flow-editor__saved" role="status">
            {t("orchestration.flowEditorSaved", { version: savedVersion })}
          </p>
        )}
        <div className="canonical-flow-editor__actions">
          <Button busy={disabled} disabled={disabled} type="submit">
            {t("orchestration.flowEditorSave")}
          </Button>
          <small>{t("orchestration.flowEditorVersionHint")}</small>
        </div>
      </form>
    </details>
  );
}
