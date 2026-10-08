// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EffectivePromptInspector } from "../src/features/orchestration";

const result = {
  text: "שלום 👋 <script>bad()</script>",
  blocks: [
    {
      id: "tenant-catalog",
      authority: "tenant",
      text: "<img src=x onerror=bad()> שלום",
      source: "approved catalog",
    },
  ],
  hash: "hash-one",
  hashScope: "rendered_instruction_text_utf8_sha256",
  compositionVersion: "effective-instructions.v1",
  characterCount: 29,
  context: {
    state: "published_pending_activation",
    view: "authoring_preview",
    agentVersionId: "version-a",
  },
  contextOptions: [],
  exclusions: ["היסטוריית לקוח אינה כלולה"],
  scriptedOpening: {
    text: "פתיחה מוקראת",
    source: "pre_actions",
    flowId: "flow-a",
    flowVersion: 4,
  },
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("effective prompt inspector", () => {
  it("shows literal escaped ordered blocks, server Unicode count/hash and pending state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(result)));
    render(
      <EffectivePromptInspector profileId="profile-a" versionId="version-a" />,
    );
    fireEvent.click(screen.getByText("הפרומפט שרץ בפועל"));
    await screen.findByText("פורסם, ממתין להפעלה");
    expect(screen.getByText(/29 תווי Unicode/)).toBeTruthy();
    expect(screen.getByText("hash-one")).toBeTruthy();
    expect(screen.getByText("<img src=x onerror=bad()> שלום")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("פתיחה מוקראת")).toBeTruthy();
    expect(screen.getByText("היסטוריית לקוח אינה כלולה")).toBeTruthy();
  });
  it("requires an explicit ambiguous route selection and sends exact selector", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: "effective_prompt_context_required",
            contextOptions: [
              { processId: "inbound", nodeId: "start", label: "שיחה נכנסת" },
            ],
          },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          ...result,
          context: { ...result.context, state: "active" },
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    render(
      <EffectivePromptInspector profileId="profile-a" versionId="version-a" />,
    );
    fireEvent.click(screen.getByText("הפרומפט שרץ בפועל"));
    await screen.findByText("שיחה נכנסת");
    fireEvent.change(screen.getByLabelText("מסלול"), {
      target: { value: "inbound|start" },
    });
    await screen.findByText("פעיל לשיחות חדשות");
    expect(fetcher.mock.calls[1]?.[0]).toContain(
      "processId=inbound&nodeId=start",
    );
  });
  it("ignores a stale request after version selection changes", async () => {
    let resolveFirst: (response: Response) => void = () => undefined;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(Response.json({ ...result, hash: "new-hash" }));
    vi.stubGlobal("fetch", fetcher);
    const { rerender } = render(
      <EffectivePromptInspector profileId="profile-a" versionId="old" />,
    );
    fireEvent.click(screen.getByText("הפרומפט שרץ בפועל"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    rerender(
      <EffectivePromptInspector profileId="profile-a" versionId="new" />,
    );
    await screen.findByText("new-hash");
    resolveFirst(Response.json(result));
    await waitFor(() => expect(screen.queryByText("hash-one")).toBeNull());
  });
});
