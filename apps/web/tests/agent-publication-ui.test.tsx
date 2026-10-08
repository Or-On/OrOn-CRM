// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AgentProfileSummary } from "@or-on/crm";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ mutation: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: state.refresh }),
}));
vi.mock("../src/features/crm", () => ({ crmMutation: state.mutation }));
import { OrchestrationPanel } from "../src/features/orchestration";
import { localized } from "./localized";
import en from "../src/i18n/messages/en.json";
import he from "../src/i18n/messages/he.json";

function agent(number: number): AgentProfileSummary {
  return {
    id: `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    versionId: `20000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    name: `Fictional draft ${String(number)}`,
    description: null,
    version: 2,
    channels: ["whatsapp"],
    published: false,
    validationStatus: "valid",
    capabilities: [],
    roleTitle: null,
    leadFieldSchemaId: null,
    publishedVersion: null,
    publishedVersionId: null,
    publishedChannels: [],
    whatsAppAssignableVersionId: null,
    whatsAppAssignableVersion: null,
    leadFieldSchema: null,
    review: {
      enabledActions: [],
      leadFields: [],
      blocking: [],
      promptWarnings: [],
    },
    implicitTicketing: false,
    lifecycle: {
      draftVersion: 2,
      assignedConversations: 0,
      staleConversations: 0,
      assignedFlows: 0,
      runningCalls: 0,
    },
  };
}
function panel(
  agents: readonly AgentProfileSummary[],
  locale: "en" | "he" = "en",
) {
  return localized(
    <OrchestrationPanel
      agents={agents}
      flows={[]}
      activity={[]}
      conversations={[]}
      handoffs={[]}
      voiceOutcomes={[]}
      usage={{
        agentEvents: 0,
        inputTokens: 0,
        outputTokens: 0,
        averageLatencyMs: null,
        voiceSessions: 0,
        messagingJobs: 0,
        unpricedEvents: 0,
        estimatedCostUsd: null,
      }}
    />,
    locale,
  );
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("agent publication from the rendered draft", () => {
  it("sends the selected rendered version, including when another agent is first in the list", async () => {
    state.mutation.mockResolvedValue({ published: true });
    const selected = agent(2);
    render(panel([agent(1), selected]));
    fireEvent.click(screen.getByRole("button", { name: /Fictional draft 2/ }));
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() =>
      expect(state.mutation).toHaveBeenCalledWith(
        `/api/orchestration/agents/${selected.id}/publish`,
        expect.objectContaining({
          expectedVersionId: selected.versionId,
          activate: true,
        }),
      ),
    );
    await waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(1));
  });

  it.each(["en", "he"] as const)(
    "shows a %s stale-version failure without retrying or switching to a newer draft",
    async (locale) => {
      state.mutation.mockRejectedValue(
        new Error("Agent version changed; refresh before publishing"),
      );
      const selected = agent(1);
      const messages = locale === "he" ? he : en;
      render(panel([selected], locale));
      fireEvent.click(
        screen.getByRole("button", { name: messages.orchestration.publish }),
      );
      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toContain(
          messages.orchestration.agentVersionChanged,
        ),
      );
      expect(state.mutation).toHaveBeenCalledTimes(1);
      expect(state.mutation).toHaveBeenCalledWith(
        `/api/orchestration/agents/${selected.id}/publish`,
        expect.objectContaining({
          expectedVersionId: selected.versionId,
          activate: true,
        }),
      );
      expect(state.refresh).not.toHaveBeenCalled();
    },
  );

  it("cannot issue an unpinned request when the rendered draft has no version", () => {
    render(panel([{ ...agent(1), versionId: null }]));
    const publish = screen.getByRole("button", { name: "Publish" });
    expect(publish.hasAttribute("disabled")).toBe(true);
    fireEvent.click(publish);
    expect(state.mutation).not.toHaveBeenCalled();
  });
});

it("shows actual rebind and excluded-owner counts for the explicitly selected published version", async () => {
  const selected = agent(1);
  const target = "30000000-0000-4000-8000-000000000001";
  state.mutation.mockResolvedValue({
    versionId: target,
    rebound: 2,
    skipped: 2,
    skippedHuman: 1,
    skippedRemoved: 1,
  });
  render(
    panel([
      {
        ...selected,
        whatsAppAssignableVersionId: target,
        whatsAppAssignableVersion: 2,
        lifecycle: {
          ...selected.lifecycle,
          staleConversations: 2,
          assignedConversations: 2,
        },
      },
    ]),
  );
  fireEvent.click(screen.getByRole("button", { name: /Rebind to v2/ }));
  await waitFor(() =>
    expect(state.mutation).toHaveBeenCalledWith(
      `/api/orchestration/agents/${selected.id}/rebind`,
      { versionId: target, expectedVersionId: target },
    ),
  );
  await waitFor(() =>
    expect(screen.getByText(/הועברו: 2/).textContent).toContain("הועברו: 2"),
  );
  expect(screen.getByText(/הועברו: 2/).textContent).toContain(
    "בבעלות אנושית: 1",
  );
  expect(screen.getByText(/הועברו: 2/).textContent).toContain(
    "הוסרו מתיבת הדואר: 1",
  );
});
