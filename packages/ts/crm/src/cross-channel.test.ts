import { describe, expect, it } from "vitest";

import {
  compileCanonicalFlow,
  parseCanonicalFlow,
  validateCanonicalFlow,
  type CanonicalFlow,
} from "./cross-channel.js";

const crossChannelFlow: CanonicalFlow = {
  schemaVersion: "1.0",
  channels: ["whatsapp", "voice"],
  nodes: [
    { id: "start", type: "start" },
    { id: "update", type: "crm.update" },
    { id: "call", type: "voice.call" },
    { id: "message", type: "message.send" },
    { id: "handoff", type: "handoff" },
    { id: "end", type: "end" },
  ],
  edges: [
    { id: "a", source: "start", target: "update" },
    { id: "b", source: "update", target: "call" },
    { id: "c", source: "update", target: "message" },
    { id: "d", source: "call", target: "handoff" },
    { id: "e", source: "message", target: "handoff" },
    { id: "f", source: "handoff", target: "end" },
  ],
};

describe("canonical cross-channel flow", () => {
  it("compiles deterministically into retained voice and messaging adapters", () => {
    const first = compileCanonicalFlow(crossChannelFlow);
    const second = compileCanonicalFlow({
      ...crossChannelFlow,
      channels: ["voice", "whatsapp"],
      nodes: [...crossChannelFlow.nodes].reverse(),
      edges: [...crossChannelFlow.edges].reverse(),
    });
    expect(first).toEqual(second);
    expect(first.voice?.schemaVersion).toBe("oron-flow.v1");
    expect(first.whatsapp?.schemaVersion).toBe("wacrm-automation.v1");
    expect(
      first.voice?.nodes.some((node) => node.type === "message.send"),
    ).toBe(false);
    expect(
      first.whatsapp?.nodes.some((node) => node.type === "voice.call"),
    ).toBe(false);
  });

  it("rejects broken graphs and unsupported channel-node combinations", () => {
    const result = validateCanonicalFlow({
      schemaVersion: "1.0",
      channels: ["voice"],
      nodes: [
        { id: "start", type: "start" },
        { id: "message", type: "message.send" },
      ],
      edges: [{ id: "broken", source: "start", target: "missing" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "node message is unsupported by the selected channels",
    );
    expect(result.errors).toContain("flow must contain at least one end node");
    expect(result.errors).toContain("edge broken references a missing node");
  });

  it("rejects untrusted payloads before compilation", () => {
    expect(() =>
      parseCanonicalFlow({
        schemaVersion: "1.0",
        channels: ["openlive"],
        nodes: [],
        edges: [],
      }),
    ).toThrow("unsupported channel");
  });
});
