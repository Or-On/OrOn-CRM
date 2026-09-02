import { describe, expect, it } from "vitest";
import {
  executablePath,
  interpolateAutomation,
  templateParameters,
} from "./flow-adapters.js";
import type { CanonicalFlow } from "./cross-channel.js";

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
});
