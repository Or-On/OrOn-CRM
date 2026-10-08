// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceFlowPanel } from "../src/features/voice";
import { localized } from "./localized";
import en from "../src/i18n/messages/en.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const flow = {
  flow_id: "11111111-1111-4111-8111-111111111111",
  language: "he",
  latest_version: 4,
  name: "Tenant flow",
  packaged: false,
};
const source = {
  flow: { id: flow.flow_id, version: 4, language: "he" },
  steps: [
    {
      id: "opening",
      use: "inform",
      say: "פתיחה מקורית",
      on: { next: "finish" },
    },
  ],
  globals: [],
};
const loaded = {
  flow_id: flow.flow_id,
  version: 4,
  source,
  spec: {},
  components_version: "4.0.0",
  origin: "tenant",
  editable: true,
  revision: "basehash",
  base_version: 4,
};
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("retained source loading and guarded publication", () => {
  it("loads source without a manual paste and preserves local edits on a revision conflict", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(loaded))
      .mockResolvedValueOnce(
        Response.json({ error: "source_revision_conflict" }, { status: 409 }),
      );
    vi.stubGlobal("fetch", fetcher);
    render(
      localized(
        <VoiceFlowPanel
          catalog={{ components: [], spec_version: "4.0.0" }}
          flows={[flow]}
        />,
        "en",
        ["voice:read", "voice:operate", "flows:manage", "campaigns:manage"],
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", {
          name: en.voice.source,
        }).disabled,
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole<HTMLButtonElement>("button", { name: en.voice.source }),
    );
    fireEvent.change(
      screen.getByLabelText<HTMLTextAreaElement>("פתיחה / טקסט מוקרא"),
      {
        target: { value: "פתיחה חדשה" },
      },
    );
    fireEvent.click(
      screen.getByRole<HTMLButtonElement>("button", { name: en.voice.publish }),
    );
    await screen.findByRole("alert");
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("פתיחה / טקסט מוקרא").value,
    ).toBe("פתיחה חדשה");
    const request = JSON.parse(
      (fetcher.mock.calls[1]?.[1] as RequestInit).body as string,
    ) as {
      source: typeof source;
      expected_base_version: number;
      expected_revision: string;
    };
    expect(request.expected_base_version).toBe(4);
    expect(request.expected_revision).toBe("basehash");
    expect(request.source.steps[0]?.on).toEqual({ next: "finish" });
    expect(request.source.steps[0]?.say).toBe("פתיחה חדשה");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("waits for the real activation result and reloads the server allocated exact version", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(loaded))
      .mockResolvedValueOnce(
        Response.json({
          created: true,
          flow: { ...flow, latest_version: 5 },
          publication: {
            status: "published_pending_activation",
            operationId: "op-5",
            impacts: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          publication: {
            status: "active_for_new_interactions",
            operationId: "op-5",
            releaseId: "release-5",
            impacts: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ...loaded,
          version: 5,
          base_version: 5,
          revision: "newhash",
          source: {
            ...source,
            flow: { ...source.flow, version: 5 },
            steps: [{ ...source.steps[0], say: "פתיחה חדשה" }],
          },
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    render(
      localized(
        <VoiceFlowPanel
          catalog={{ components: [], spec_version: "4.0.0" }}
          flows={[flow]}
        />,
        "en",
        ["voice:read", "voice:operate", "flows:manage", "campaigns:manage"],
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: en.voice.source })
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: en.voice.source }));
    fireEvent.change(screen.getByLabelText("פתיחה / טקסט מוקרא"), {
      target: { value: "פתיחה חדשה" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.voice.publish }));
    await screen.findByText("פעיל לשיחות חדשות");
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    expect(fetcher.mock.calls[2]?.[0]).toBe(
      "/api/orchestration/publications/op-5/activate",
    );
    expect(fetcher.mock.calls[3]?.[0]).toBe(
      `/api/voice/flows/${flow.flow_id}/versions/5`,
    );
  });
  it("discards a late source response after the selected flow changes", async () => {
    let completeFirst: (response: Response) => void = () => undefined;
    const otherFlow = {
      ...flow,
      flow_id: "22222222-2222-4222-8222-222222222222",
      name: "Other flow",
    };
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            completeFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ...loaded,
          flow_id: otherFlow.flow_id,
          source: {
            ...source,
            flow: { ...source.flow, id: otherFlow.flow_id },
            steps: [{ ...source.steps[0], say: "פתיחה של תהליך שני" }],
          },
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    render(
      localized(
        <VoiceFlowPanel
          catalog={{ components: [], spec_version: "4.0.0" }}
          flows={[flow, otherFlow]}
        />,
        "en",
        ["voice:read", "voice:operate", "flows:manage", "campaigns:manage"],
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /Other flow/ }));
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: en.voice.source })
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: en.voice.source }));
    completeFirst(Response.json(loaded));
    await waitFor(() =>
      expect(
        screen.getByLabelText<HTMLTextAreaElement>("פתיחה / טקסט מוקרא").value,
      ).toBe("פתיחה של תהליך שני"),
    );
  });
  it("requires every authoritative manage capability, rather than voice operate alone", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(loaded)));
    render(
      localized(
        <VoiceFlowPanel
          catalog={{ components: [], spec_version: "4.0.0" }}
          flows={[flow]}
        />,
        "en",
        ["voice:read", "voice:operate"],
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", {
          name: en.voice.source,
        }).disabled,
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole<HTMLButtonElement>("button", { name: en.voice.source }),
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: en.voice.publish,
      }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: en.voice.validate,
      }).disabled,
    ).toBe(true);
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("פתיחה / טקסט מוקרא").disabled,
    ).toBe(true);
  });
  it("keeps packaged source read-only even for a fully permitted operator", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ ...loaded, origin: "packaged", editable: false }),
        ),
    );
    render(
      localized(
        <VoiceFlowPanel
          catalog={{ components: [], spec_version: "4.0.0" }}
          flows={[{ ...flow, packaged: true }]}
        />,
        "en",
        ["voice:read", "voice:operate", "flows:manage", "campaigns:manage"],
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", {
          name: en.voice.source,
        }).disabled,
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole<HTMLButtonElement>("button", { name: en.voice.source }),
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: en.voice.publish,
      }).disabled,
    ).toBe(true);
    expect(screen.getByText(/מקור משותף לקריאה בלבד/)).toBeTruthy();
  });
});
