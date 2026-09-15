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

afterEach(cleanup);

describe("canonical flow editor", () => {
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
