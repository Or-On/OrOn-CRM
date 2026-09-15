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
import type { AgentProfileSummary, AutomationSummary } from "@or-on/crm";
import type { VoiceSessionSummary } from "@or-on/api-client";
import { AgentRegister } from "../src/features/orchestration";
import {
  AutomationRunHistory,
  OperationsPanel,
} from "../src/features/operations";
import { VoiceFlowPanel, VoiceOverview } from "../src/features/voice";
import { localized } from "./localized";
import en from "../src/i18n/messages/en.json";
import he from "../src/i18n/messages/he.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

const agents: readonly AgentProfileSummary[] = [
  {
    id: "one",
    name: "Intake agent",
    description: "Fictional intake",
    version: 1,
    versionId: "v1",
    channels: ["voice"],
    published: true,
    validationStatus: "valid",
    systemPrompt: "Ask about the fictional appointment.",
    locale: "en-US",
  },
  {
    id: "two",
    name: "סוכן תמיכה",
    description: null,
    version: 2,
    versionId: "v2",
    channels: ["whatsapp"],
    published: false,
    validationStatus: "valid",
    systemPrompt: "בררו מהי בקשת התמיכה.",
    locale: "he-IL",
  },
];
const flow: AutomationSummary = {
  id: "flow-one",
  name: "Fictional intake",
  description: null,
  version: 1,
  published: true,
  validationStatus: "valid",
  createdAt: "2026-09-01T10:00:00Z",
  executionKind: "empty",
  definition: { nodes: [], edges: [] },
};
const session: VoiceSessionSummary = {
  session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  contact_id: null,
  created_at: "2026-09-10T10:00:00Z",
  ended_at: "2026-09-10T10:01:00Z",
  direction: "inbound",
  status: "ended",
  provider: "simulator",
  answered: true,
  outcome: "completed",
  platform_campaign_id: null,
  usage: { call_seconds: 60 },
  cost: { llm: 0, stt: 0, tts: 0, total: 0, unpriced: [] },
};

describe("tenant management registers", () => {
  it.each(["en", "he"] as const)(
    "selects real agent configuration and filters without mutations (%s)",
    (locale) => {
      const messages = locale === "he" ? he : en;
      const publish = vi.fn();
      render(
        localized(
          <AgentRegister
            agents={agents}
            canEdit
            pending={false}
            publish={publish}
          />,
          locale,
        ),
      );
      expect(
        screen.getByText("Ask about the fictional appointment."),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /סוכן תמיכה/u }));
      expect(screen.getByText("בררו מהי בקשת התמיכה.")).toBeTruthy();
      expect(
        screen.queryByText("Ask about the fictional appointment."),
      ).toBeNull();
      fireEvent.change(screen.getByRole("searchbox"), {
        target: { value: "missing" },
      });
      expect(
        screen.getByText(messages.tenantOperations.noMatches),
      ).toBeTruthy();
      expect(
        screen.queryByRole("region", {
          name: messages.tenantOperations.agentConfiguration,
        }),
      ).toBeNull();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("scopes execution history to the selected flow and current status filter", () => {
    render(
      localized(
        <AutomationRunHistory
          definitionId="flow-one"
          flows={[flow]}
          runs={[
            {
              id: "run-one",
              definitionId: "flow-one",
              status: "succeeded",
              startedAt: "2026-09-10T10:00:00Z",
              completedAt: "2026-09-10T10:00:12Z",
            },
            {
              id: "run-two",
              definitionId: "flow-one",
              status: "failed",
              startedAt: null,
              completedAt: null,
            },
            {
              id: "other-tenant-sample-flow",
              definitionId: "flow-two",
              status: "failed",
              startedAt: null,
              completedAt: null,
            },
          ]}
        />,
      ),
    );
    expect(screen.queryByText("other-te")).toBeNull();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "failed" },
    });
    expect(screen.queryByText("run-one")).toBeNull();
    expect(screen.getByText("run-two")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("1 of 2 records");
  });

  it("retains unrelated URL scope while opening dedicated run history", () => {
    window.history.replaceState(null, "", "/operations?source=fixture");
    render(
      localized(
        <OperationsPanel
          broadcasts={[]}
          automations={[]}
          runs={[]}
          simulationAvailable
        />,
      ),
    );
    fireEvent.click(screen.getByRole("tab", { name: /Execution history/u }));
    expect(window.location.search).toBe("?source=fixture&tab=history");
    expect(screen.getByRole("tabpanel").id).toBe("operations-history-panel");
  });

  it("filters the actual Voice sample by status and direction", () => {
    render(
      localized(
        <VoiceOverview
          flows={[]}
          numbers={[]}
          reconciliation={{ findings: [], ok: true }}
          sessions={[
            session,
            {
              ...session,
              session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              direction: "outbound",
              status: "failed",
              answered: false,
              outcome: "failed",
            },
          ]}
        />,
      ),
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: en.voice.direction }),
      { target: { value: "outbound" } },
    );
    const table = screen.getByRole("table", { name: en.voice.recent });
    expect(within(table).queryByText("aaaaaaaa")).toBeNull();
    expect(within(table).getByText("bbbbbbbb")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: en.inbox.status }), {
      target: { value: "ended" },
    });
    expect(screen.getByText(en.tenantOperations.noMatches)).toBeTruthy();
  });

  it("selects only catalog metadata matching the voice source filter", () => {
    render(
      localized(
        <VoiceFlowPanel
          catalog={{ spec_version: "1.0", components: [] }}
          flows={[
            {
              flow_id: "flow-a",
              name: "Packaged fixture",
              language: "en",
              packaged: true,
              latest_version: 1,
            },
            {
              flow_id: "flow-b",
              name: "Tenant fixture",
              language: "he",
              packaged: false,
              latest_version: 2,
            },
          ]}
        />,
      ),
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: en.tenantOperations.origin }),
      { target: { value: "tenant" } },
    );
    expect(
      screen.queryByRole("button", { name: /Packaged fixture/u }),
    ).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Tenant fixture" }),
    ).toBeTruthy();
    expect(screen.getByText(en.tenantOperations.noFlowHistory)).toBeTruthy();
  });
});
