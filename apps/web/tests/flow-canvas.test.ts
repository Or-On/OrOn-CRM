import { describe, expect, it } from "vitest";

import { buildFlowElements } from "../src/features/orchestration";

const label = (type: string) => `label:${type}`;

describe("flow canvas projection", () => {
  it("creates deterministic connected nodes from the canonical definition", () => {
    const definition = {
      schemaVersion: "1.0",
      channels: ["whatsapp"],
      nodes: [
        { id: "start", type: "start" },
        { id: "message", type: "message.send" },
        { id: "end", type: "end" },
      ],
      edges: [
        { id: "start-message", source: "start", target: "message" },
        { id: "message-end", source: "message", target: "end" },
      ],
    } as const;

    const first = buildFlowElements(definition, label);
    const second = buildFlowElements(definition, label);

    expect(first).toEqual(second);
    expect(first.nodes.map((node) => node.position.y)).toEqual([0, 144, 288]);
    expect(first.nodes[1]?.data.label).toBe("label:message.send");
    expect(first.edges.map((edge) => edge.id)).toEqual([
      "start-message",
      "message-end",
    ]);
  });

  it("drops malformed nodes and dangling edges instead of fabricating a graph", () => {
    const result = buildFlowElements(
      {
        nodes: [{ id: "known", type: "start" }, { type: "end" }],
        edges: [
          { id: "dangling", source: "known", target: "missing" },
          { id: 42, source: "known", target: "known" },
        ],
      },
      label,
    );

    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
  });
});
