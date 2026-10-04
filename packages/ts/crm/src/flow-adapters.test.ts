import { describe, expect, it } from "vitest";
import {
  executablePath,
  interpolateAutomation,
  templateParameters,
} from "./flow-adapters.js";
import { parseCanonicalFlow, type CanonicalFlow } from "./cross-channel.js";

const flow: CanonicalFlow = {
  schemaVersion: "1.0",
  channels: ["whatsapp"],
  nodes: [
    { id: "start", type: "start" },
    {
      id: "send",
      type: "message.send",
      configuration: { text: "Hello {{vars.name}}" },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { id: "a", source: "start", target: "send" },
    { id: "b", source: "send", target: "end" },
  ],
};
describe("executable retained adapters", () => {
  it("preserves distinct scoped paths for empty WhatsApp and telephone intake", () => {
    const combined = parseCanonicalFlow({
      schemaVersion: "1.0",
      channels: ["voice", "whatsapp"],
      nodes: [
        { id: "start", type: "start" },
        {
          id: "call",
          type: "voice.call",
          configuration: {
            flowId: "00000000-0000-4000-8000-000000000011",
            flowVersion: 1,
            agentVersionId: "00000000-0000-4000-8000-000000000012",
          },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        {
          id: "voice-start",
          source: "start",
          target: "call",
          channels: ["voice"],
        },
        { id: "voice-end", source: "call", target: "end", channels: ["voice"] },
        {
          id: "whatsapp-empty",
          source: "start",
          target: "end",
          channels: ["whatsapp"],
        },
      ],
    });
    expect(executablePath(combined, "voice").map((n) => n.id)).toEqual([
      "start",
      "call",
      "end",
    ]);
    expect(executablePath(combined, "whatsapp").map((n) => n.id)).toEqual([
      "start",
      "end",
    ]);
    expect(() =>
      parseCanonicalFlow({
        ...combined,
        edges: [
          { id: "bad", source: "start", target: "end", channels: ["email"] },
        ],
      }),
    ).toThrow(/channel/);
  });
  it("uses edge order, not node/list sort order", () => {
    expect(
      executablePath(
        { ...flow, nodes: [...flow.nodes].reverse() },
        "whatsapp",
      ).map((node) => node.id),
    ).toEqual(["start", "send", "end"]);
  });
  it("fails closed for disconnected or cyclic channel paths", () => {
    expect(() => executablePath({ ...flow, edges: [] }, "whatsapp")).toThrow(
      "path",
    );
    expect(() =>
      executablePath(
        {
          ...flow,
          edges: [
            { id: "a", source: "start", target: "send" },
            { id: "b", source: "send", target: "start" },
          ],
        },
        "whatsapp",
      ),
    ).toThrow("cyclic");
  });
  it("preserves WACRM interpolation and numeric template ordering", () => {
    expect(
      interpolateAutomation("Hi {{ vars.name }} {{missing}}", {
        name: "Fictional",
      }),
    ).toBe("Hi Fictional ");
    expect(templateParameters({ "10": "ten", "2": "two", "1": "one" })).toEqual(
      ["one", "two", "ten"],
    );
  });
  it("does not permit arbitrary CRM column mutations", () => {
    expect(() =>
      executablePath(
        {
          ...flow,
          nodes: flow.nodes.map((node) =>
            node.id === "send"
              ? {
                  id: "send",
                  type: "crm.update",
                  configuration: { field: "voice_consent", value: "granted" },
                }
              : node,
          ),
        },
        "whatsapp",
      ),
    ).toThrow("supported CRM");
  });
  it("accepts a pinned voice agent version and rejects malformed bindings", () => {
    const voiceFlow: CanonicalFlow = {
      schemaVersion: "1.0",
      channels: ["voice"],
      nodes: [
        { id: "start", type: "start" },
        {
          id: "call",
          type: "voice.call",
          configuration: {
            flowId: "10000000-0000-4000-8000-000000000001",
            flowVersion: 1,
            agentVersionId: "20000000-0000-4000-8000-000000000001",
          },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { id: "a", source: "start", target: "call" },
        { id: "b", source: "call", target: "end" },
      ],
    };
    expect(executablePath(voiceFlow, "voice")).toHaveLength(3);
    expect(() =>
      executablePath(
        {
          ...voiceFlow,
          nodes: voiceFlow.nodes.map((node) =>
            node.id === "call"
              ? {
                  ...node,
                  configuration: {
                    ...node.configuration,
                    agentVersionId: "not-a-version",
                  },
                }
              : node,
          ),
        },
        "voice",
      ),
    ).toThrow("optional agent version IDs");
  });
});
