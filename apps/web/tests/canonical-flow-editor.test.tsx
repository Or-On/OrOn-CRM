// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CanonicalFlow } from "@or-on/crm";

import {
  CanonicalFlowEditor,
  canonicalFlowFromEditorDraft,
  flowEditorDraftFromDefinition,
} from "../src/features/orchestration";
import en from "../src/i18n/messages/en.json";
import he from "../src/i18n/messages/he.json";
import { localized } from "./localized";

const flowId = "30000000-0000-4000-8000-000000000001";
const definition = {
  schemaVersion: "1.0",
  channels: ["whatsapp"],
  nodes: [
    { id: "start", label: "Customer replied", type: "start" },
    {
      id: "message",
      label: "First follow-up",
      type: "message.send",
      configuration: { text: "Fictional message" },
    },
    { id: "end", label: "Complete", type: "end" },
  ],
  edges: [
    { id: "start-message", source: "start", target: "message" },
    { id: "message-end", source: "message", target: "end" },
  ],
} as const;

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected rendered form control");
  return value;
}

function editor(
  onSave: (flow: CanonicalFlow) => Promise<number | undefined> = vi
    .fn<(flow: CanonicalFlow) => Promise<number | undefined>>()
    .mockResolvedValue(2),
  locale: "en" | "he" = "en",
) {
  return localized(
    <CanonicalFlowEditor
      definition={definition}
      disabled={false}
      flowId={flowId}
      labelForType={(type) => type}
      onSave={onSave}
      version={1}
    />,
    locale,
  );
}

class TestResizeObserver {
  observe() {
    return undefined;
  }
  unobserve() {
    return undefined;
  }
  disconnect() {
    return undefined;
  }
}
vi.stubGlobal("ResizeObserver", TestResizeObserver);
afterEach(cleanup);

