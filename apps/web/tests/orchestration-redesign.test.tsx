// @vitest-environment jsdom
import "./dialog-test-support";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrchestrationPanel } from "../src/features/orchestration";
import { localized } from "./localized";
import en from "../src/i18n/messages/en.json";

const mutate = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../src/features/crm", () => ({ crmMutation: mutate }));

const fixture = {
  activity: [],
  agents: [],
  conversations: [],
  flows: [],
  handoffs: [],
  voiceOutcomes: [],
  usage: {
    agentEvents: 0,
    inputTokens: 0,
    outputTokens: 0,
    averageLatencyMs: null,
    voiceSessions: 0,
    messagingJobs: 0,
    unpricedEvents: 0,
    estimatedCostUsd: null,
  },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("focused orchestration workspaces", () => {
  it("retains a failed agent draft in its modal, including after closing and reopening", async () => {
    mutate.mockRejectedValueOnce(new Error("unavailable"));
    render(localized(<OrchestrationPanel {...fixture} />));
    fireEvent.click(
      screen.getByRole("button", { name: en.orchestration.draft }),
    );
    const name = screen.getByLabelText<HTMLInputElement>(
      en.orchestration.agentName,
    );
    fireEvent.change(name, { target: { value: "Fictional agent draft" } });
    const prompt = screen.getByLabelText<HTMLTextAreaElement>(
      en.orchestration.prompt,
    );
    fireEvent.change(prompt, { target: { value: "Fictional prompt" } });
    const form = name.closest("form");
    if (form === null) throw new Error("Expected an agent draft form");
    fireEvent.submit(form);
    const error = await screen.findByRole("alert");
    expect(error.closest("dialog")?.open).toBe(true);
    expect(name.value).toBe("Fictional agent draft");
    fireEvent.click(screen.getByRole("button", { name: en.common.close }));
    fireEvent.click(
      screen.getByRole("button", { name: en.orchestration.draft }),
    );
    expect(name.value).toBe("Fictional agent draft");
    expect(prompt.value).toBe("Fictional prompt");
    expect(mutate).toHaveBeenCalledTimes(1);
  });
  it("keeps contact scope in the URL when navigating contextual views", () => {
    window.history.replaceState(
      null,
      "",
      "/orchestration?contact=fictional-contact&tab=agents",
    );
    render(localized(<OrchestrationPanel {...fixture} />));
    fireEvent.click(
      screen.getByRole("tab", {
        name: new RegExp(en.orchestration.handoffs, "u"),
      }),
    );
    expect(window.location.search).toContain("contact=fictional-contact");
    expect(window.location.search).toContain("tab=handoffs");
    expect(screen.getByText(en.premiumVoice.noHandoffs)).toBeDefined();
    expect(mutate).not.toHaveBeenCalled();
  });
});
