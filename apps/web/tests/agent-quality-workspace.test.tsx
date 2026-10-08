// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentQuality, type AgentQualityVersion } from "@or-on/crm";
import {
  AgentQualityWorkspace,
  AgentRegister,
  qualityCopy,
} from "../src/features/orchestration";
import { localized } from "./localized";

const api = vi.hoisted(() => ({
  read: vi.fn(),
  mutate: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: api.refresh }),
}));
vi.mock("../src/features/crm", () => ({
  crmRead: api.read,
  crmMutation: api.mutate,
}));
const profileId = "10000000-0000-4000-8000-000000000001";
const version: AgentQualityVersion = {
  id: "20000000-0000-4000-8000-000000000001",
  version: 1,
  systemPrompt: "Fictional bounded instructions",
  locale: "he",
  publishedAt: null,
  validationStatus: "pending",
  quality: defaultAgentQuality,
  sourceIds: [],
  toolPermissions: [],
};
beforeEach(() => {
  api.read.mockImplementation((url: string) =>
    Promise.resolve({ versions: url.includes("/quality") ? [version] : [] }),
  );
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("persisted agent quality workspace", () => {
  it.each(["en", "he"] as const)(
    "renders labelled %s controls with canonical female voice and independent caller address",
    async (locale) => {
      const copy = qualityCopy(locale);
      api.mutate.mockResolvedValue({
        id: "30000000-0000-4000-8000-000000000001",
      });
      render(
        localized(
          <div dir={locale === "he" ? "rtl" : "ltr"}>
            <AgentQualityWorkspace profileId={profileId} />
          </div>,
          locale,
        ),
      );
      const grammar = await screen.findByLabelText(copy.grammar);
      expect((grammar as HTMLSelectElement).value).toBe("feminine");
      expect((grammar as HTMLSelectElement).options).toHaveLength(1);
      fireEvent.change(screen.getByLabelText(copy.caller), {
        target: { value: "feminine" },
      });
      const voice =
        screen.getByLabelText<HTMLInputElement>("קול: Harper (נשי)");
      expect(voice.value).toBe("Harper");
      expect(voice.readOnly).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: copy.save }));
      await waitFor(() => {
        expect(api.mutate.mock.calls[0]?.[0]).toBe(
          `/api/orchestration/agents/${profileId}/quality`,
        );
        expect(api.mutate.mock.calls[0]?.[1]).toMatchObject({
          quality: {
            agentGrammar: "feminine",
            callerAddressDefault: "feminine",
            voiceId: "Harper",
          },
          baseVersionId: version.id,
          latestVersionId: version.id,
        });
      });
      expect(
        screen.getByRole("region", {
          name: locale === "he" ? "תצוגה מקדימה קולית" : "Audio preview",
        }),
      ).toBeDefined();
    },
  );
  it("retains edited instructions on failed persistence and makes no automatic provider/evaluation request", async () => {
    api.mutate.mockRejectedValue(new Error("unavailable"));
    const copy = qualityCopy("en");
    render(localized(<AgentQualityWorkspace profileId={profileId} />));
    const instructions = await screen.findByLabelText<HTMLTextAreaElement>(
      copy.instructions,
    );
    expect(api.mutate).not.toHaveBeenCalled();
    fireEvent.change(instructions, {
      target: { value: "Unsaved fictional instructions" },
    });
    fireEvent.click(screen.getByRole("button", { name: copy.save }));
    await screen.findByRole("alert");
    expect(instructions.value).toBe("Unsaved fictional instructions");
    expect(document.querySelector("audio")).toBeNull();
  });
  it.each(["en", "he"] as const)(
    "labels the %s configuration preview without claiming real model quality",
    async (locale) => {
      const copy = qualityCopy(locale);
      api.mutate.mockResolvedValue({
        evaluation: {
          mode: "deterministic-preview",
          acceptedText: "Fictional hours question",
          response: "Fictional approved hours",
          sources: [],
          conflicts: [],
          timings: {
            deterministicMs: 2,
            sttMs: null,
            modelMs: null,
            ttsMs: null,
          },
        },
      });
      render(
        localized(<AgentQualityWorkspace profileId={profileId} />, locale),
      );
      const scenario = await screen.findByLabelText(copy.scenario);
      fireEvent.change(scenario, {
        target: { value: "Fictional hours question" },
      });
      fireEvent.click(screen.getByRole("button", { name: copy.run }));
      expect(await screen.findByText("Fictional approved hours")).toBeDefined();
      expect(screen.getByText(copy.evaluate)).toBeDefined();
      expect(screen.getByText(copy.testRequired)).toBeDefined();
      expect(screen.getByRole("button", { name: copy.publish })).toBeDefined();
      expect(screen.getByText(copy.disclaimer)).toBeDefined();
      expect(screen.getByText(copy.stages)).toBeDefined();
      expect(document.querySelector("audio")).toBeNull();
    },
  );
  it.each(["en", "he"] as const)(
    "shows in %s which version new voice calls use and that a newer published version is not bound",
    async (locale) => {
      const copy = qualityCopy(locale);
      const published = (id: string, number: number): AgentQualityVersion => ({
        ...version,
        id,
        version: number,
        publishedAt: "2026-09-18T08:00:00.000Z",
        validationStatus: "valid",
      });
      const v1 = published("20000000-0000-4000-8000-000000000011", 1);
      const v2 = published("20000000-0000-4000-8000-000000000012", 2);
      api.read.mockImplementation((url: string) =>
        Promise.resolve(
          url.includes("/quality")
            ? {
                versions: [v2, v1],
                voiceBindings: [
                  {
                    flowDefinitionId: "30000000-0000-4000-8000-000000000011",
                    flowName: "Fictional support line",
                    flowVersion: 4,
                    voiceFlowId: "40000000-0000-4000-8000-000000000011",
                    agentVersionId: v1.id,
                    agentVersion: 1,
                    callable: true,
                  },
                ],
              }
            : { versions: [] },
        ),
      );
      render(
        localized(<AgentQualityWorkspace profileId={profileId} />, locale),
      );

      const status = await screen.findByRole("region", {
        name: copy.voiceStatus,
      });
      expect(status.textContent).toContain("Fictional support line");
      expect(status.textContent).toContain("v1");
      const warning = screen
        .getAllByRole("alert")
        .find((alert) => alert.textContent.includes("v2"));
      expect(warning?.textContent).toContain("v1");
      const options = screen.getAllByRole("option").map((o) => o.textContent);
      expect(options.find((text) => text.startsWith("v1"))).toContain(
        copy.liveVoice,
      );
      expect(options.find((text) => text.startsWith("v2"))).not.toContain(
        copy.liveVoice,
      );
      // Reporting never rebinds: no mutation is issued by loading the status.
      expect(api.mutate).not.toHaveBeenCalled();
    },
  );
  it("says when no published voice flow uses the agent", async () => {
    render(localized(<AgentQualityWorkspace profileId={profileId} />));
    expect(await screen.findByText(qualityCopy("en").voiceNone)).toBeDefined();
  });
  it.each(["en", "he"] as const)(
    "warns about each stale %s voice flow even when another flow uses the latest version",
    async (locale) => {
      const current = {
        ...version,
        version: 2,
        publishedAt: "2026-10-01T00:00:00Z",
      };
      api.read.mockImplementation((url: string) =>
        Promise.resolve(
          url.includes("/quality")
            ? {
                versions: [current],
                voiceBindings: [1, 2].map((number) => ({
                  flowDefinitionId: `fictional-flow-${String(number)}`,
                  flowName: `Fictional route ${String(number)}`,
                  flowVersion: number,
                  voiceFlowId: `fictional-voice-${String(number)}`,
                  agentVersionId:
                    number === 2 ? current.id : "fictional-old-version",
                  agentVersion: number,
                  callable: true,
                })),
              }
            : { versions: [] },
        ),
      );
      render(
        localized(<AgentQualityWorkspace profileId={profileId} />, locale),
      );
      const status = await screen.findByRole("region", {
        name: qualityCopy(locale).voiceStatus,
      });
      const warning = within(status).getByRole("alert");
      expect(warning.textContent).toContain("v2");
      expect(warning.textContent).toContain("v1");
      expect(warning.closest("li")?.textContent).toContain("Fictional route 1");
      expect(api.mutate).not.toHaveBeenCalled();
    },
  );
  it("does not expose management loading or mutation controls to a read-only agent inspector", () => {
    render(
      localized(
        <AgentRegister
          agents={[
            {
              id: profileId,
              name: "Fictional agent",
              description: null,
              version: 1,
              versionId: version.id,
              channels: ["voice"],
              published: true,
              capabilities: [],
              roleTitle: null,
              leadFieldSchemaId: null,
              publishedVersion: 1,
              publishedVersionId: version.id,
              publishedChannels: ["voice"],
              whatsAppAssignableVersionId: null,
              whatsAppAssignableVersion: null,
              leadFieldSchema: null,
              implicitTicketing: false,
              review: {
                enabledActions: [],
                leadFields: [],
                blocking: [],
                promptWarnings: [],
              },
              lifecycle: {
                draftVersion: null,
                assignedConversations: 0,
                staleConversations: 0,
                assignedFlows: 0,
                runningCalls: 0,
              },
              validationStatus: "valid",
            },
          ]}
          canEdit={false}
          pending={false}
          publish={vi.fn()}
        />,
      ),
    );
    expect(
      screen.queryByRole("button", { name: qualityCopy("en").open }),
    ).toBeNull();
    expect(api.read).not.toHaveBeenCalled();
  });
});
