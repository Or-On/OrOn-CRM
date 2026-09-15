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
import { VoiceOverview } from "../src/features/voice";
import { OperationsPanel } from "../src/features/operations";
import { ManagementPanel } from "../src/features/management";
import { localized } from "./localized";
import en from "../src/i18n/messages/en.json";
import he from "../src/i18n/messages/he.json";

const transport = vi.hoisted(() => ({ mutate: vi.fn(), voice: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("../src/features/crm", () => ({ crmMutation: transport.mutate }));
vi.mock("../src/features/voice/mutation", () => ({
  voiceMutation: transport.voice,
}));

const voiceFixture = {
  flows: [
    {
      flow_id: "fictional-flow",
      name: "Fictional welcome",
      latest_version: 1,
      language: "en",
      packaged: false,
    },
  ],
  numbers: [],
  reconciliation: { findings: [], ok: true, provider_enabled: false },
  sessions: [],
};
const settingsFixture = {
  account: {
    displayName: "Operator",
    email: "operator@example.test",
    isSuperuser: false,
  },
  apiKeys: [],
  currentUserId: "00000000-0000-4000-8000-000000000002",
  invitations: [],
  members: [],
  notifications: [],
  settings: {
    accentToken: null,
    businessAddress: "",
    businessEmail: "",
    businessName: "",
    businessPhone: "",
    displayName: "Fictional workspace",
    defaultCurrency: "ILS",
    locale: "he",
    reportFooter: "",
    reportHeader: "",
    timezone: "Asia/Jerusalem",
  },
  tenantName: "Fictional workspace",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("task-specific operational layouts", () => {
  it.each(["en", "he"] as const)(
    "opens number setup deliberately and retains input across disclosures (%s)",
    (locale) => {
      const messages = locale === "he" ? he : en;
      render(localized(<VoiceOverview {...voiceFixture} />, locale));
      fireEvent.click(
        screen.getByRole("tab", {
          name: new RegExp(messages.voice.numbersTab, "u"),
        }),
      );
      const trigger = screen.getByRole("button", {
        name: messages.voice.numberSetup,
      });
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(
        screen.queryByRole("textbox", { name: messages.voice.did }),
      ).toBeNull();
      fireEvent.click(trigger);
      const input = screen.getByRole<HTMLInputElement>("textbox", {
        name: messages.voice.did,
      });
      expect(document.activeElement).toBe(input);
      fireEvent.change(input, { target: { value: "+14155550111" } });
      fireEvent.click(
        screen.getByRole("button", { name: messages.common.close }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: messages.voice.numberSetup }),
      );
      expect(input.value).toBe("+14155550111");
      expect(transport.voice).not.toHaveBeenCalled();
    },
  );

  it("prevents read-only users from opening number registration", () => {
    render(
      localized(<VoiceOverview {...voiceFixture} />, "en", ["voice:read"]),
    );
    fireEvent.click(
      screen.getByRole("tab", { name: new RegExp(en.voice.numbersTab, "u") }),
    );
    const trigger = screen.getByRole<HTMLButtonElement>("button", {
      name: en.voice.numberSetup,
    });
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(transport.voice).not.toHaveBeenCalled();
  });

  it("keeps run history visible across campaign and automation views without submitting work", () => {
    render(
      localized(<OperationsPanel broadcasts={[]} automations={[]} runs={[]} />),
    );
    fireEvent.click(
      screen.getByRole("tab", {
        name: new RegExp(en.tenantOperations.automations, "u"),
      }),
    );
    fireEvent.click(
      screen.getByRole("tab", {
        name: new RegExp(en.tenantOperations.runHistory, "u"),
      }),
    );
    expect(
      screen
        .getByRole("region", { name: en.tenantOperations.runHistory })
        .closest("[hidden]"),
    ).toBeNull();
    expect(window.location.search).toContain("tab=history");
    expect(transport.mutate).not.toHaveBeenCalled();
  });

  it("links tabs to their panels and follows RTL keyboard direction", () => {
    render(
      localized(
        <OperationsPanel broadcasts={[]} automations={[]} runs={[]} />,
        "he",
      ),
    );
    const campaign = screen.getByRole("tab", {
      name: new RegExp(he.tenantOperations.campaigns, "u"),
    });
    const automation = screen.getByRole("tab", {
      name: new RegExp(he.tenantOperations.automations, "u"),
    });
    expect(campaign.getAttribute("aria-controls")).toBe(
      "operations-campaigns-panel",
    );
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      campaign.id,
    );
    campaign.focus();
    fireEvent.keyDown(campaign, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(automation);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      automation.id,
    );
    expect(transport.mutate).not.toHaveBeenCalled();
  });

  it("keeps settings field payloads intact after splitting regional preferences", async () => {
    transport.mutate.mockResolvedValueOnce({});
    render(
      localized(
        <ManagementPanel
          {...settingsFixture}
          canManageMembers
          canManageTenant
        />,
      ),
    );
    fireEvent.click(
      screen.getByRole("tab", { name: en.management.workspaceTab }),
    );
    expect(
      screen.getByRole("heading", { name: en.management.identity }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: en.management.regional }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: en.management.save }));
    await vi.waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        "/api/settings",
        {
          ...settingsFixture.settings,
          tenantName: settingsFixture.tenantName,
        },
        { method: "PATCH" },
      ),
    );
  });

  it("shows API-key failure in the active access view without exposing backend details", async () => {
    transport.mutate.mockRejectedValueOnce(new Error("private backend detail"));
    render(
      localized(
        <ManagementPanel
          {...settingsFixture}
          canManageMembers
          canManageTenant
        />,
      ),
    );
    fireEvent.click(
      screen.getByRole("tab", {
        name: new RegExp(en.management.accessTab, "u"),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: en.management.issue }));
    const dialog = screen.getByRole("dialog", { name: en.management.issue });
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: en.management.keyName }),
      { target: { value: "Fictional integration" } },
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: en.management.issue }),
    );
    const feedback = await within(dialog).findByText(en.management.failed);
    expect(feedback.closest("[hidden]")).toBeNull();
    expect(screen.queryByText("private backend detail")).toBeNull();
  });

  it("does not offer owner changes to a tenant administrator", () => {
    render(
      localized(
        <ManagementPanel
          {...settingsFixture}
          canManageMembers
          canManageTenant
          members={[
            {
              userId: "00000000-0000-4000-8000-000000000001",
              email: "owner@example.test",
              displayName: "Owner",
              role: "owner",
            },
            {
              userId: settingsFixture.currentUserId,
              email: "admin@example.test",
              displayName: "Admin",
              role: "admin",
            },
            {
              userId: "00000000-0000-4000-8000-000000000003",
              email: "agent@example.test",
              displayName: "Agent",
              role: "agent",
            },
          ]}
        />,
      ),
    );
    fireEvent.click(screen.getByRole("tab", { name: /Team/u }));

    expect(
      screen.queryByRole("combobox", { name: /owner@example\.test/u }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: /Remove owner@example\.test/u,
      }),
    ).toBeNull();
    const agentRole = screen.getByRole("combobox", {
      name: /agent@example\.test/u,
    });
    expect(
      within(agentRole).queryByRole("option", { name: "Owner" }),
    ).toBeNull();
  });

  it("keeps personal settings available without exposing workspace administration metadata", () => {
    render(
      localized(
        <ManagementPanel
          {...settingsFixture}
          apiKeys={[
            {
              id: "00000000-0000-4000-8000-000000000011",
              name: "Private integration key",
              prefix: "oron_private",
              scopes: ["crm:read"],
              status: "active",
              lastUsedAt: null,
              createdAt: "2026-09-09T00:00:00Z",
            },
          ]}
          invitations={[
            {
              id: "00000000-0000-4000-8000-000000000012",
              email: "invitee@example.test",
              role: "agent",
              expiresAt: "2027-01-01T00:00:00Z",
              createdAt: "2026-09-09T00:00:00Z",
            },
          ]}
          members={[
            {
              userId: "00000000-0000-4000-8000-000000000013",
              email: "member@example.test",
              displayName: "Private member",
              role: "admin",
            },
          ]}
          notifications={[
            {
              id: "00000000-0000-4000-8000-000000000014",
              title: "Personal notification",
              body: "Only this user should see this notification.",
              read: false,
              createdAt: "2026-09-09T00:00:00Z",
            },
          ]}
        />,
      ),
    );

    expect(
      screen.getByRole("tab", { name: en.management.accountTab }),
    ).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: en.tenantSettings.appearance }),
    ).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: en.tenantSettings.security }),
    ).toBeTruthy();
    expect(
      screen.getByRole("tab", {
        name: new RegExp(en.management.notificationsTab, "u"),
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("tab", { name: en.management.workspaceTab }),
    ).toBeNull();
    expect(
      screen.queryByRole("tab", {
        name: new RegExp(en.management.teamTab, "u"),
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("tab", {
        name: new RegExp(en.management.accessTab, "u"),
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("tab", { name: en.tenantSettings.productSettings }),
    ).toBeNull();
    expect(screen.queryByText("member@example.test")).toBeNull();
    expect(screen.queryByText("invitee@example.test")).toBeNull();
    expect(screen.queryByText("Private integration key")).toBeNull();
    expect(screen.queryByDisplayValue("Fictional workspace")).toBeNull();
  });
});
