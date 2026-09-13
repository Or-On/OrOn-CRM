// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentAudioPreview } from "../src/features/orchestration";

const api = vi.hoisted(() => ({ mutate: vi.fn(), revoke: vi.fn() }));
vi.mock("../src/features/crm", () => ({ crmMutation: api.mutate }));
const versionId = "20000000-0000-4000-8000-000000000001";
const props = {
  endpoint: "/api/orchestration/agents/fixture",
  versionId,
  published: true,
  locale: "en",
};
beforeEach(() => {
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:private-fixture"),
      revokeObjectURL: api.revoke,
    }),
  );
  api.mutate.mockResolvedValue({
    preview: {
      version_id: versionId,
      agent_id: versionId,
      request_id: versionId,
      evaluation_kind: "paid_tts_preview",
      canonical_text: "Fictional test",
      speech_normalized_text: "Fictional test",
      duration_seconds: 0.01,
      media_type: "audio/wav",
      audio_base64: "UklGRg==",
      provider: "injected test",
      model: "fixture",
      voice: "fixture",
      expires_in_seconds: 60,
    },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("explicit paid speech preview", () => {
  it("rejects malformed provider fields before rendering or creating audio", async () => {
    api.mutate.mockResolvedValue({
      preview: {
        version_id: versionId,
        evaluation_kind: "paid_tts_preview",
        provider: { private: "bad" },
      },
    });
    render(<AgentAudioPreview {...props} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Fixture" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("alert");
    expect(document.querySelector("audio")).toBeNull();
  });
  it.each(["en", "he"])(
    "renders %s disclosure without inference on mount",
    (locale) => {
      render(<AgentAudioPreview {...props} locale={locale} />);
      expect(api.mutate).not.toHaveBeenCalled();
      expect(screen.getByRole("checkbox")).toBeDefined();
      expect(screen.getByRole("textbox").getAttribute("maxlength")).toBe("300");
      expect(document.querySelector("audio")).toBeNull();
    },
  );
  it("posts only explicit confirmed published version and cleans playback on unmount", async () => {
    const view = render(<AgentAudioPreview {...props} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Fictional test" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Generate paid speech preview" }),
    );
    await waitFor(() =>
      expect(document.querySelector("audio")?.src).toBe("blob:private-fixture"),
    );
    expect(api.mutate).toHaveBeenCalledWith(
      `${props.endpoint}/audio-preview`,
      { versionId, text: "Fictional test", confirmed: true },
      api.mutate.mock.calls[0]?.[2] as { signal: AbortSignal },
    );
    view.unmount();
    expect(api.revoke).toHaveBeenCalledWith("blob:private-fixture");
  });
  it("disables unpublished versions and reports failure without fabricated audio", async () => {
    const view = render(<AgentAudioPreview {...props} published={false} />);
    expect(screen.getByRole<HTMLButtonElement>("button").disabled).toBe(true);
    view.rerender(<AgentAudioPreview {...props} />);
    api.mutate.mockRejectedValue(new Error("disabled"));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Fictional test" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("alert");
    expect(document.querySelector("audio")).toBeNull();
  });
});
