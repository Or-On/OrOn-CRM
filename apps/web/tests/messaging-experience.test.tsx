// @vitest-environment jsdom
import "./dialog-test-support";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AutomationRunSummary,
  AutomationSummary,
  BroadcastSummary,
} from "@or-on/crm";
import { OperationsPanel } from "../src/features/operations";
import { localized } from "./localized";
import en from "../src/i18n/messages/en.json";
import he from "../src/i18n/messages/he.json";

const mutate = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../src/features/crm", () => ({ crmMutation: mutate }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const broadcasts: readonly BroadcastSummary[] = [
  {
    id: "fictional-a",
    name: "Fictional welcome",
    status: "sent",
    totalRecipients: 10,
    deliveredCount: 8,
    failedCount: 2,
    createdAt: "2026-09-09T08:00:00Z",
  },
  {
    id: "fictional-b",
    name: "Fictional follow-up",
    status: "draft",
    totalRecipients: 5,
    deliveredCount: 0,
    failedCount: 0,
    createdAt: "2026-09-10T08:00:00Z",
  },
];
const automations: readonly AutomationSummary[] = [
  {
    id: "automation-a",
    name: "Fictional routing",
    description: "Fictional description",
    version: 2,
    validationStatus: "valid",
    published: true,
    executionKind: "canonical",
    createdAt: "2026-09-09T08:00:00Z",
  },
];
const runs: readonly AutomationRunSummary[] = [
  {
    id: "run-a",
    definitionId: "automation-a",
    status: "failed",
    startedAt: "2026-09-10T08:00:00Z",
    completedAt: "2026-09-10T08:01:00Z",
  },
  {
    id: "run-b",
    definitionId: "automation-a",
    status: "succeeded",
    startedAt: "2026-09-09T08:00:00Z",
    completedAt: "2026-09-09T08:01:00Z",
  },
];

describe("Messaging operational data presentations", () => {
  it.each(["en", "he"] as const)(
    "uses exact record counts and localized accessible delivery summaries (%s)",
    (locale) => {
      const messages = locale === "he" ? he : en;
      const view = render(
        localized(
          <OperationsPanel
            broadcasts={broadcasts}
            automations={automations}
            runs={runs}
          />,
          locale,
        ),
      );
      const outcomes = screen.getByRole("region", {
        name: messages.premiumPrimary.recipientOutcomes,
      });
      expect(
        [...outcomes.querySelectorAll("dd")].map((item) => item.textContent),
      ).toEqual(["15", "8", "2", "5"]);
      const table = screen.getByRole("table", {
        name: messages.premiumPrimary.campaignIndex,
      });
      expect(
        within(table)
          .getAllByRole("progressbar")
          .map((progress) => progress.getAttribute("aria-valuenow")),
      ).toEqual(["8", "0"]);
      expect(
        screen.getByText(messages.tenantOperations.simulationBoundary),
      ).toBeTruthy();
      expect(view.container.textContent).not.toMatch(/growth|revenue|SLA/u);
      expect(mutate).not.toHaveBeenCalled();
    },
  );

  it("associates recorded executions with their actual automation and retains canonical action boundaries", () => {
    const view = render(
      localized(
        <OperationsPanel
          broadcasts={broadcasts}
          automations={automations}
          runs={runs}
          initialTab="automations"
        />,
      ),
    );
    expect(
      [
        ...view.container.querySelectorAll(
          "#operations-automations-panel .tenant-campaign-outcomes dd",
        ),
      ].map((item) => item.textContent),
    ).toEqual(["1", "1", "1"]);
    expect(
      screen.queryByRole("button", { name: en.operations.run }),
    ).toBeNull();
    expect(
      screen
        .getAllByRole("link", { name: en.premiumPrimary.openFlowStudio })
        .every(
          (link) => link.getAttribute("href") === "/orchestration?tab=flows",
        ),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: en.tenantOperations.runHistory }),
    );
    const history = screen.getAllByRole("region", {
      name: en.tenantOperations.runHistory,
    })[0];
    if (history === undefined)
      throw new Error("Expected selected automation history");
    expect(within(history).getAllByText("Fictional routing")).toHaveLength(2);
    expect(
      within(history).getByText(en.tenantOperations.runSample),
    ).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("restores focus and preserves unsent campaign text when the focused composer closes", () => {
    render(
      localized(<OperationsPanel broadcasts={[]} automations={[]} runs={[]} />),
    );
    const trigger = screen.getByRole("button", {
      name: en.premiumPrimary.newCampaign,
    });
    trigger.focus();
    fireEvent.click(trigger);
    const input = screen.getByRole<HTMLInputElement>("textbox", {
      name: en.operations.campaignName,
    });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "Fictional retained draft" } });
    fireEvent.click(screen.getByRole("button", { name: en.common.close }));
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect(input.value).toBe("Fictional retained draft");
    expect(mutate).not.toHaveBeenCalled();
  });
});
