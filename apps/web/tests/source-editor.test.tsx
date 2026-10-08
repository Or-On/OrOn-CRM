// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  editSourceText,
  sourceCards,
  StructuredVoiceSource,
} from "../src/features/voice";

const source = {
  flow: { id: "synthetic", version: 4, language: "he" },
  persona: {
    agent_name: "Harper",
    org: "test",
    pronunciations: { WhatsApp: "וואטסאפ" },
    voice: { voice: "harper" },
  },
  steps: [
    {
      id: "hello",
      use: "inform",
      say: "שלום",
      on: { next: "raw" },
      unknown: "retain",
    },
  ],
  nodes: [
    {
      name: "raw",
      role_message: "תפקיד",
      task_messages: [{ role: "system", content: "משימה" }],
      pre_actions: [{ type: "tts_say", text: "פתיחה" }],
      functions: [
        {
          name: "save",
          handler: "lead.save",
          config: { safe: true },
          routes: { done: "end" },
        },
      ],
    },
  ],
  globals: [{ id: "end", to: "finish", when: "stop" }],
};
afterEach(cleanup);
describe("retained source mapping", () => {
  it("edits only the actual source leaf preserving functions, transitions, voice and language", () => {
    const cards = sourceCards(source);
    expect(cards).toHaveLength(2);
    const changed = editSourceText(
      source,
      ["nodes", 0, "pre_actions", 0, "text"],
      "פתיחה חדשה",
    );
    expect(changed).toEqual({
      ...source,
      nodes: [
        {
          ...source.nodes[0],
          pre_actions: [{ type: "tts_say", text: "פתיחה חדשה" }],
        },
      ],
    });
    expect(source.nodes[0]?.pre_actions[0]?.text).toBe("פתיחה");
    expect(() =>
      editSourceText(source, ["persona", "missing"], "bad"),
    ).toThrow();
  });
  it("updates structured and advanced views from the same JSON without changing unsupported fields", () => {
    const onChange = vi.fn();
    render(
      <StructuredVoiceSource
        source={JSON.stringify(source)}
        disabled={false}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("פתיחה מוקראת"), {
      target: { value: "ברוכים הבאים" },
    });
    const updated = JSON.parse(
      onChange.mock.calls[0]?.[0] as string,
    ) as typeof source;
    expect(updated.nodes[0]?.pre_actions[0]?.text).toBe("ברוכים הבאים");
    expect(updated.globals).toEqual(source.globals);
    expect(updated.steps).toEqual(source.steps);
  });
  it("never overwrites malformed advanced JSON or unsupported source structures", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <StructuredVoiceSource source="{" disabled={false} onChange={onChange} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("JSON");
    rerender(
      <StructuredVoiceSource
        source='{"steps":[{"id":"derived","use":"lookup","handler":{"keep":true}}]}'
        disabled={false}
        onChange={onChange}
      />,
    );
    expect(screen.getByText(/טקסט נגזר/)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });
});
