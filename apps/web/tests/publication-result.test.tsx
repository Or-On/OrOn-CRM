// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PublicationResult } from "../src/features/orchestration";
import { localized } from "./localized";
const api = vi.hoisted(() => ({ read: vi.fn(), mutate: vi.fn() }));
vi.mock("../src/features/crm", () => ({
  crmRead: api.read,
  crmMutation: api.mutate,
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("does not label a staged publication active and reports deliberately pinned routes", () => {
  render(
    <PublicationResult
      result={{
        status: "published_pending_activation",
        operationId: "operation-one",
        releaseId: null,
        impacts: [
          {
            processName: "Support inbound",
            trigger: "voice.inbound",
            status: "unchanged_pinned",
            reason: "process binding is pinned",
            oldAgentVersionId: "old-agent",
            newAgentVersionId: "old-agent",
            oldFlowVersionId: "old-flow",
            newFlowVersionId: "old-flow",
          },
        ],
      }}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe("פורסם, ממתין להפעלה");
  expect(screen.queryByText("פעיל לשיחות חדשות")).toBeNull();
  expect(screen.getByText(/השיוך נעול לגרסה קודמת/)).toBeTruthy();
  expect(screen.getByRole("link").getAttribute("href")).toBe(
    "/settings/business",
  );
});

it("keeps a candidate blocked until the activation endpoint confirms the reviewed bundle", async () => {
  api.read.mockResolvedValue({ enabled: false, datasets: [], evaluations: [] });
  api.mutate.mockResolvedValue({
    publication: {
      status: "active_for_new_interactions",
      operationId: "candidate-op",
      releaseId: "release-2",
      impacts: [],
    },
  });
  render(
    localized(
      <PublicationResult
        result={{
          status: "blocked_evaluation",
          operationId: "candidate-op",
          releaseId: null,
          impacts: [],
          evaluationCandidates: [
            {
              agentProfileId: "profile-one",
              agentVersionId: "agent-two",
              publicationOperationId: "candidate-op",
              candidateDigest: "candidate-hash",
            },
          ],
        }}
      />,
    ),
  );
  expect(screen.getByRole("status").textContent).toContain(
    "ממתין לבדיקת איכות",
  );
  expect(screen.getByText("candidate-hash")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "בדיקה מחדש והפעלת הגרסה שאושרה" }),
  );
  await screen.findByText("פעיל לשיחות חדשות");
  expect(api.mutate.mock.calls[0]?.slice(0, 2)).toEqual([
    "/api/orchestration/publications/candidate-op/activate",
    {},
  ]);
});
