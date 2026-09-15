// @vitest-environment jsdom
import "./dialog-test-support";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationsPanel } from "../src/features/operations";
import { OrchestrationPanel } from "../src/features/orchestration";
import { localized } from "./localized";

const mutation = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../src/features/crm", () => ({ crmMutation: mutation }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const emptyOrchestration = {
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

describe("empty operational workspaces", () => {
  it("opens and focuses existing draft forms without creating work", () => {
    const view = render(
      localized(
        <OperationsPanel
          broadcasts={[]}
          automations={[]}
          runs={[]}
          simulationAvailable
        />,
      ),
    );
    expect(screen.getByText("No campaigns yet")).toBeDefined();
    expect(screen.queryByText("0 of 0 simulated deliveries")).toBeNull();
    expect(
      screen.queryByRole("searchbox", { name: "Search by name or identifier" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start a campaign" }));
    const campaignName =
      view.container.querySelector<HTMLInputElement>("#campaign-name");
    expect(campaignName?.closest("dialog")?.open).toBe(true);
    expect(document.activeElement).toBe(campaignName);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("tab", { name: /Automations/u }));
    fireEvent.click(
      screen.getByRole("button", { name: "Create an automation" }),
    );
    const automationName =
      view.container.querySelector<HTMLInputElement>("#automation-name");
    expect(automationName?.closest("dialog")?.open).toBe(true);
    expect(document.activeElement).toBe(automationName);
    expect(mutation).not.toHaveBeenCalled();
  });

  it("takes a flow author to the missing agent prerequisite", () => {
    const view = render(
      localized(
        <OrchestrationPanel {...emptyOrchestration} initialTab="flows" />,
      ),
    );
    expect(screen.getByText("No connected flows yet")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Review agents" }));
    expect(
      screen
        .getByRole("tab", { name: /Versioned agent profiles/u })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Create an agent" }));
    const name = view.container.querySelector<HTMLInputElement>("#agent-name");
    expect(name?.closest("dialog")?.open).toBe(true);
    expect(document.activeElement).toBe(name);
    expect(mutation).not.toHaveBeenCalled();
  });

  it("shows read-only guidance without creation shortcuts", () => {
    render(
      localized(
        <OperationsPanel
          broadcasts={[]}
          automations={[]}
          runs={[]}
          simulationAvailable
        />,
        "en",
        ["crm:read"],
      ),
    );
    expect(screen.getByText("No campaigns yet")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Start a campaign" }),
    ).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Create draft",
        hidden: true,
      }).disabled,
    ).toBe(true);
    expect(mutation).not.toHaveBeenCalled();
  });
});