describe("canonical flow editor", () => {
  it("creates the first executable path from an empty flow", async () => {
    const onSave = vi.fn().mockResolvedValue(2);
    render(
      localized(
        <CanonicalFlowEditor
          definition={{
            schemaVersion: "1.0",
            channels: ["whatsapp"],
            nodes: [],
            edges: [],
          }}
          disabled={false}
          flowId={flowId}
          labelForType={(type) => type}
          onSave={onSave}
          version={1}
        />,
      ),
    );
    fireEvent.click(screen.getByText(en.orchestration.flowEditorTitle));
    fireEvent.click(
      screen.getByRole("button", { name: en.orchestration.flowEditorAddNode }),
    );
    fireEvent.change(
      required(
        screen.getAllByLabelText(en.orchestration.flowEditorNodeType)[0],
      ),
      { target: { value: "start" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: en.orchestration.flowEditorAddNode }),
    );
    fireEvent.change(
      required(
        screen.getAllByLabelText(en.orchestration.flowEditorNodeType)[1],
      ),
      { target: { value: "end" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: en.orchestration.flowEditorAddEdge }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: en.orchestration.flowEditorSave }),
    );
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      nodes: [
        { id: "step-1", type: "start" },
        { id: "step-2", type: "end" },
      ],
      edges: [{ source: "step-1", target: "step-2" }],
    });
  });
  it("preserves layout, channel edges and reference policies after a text edit", () => {
    const configured = {
      ...definition,
      agentReferencePolicy: "pinned",
      layout: { version: 1, positions: { message: { x: 12, y: 34 } } },
      edges: definition.edges.map((edge) => ({
        ...edge,
        channels: ["whatsapp"],
      })),
    };
    const draft = flowEditorDraftFromDefinition(configured);
    expect(
      canonicalFlowFromEditorDraft({
        ...draft,
        nodes: draft.nodes.map((node) =>
          node.id === "message" ? { ...node, label: "Updated" } : node,
        ),
      }),
    ).toEqual({
      ...configured,
      nodes: configured.nodes.map((node) =>
        node.id === "message" ? { ...node, label: "Updated" } : node,
      ),
    });
  });
  it("blocks cyclic and unreachable paths before transport", async () => {
    const onSave = vi.fn().mockResolvedValue(2);
    render(
      localized(
        <CanonicalFlowEditor
          definition={{
            ...definition,
            edges: [
              ...definition.edges,
              { id: "cycle", source: "message", target: "start" },
            ],
          }}
          disabled={false}
          flowId={flowId}
          labelForType={(type) => type}
          onSave={onSave}
          version={1}
        />,
      ),
    );
    fireEvent.click(screen.getByText(en.orchestration.flowEditorTitle));
    fireEvent.click(
      screen.getByRole("button", { name: en.orchestration.flowEditorSave }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "התהליך לא תקין",
    );
    expect(onSave).not.toHaveBeenCalled();
  });
  it("edits labels and node configuration before saving a canonical draft", async () => {
    const onSave = vi
      .fn<(flow: CanonicalFlow) => Promise<number | undefined>>()
      .mockResolvedValue(2);
    render(editor(onSave));
    fireEvent.click(screen.getByText(en.orchestration.flowEditorTitle));

    const labels = screen.getAllByLabelText(
      en.orchestration.flowEditorNodeLabel,
    );
    fireEvent.change(required(labels[1]), {
      target: { value: "Second follow-up" },
    });
    const configurations = screen.getAllByLabelText(
      en.orchestration.flowEditorNodeConfiguration,
    );
    fireEvent.change(required(configurations[1]), {
      target: { value: '{"text":"Updated fictional message"}' },
    });
    const nodeIds = screen.getAllByLabelText(en.orchestration.flowEditorNodeId);
    fireEvent.change(required(nodeIds[1]), {
      target: { value: "follow-up" },
    });
    const edgeIds = screen.getAllByLabelText(en.orchestration.flowEditorEdgeId);
    fireEvent.change(required(edgeIds[0]), {
      target: { value: "start-follow-up" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: en.orchestration.flowEditorSave,
      }),
    );

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const savedFlow = onSave.mock.calls[0]?.[0];
    expect(savedFlow?.channels).toEqual(["whatsapp"]);
    expect(savedFlow?.nodes.find((node) => node.id === "follow-up")).toEqual({
      id: "follow-up",
      label: "Second follow-up",
      type: "message.send",
      configuration: { text: "Updated fictional message" },
    });
    expect(savedFlow?.edges).toContainEqual({
      id: "start-follow-up",
      source: "start",
      target: "follow-up",
    });
    expect(savedFlow?.edges).toContainEqual({
      id: "message-end",
      source: "follow-up",
      target: "end",
    });
    expect(
      await screen.findByText(
        en.orchestration.flowEditorSaved.replace("{version}", "2"),
      ),
    ).toBeTruthy();
  });

  it("keeps invalid per-node JSON local and exposes the editor in Hebrew", async () => {
    const onSave = vi.fn();
    render(editor(onSave, "he"));
    fireEvent.click(screen.getByText(he.orchestration.flowEditorTitle));
    const configurations = screen.getAllByLabelText(
      he.orchestration.flowEditorNodeConfiguration,
    );
    fireEvent.change(required(configurations[0]), {
      target: { value: "[]" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: he.orchestration.flowEditorSave,
      }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      he.orchestration.flowEditorInvalidJson,
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it("round-trips channels, labels, configuration, nodes, and edges", () => {
    const draft = flowEditorDraftFromDefinition(definition);
    expect(canonicalFlowFromEditorDraft(draft)).toEqual(definition);
  });

  it("keeps the original revision and text when server props change during editing", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const renderEditor = (version: number, text: string) =>
      localized(
        <CanonicalFlowEditor
          definition={{
            ...definition,
            nodes: definition.nodes.map((node) =>
              node.id === "message"
                ? { ...node, configuration: { text } }
                : node,
            ),
          }}
          disabled={false}
          flowId={flowId}
          labelForType={(type) => type}
          onSave={onSave}
          version={version}
        />,
      );
    const { rerender } = render(renderEditor(1, "Original"));
    fireEvent.click(screen.getByText(en.orchestration.flowEditorTitle));
    fireEvent.change(screen.getByLabelText("תוכן ההודעה"), {
      target: { value: "My local edit" },
    });
    rerender(renderEditor(2, "Another operator"));
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("תוכן ההודעה").value,
    ).toBe("My local edit");
    fireEvent.click(
      screen.getByRole("button", { name: en.orchestration.flowEditorSave }),
    );
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]?.[1]).toBe(1);
    expect(screen.getByText(/פורסמה או נשמרה גרסה אחרת/)).toBeTruthy();
  });
  it("normalizes whitespace around node and connection identifiers", () => {
    const draft = flowEditorDraftFromDefinition(definition);
    const flow = canonicalFlowFromEditorDraft({
      ...draft,
      nodes: draft.nodes.map((node) =>
        node.id === "start" ? { ...node, id: " start " } : node,
      ),
      edges: draft.edges.map((edge) =>
        edge.id === "start-message"
          ? { ...edge, id: " start-message ", source: " start " }
          : edge,
      ),
    });

    expect(flow.nodes[0]?.id).toBe("start");
    expect(flow.edges[0]).toMatchObject({
      id: "start-message",
      source: "start",
      target: "message",
    });
  });
});
