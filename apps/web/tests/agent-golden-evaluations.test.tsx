// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentGoldenEvaluations } from "../src/features/orchestration";
import { localized } from "./localized";

const api = vi.hoisted(() => ({ read: vi.fn(), mutate: vi.fn() }));
vi.mock("../src/features/crm", () => ({
  crmRead: api.read,
  crmMutation: api.mutate,
}));
const profile = "10000000-0000-4000-8000-000000000001";
const version = "20000000-0000-4000-8000-000000000001";
const dataset = "30000000-0000-4000-8000-000000000001";
const endpoint = `/api/orchestration/agents/${profile}`;
beforeEach(() => {
  api.read.mockResolvedValue({ enabled: false, datasets: [], evaluations: [] });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("golden request/status UI; no physical quality proof", () => {
  it("keeps default-off controls absent and makes no mutation", async () => {
    render(
      localized(
        <AgentGoldenEvaluations
          endpoint={endpoint}
          versionId={version}
          locale="en"
        />,
      ),
    );
    await waitFor(() => expect(api.read).toHaveBeenCalledOnce());
    expect(screen.queryByRole("region")).toBeNull();
    expect(api.mutate).not.toHaveBeenCalled();
  });
  it.each(["en", "he"] as const)(
    "shows missing reviewed policy and disables %s requests",
    async (locale) => {
      api.read.mockResolvedValue({
        enabled: true,
        datasets: [],
        evaluations: [],
      });
      render(
        localized(
          <div dir={locale === "he" ? "rtl" : "ltr"}>
            <AgentGoldenEvaluations
              endpoint={endpoint}
              versionId={version}
              locale={locale}
            />
          </div>,
          locale,
        ),
      );
      const button = await screen.findByRole("button", {
        name:
          locale === "he"
            ? "בקשת הרצת סט השיחות שאושר"
            : "Request approved golden set run",
      });
      expect(button.hasAttribute("disabled")).toBe(true);
      expect(screen.getByRole("status").textContent).toContain(
        locale === "he" ? "ממתין" : "Awaiting reviewed",
      );
      expect(
        screen
          .getByLabelText(
            locale === "he"
              ? "גרסת סט שיחות שאושרה"
              : "Approved conversation dataset revision",
          )
          .hasAttribute("disabled"),
      ).toBe(true);
      fireEvent.click(button);
      expect(api.mutate).not.toHaveBeenCalled();
    },
  );
  it("sends only selected IDs and renders pending status without claiming a passed suite", async () => {
    // Mocked rendering metadata only: this does not approve any actual dataset.
    const workspace = {
      enabled: true,
      datasets: [
        {
          id: dataset,
          digest: "0".repeat(64),
          rubricVersion: "Fictional UI fixture",
          approvedAt: "2026-10-03T00:00:00Z",
        },
      ],
      evaluations: [],
    };
    api.read.mockResolvedValueOnce(workspace).mockResolvedValue({
      ...workspace,
      evaluations: [
        {
          id: "40000000-0000-4000-8000-000000000001",
          datasetId: dataset,
          state: "pending",
          createdAt: "2026-10-03T00:00:00Z",
          completedAt: null,
          expiresAt: "2026-10-04T00:00:00Z",
          hasAcceptedReceipt: false,
        },
      ],
    });
    api.mutate.mockResolvedValue({
      id: "40000000-0000-4000-8000-000000000001",
    });
    render(
      localized(
        <AgentGoldenEvaluations
          endpoint={endpoint}
          versionId={version}
          locale="en"
        />,
      ),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Request approved golden set run",
      }),
    );
    await screen.findByText(/Pending evaluation/u);
    expect(api.mutate.mock.calls[0]?.slice(0, 2)).toEqual([
      `${endpoint}/golden-evaluations`,
      { versionId: version, datasetId: dataset },
    ]);
    expect(screen.queryByText(/Receipt recorded/u)).toBeNull();
    expect(
      screen.getByText(/does not prove the model ran or the suite passed/u),
    ).toBeDefined();
  });
  it("reports unavailable status without rendering a fake completion", async () => {
    api.read.mockRejectedValue(Error("fixture unavailable"));
    render(
      localized(
        <AgentGoldenEvaluations
          endpoint={endpoint}
          versionId={version}
          locale="en"
        />,
      ),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Completion has not been verified",
    );
    expect(api.mutate).not.toHaveBeenCalled();
  });
});
