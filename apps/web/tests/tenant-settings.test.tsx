// @vitest-environment jsdom
import "./dialog-test-support";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManagementPanel } from "../src/features/management";
import { IdentityImage } from "../src/features/identity";
import en from "../src/i18n/messages/en.json";
import he from "../src/i18n/messages/he.json";
import { localized } from "./localized";

const state = vi.hoisted(() => ({
  image: vi.fn(),
  mutate: vi.fn(),
  locale: vi.fn(),
  theme: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useRouter: () => ({ refresh: state.refresh }),
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark", setTheme: state.theme }),
}));
vi.mock("../src/i18n/actions", () => ({ changeLocale: state.locale }));
vi.mock("../src/features/crm", () => ({
  crmMutation: state.mutate,
  imageMutation: state.image,
}));

const props = {
  account: {
    displayName: "Fictional operator",
    email: "operator@example.invalid",
    isSuperuser: false,
  },
  currentUserId: "fictional-owner",
  tenantId: "fictional-tenant",
  tenantName: "Fictional workspace",
  canManageMembers: true,
  canManageTenant: true,
  canManageOwners: true,
  members: [
    {
      userId: "fictional-agent",
      displayName: "Fictional teammate",
      email: "teammate@example.invalid",
      role: "agent" as const,
    },
  ],
  invitations: [],
  apiKeys: [
    {
      id: "fictional-key",
      name: "Fictional read integration",
      prefix: "fictional",
      scopes: ["crm:read"],
      status: "active" as const,
      createdAt: "2026-09-01T00:00:00Z",
      lastUsedAt: null,
    },
    {
      id: "fictional-revoked-key",
      name: "Retired integration",
      prefix: "retired",
      scopes: ["crm:read"],
      status: "revoked" as const,
      createdAt: "2026-09-01T00:00:00Z",
      lastUsedAt: "2026-09-02T00:00:00Z",
    },
  ],
  notifications: [
    {
      id: "fictional-notification",
      title: "Fictional update",
      body: "Your workspace invitation was accepted.",
      read: false,
      createdAt: "2026-09-03T00:00:00Z",
    },
  ],
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
};

function tab(label: string) {
  fireEvent.click(screen.getByRole("tab", { name: new RegExp(label, "u") }));
  return within(screen.getByRole("tabpanel"));
}

beforeEach(() => {
  state.image.mockReset().mockResolvedValue({ ok: true });
  state.mutate.mockReset().mockResolvedValue({ token: "fictional-token" });
  state.locale.mockReset().mockResolvedValue(undefined);
  state.theme.mockReset();
  state.refresh.mockReset();
});
afterEach(cleanup);

describe("tenant settings controls", () => {
  it("offers a tenant-scoped organization logo editor", async () => {
    const { container } = render(localized(<ManagementPanel {...props} />));
    expect(
      container.querySelector<HTMLImageElement>(
        ".settings-overview-card__avatar .identity-image__media",
      )?.src,
    ).toContain("/api/account/avatar");
    expect(
      container.querySelector<HTMLImageElement>(
        ".settings-workspace-identity__logo .identity-image__media",
      )?.src,
    ).toContain("/api/settings/logo");
    const workspace = tab(en.management.workspaceTab);
    expect(workspace.getByText(en.management.organizationLogo)).toBeTruthy();
    expect(
      workspace.getByLabelText<HTMLInputElement>(en.management.uploadLogo)
        .accept,
    ).toBe("image/png,image/jpeg,image/webp");
    fireEvent.click(
      workspace.getByRole("button", { name: en.management.removeLogo }),
    );
    await waitFor(() =>
      expect(state.image).toHaveBeenCalledWith(
        "/api/settings/logo?context=fictional-tenant",
        { method: "DELETE" },
      ),
    );
  });

  it("broadcasts a successful upload only to the rendered tenant's logo copies", async () => {
    const { container } = render(
      localized(
        <>
          <IdentityImage
            contextKey="other-tenant"
            fallback="O"
            source="/api/settings/logo"
          />
          <ManagementPanel {...props} />
        </>,
      ),
    );
    const other = container.querySelector('img[src*="context=other-tenant"]');
    if (!other) throw new Error("Other tenant logo missing");
    fireEvent.load(other);
    const workspace = tab(en.management.workspaceTab);
    const file = new File(["fictional-image"], "logo.png", {
      type: "image/png",
    });
    fireEvent.change(workspace.getByLabelText(en.management.uploadLogo), {
      target: { files: [file] },
    });
    await waitFor(() =>
      expect(state.image).toHaveBeenCalledWith(
        "/api/settings/logo?context=fictional-tenant",
        { file, method: "PATCH" },
      ),
    );
    await waitFor(() =>
      expect(workspace.getByRole("status").textContent).toBe(
        en.management.logoUpdated,
      ),
    );
    for (const mark of container.querySelectorAll(
      'img[src*="context=fictional-tenant"]',
    ))
      expect(mark.getAttribute("src")).toContain(
        "?v=1&context=fictional-tenant",
      );
    expect(other.getAttribute("src")).toContain("?v=0&context=other-tenant");
    expect(other.getAttribute("data-loaded")).toBe("true");
  });

  it("explains stale workspace logo edits in Hebrew without announcing a successful update", async () => {
    state.image.mockRejectedValue(
      new Error("Workspace changed. Refresh before changing its logo."),
    );
    const { container } = render(
      localized(<ManagementPanel {...props} />, "he"),
    );
    const workspace = tab(he.management.workspaceTab);
    fireEvent.click(
      workspace.getByRole("button", { name: he.management.removeLogo }),
    );
    await waitFor(() =>
      expect(workspace.getByRole("alert").textContent).toBe(
        he.management.logoContextChanged,
      ),
    );
    expect(workspace.queryByRole("status")).toBeNull();
    for (const mark of container.querySelectorAll(
      'img[src*="context=fictional-tenant"]',
    ))
      expect(mark.getAttribute("src")).toContain(
        "?v=0&context=fictional-tenant",
      );
  });

  it("keeps unknown logo failures localized without exposing backend details", async () => {
    state.image.mockRejectedValue(new Error("Private backend diagnostic"));
    render(localized(<ManagementPanel {...props} />, "he"));
    const workspace = tab(he.management.workspaceTab);
    fireEvent.click(
      workspace.getByRole("button", { name: he.management.removeLogo }),
    );
    await waitFor(() =>
      expect(workspace.getByRole("alert").textContent).toBe(
        he.management.imageFailed,
      ),
    );
    expect(screen.queryByText("Private backend diagnostic")).toBeNull();
  });

  it("uses real personal preference controls and preserves account drafts across categories", async () => {
    render(localized(<ManagementPanel {...props} />));
    fireEvent.change(screen.getByLabelText(en.management.personalDisplayName), {
      target: { value: "Unsaved personal name" },
    });
    const appearance = tab(en.tenantSettings.appearance);
    fireEvent.change(
      appearance.getByRole("combobox", { name: en.common.language }),
      {
        target: { value: "he" },
      },
    );
    await waitFor(() => expect(state.locale).toHaveBeenCalledWith("he"));
    fireEvent.change(
      appearance.getByRole("combobox", { name: en.shell.themeToggle }),
      {
        target: { value: "light" },
      },
    );
    expect(state.theme).toHaveBeenCalledWith("light");
    const account = tab(en.management.accountTab);
    expect(
      account.getByLabelText<HTMLInputElement>(
        en.management.personalDisplayName,
      ).value,
    ).toBe("Unsaved personal name");
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("keeps password validation critical, scoped, and free of unnecessary mutations", () => {
    render(localized(<ManagementPanel {...props} />));
    const security = tab(en.tenantSettings.security);
    fireEvent.change(security.getByLabelText(en.management.currentPassword), {
      target: { value: "fictional-current" },
    });
    fireEvent.change(security.getByLabelText(en.management.newPassword), {
      target: { value: "fictional-new-password" },
    });
    fireEvent.change(security.getByLabelText(en.management.confirmPassword), {
      target: { value: "fictional-different-password" },
    });
    fireEvent.click(
      security.getByRole("button", { name: en.management.changePassword }),
    );
    expect(security.getByRole("alert").textContent).toContain(
      en.management.passwordMismatch,
    );
    expect(state.mutate).not.toHaveBeenCalled();
    expect(tab(en.management.accountTab).queryByRole("alert")).toBeNull();
    expect(
      tab(en.tenantSettings.security).getByLabelText<HTMLInputElement>(
        en.management.newPassword,
      ).value,
    ).toBe("fictional-new-password");
  });

  it("restores the authoritative member role after a failed change", async () => {
    state.mutate.mockRejectedValue(new Error("Fictional role update failed"));
    render(localized(<ManagementPanel {...props} />));
    const team = tab(en.management.teamTab);
    const role = team.getByRole<HTMLSelectElement>("combobox", {
      name: /teammate@example.invalid/u,
    });
    fireEvent.change(role, { target: { value: "admin" } });
    await waitFor(() => expect(team.getByRole("alert")).toBeTruthy());
    expect(role.value).toBe("agent");
    expect(role.disabled).toBe(false);
    expect(state.mutate).toHaveBeenCalledWith(
      "/api/settings/members/fictional-agent",
      { role: "admin" },
      { method: "PATCH" },
    );
  });

  it("revokes a pending invitation only after confirmation", async () => {
    state.mutate.mockResolvedValueOnce({ ok: true });
    render(
      localized(
        <ManagementPanel
          {...props}
          invitations={[
            {
              id: "40000000-0000-4000-8000-000000000002",
              email: "pending@example.invalid",
              role: "viewer",
              createdAt: "2026-09-10T08:00:00.000Z",
              expiresAt: "2026-09-17T08:00:00.000Z",
            },
          ]}
        />,
      ),
    );
    const team = tab(en.management.teamTab);
    fireEvent.click(
      team.getByRole("button", {
        name: "Revoke invitation for pending@example.invalid",
      }),
    );
    expect(state.mutate).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog", {
      name: en.management.revokeInvitationTitle,
    });
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: en.management.revokeInvitation,
      }),
    );

    await waitFor(() =>
      expect(state.mutate).toHaveBeenCalledWith(
        "/api/settings/invitations/40000000-0000-4000-8000-000000000002",
        {},
        { method: "DELETE" },
      ),
    );
    expect(team.queryByText("pending@example.invalid")).toBeNull();
  });

  it.each([
    ["read", ["crm:read"]],
    ["read-write", ["crm:read", "crm:write"]],
  ])(
    "issues only the selected %s CRM permissions",
    async (permissions, scopes) => {
      render(localized(<ManagementPanel {...props} />));
      const access = tab(en.management.accessTab);
      fireEvent.click(
        access.getByRole("button", { name: en.management.issue }),
      );
      const dialog = within(
        screen.getByRole("dialog", { name: en.management.issue }),
      );
      expect(
        dialog.getByLabelText<HTMLSelectElement>(
          en.tenantSettings.keyPermissions,
        ).value,
      ).toBe("read");
      fireEvent.change(dialog.getByLabelText(en.management.keyName), {
        target: { value: "Fictional integration" },
      });
      fireEvent.change(
        dialog.getByLabelText(en.tenantSettings.keyPermissions),
        { target: { value: permissions } },
      );
      fireEvent.click(
        dialog.getByRole("button", { name: en.management.issue }),
      );
      await waitFor(() =>
        expect(state.mutate).toHaveBeenCalledWith("/api/settings/api-keys", {
          name: "Fictional integration",
          scopes,
        }),
      );
      expect(await dialog.findByText("fictional-token")).toBeTruthy();
    },
  );

  it("requires confirmation to revoke and keeps a failed action recoverable inside the dialog", async () => {
    render(localized(<ManagementPanel {...props} />));
    const access = tab(en.management.accessTab);
    expect(
      access.getAllByRole("button", { name: en.tenantSettings.revoke }),
    ).toHaveLength(1);
    expect(
      access.getByText(new RegExp(en.tenantSettings.neverUsed, "u")),
    ).toBeTruthy();
    fireEvent.click(
      access.getByRole("button", { name: en.tenantSettings.revoke }),
    );
    let confirmation = within(
      screen.getByRole("dialog", { name: en.tenantSettings.revokeTitle }),
    );
    fireEvent.click(
      confirmation.getByRole("button", { name: en.common.cancel }),
    );
    expect(state.mutate).not.toHaveBeenCalled();
    state.mutate.mockRejectedValueOnce(new Error("Fictional revoke failure"));
    fireEvent.click(
      access.getByRole("button", { name: en.tenantSettings.revoke }),
    );
    confirmation = within(
      screen.getByRole("dialog", { name: en.tenantSettings.revokeTitle }),
    );
    fireEvent.click(
      confirmation.getByRole("button", { name: en.tenantSettings.revoke }),
    );
    expect(await confirmation.findByRole("alert")).toBeTruthy();
    expect(
      screen.getByRole("dialog", { name: en.tenantSettings.revokeTitle }),
    ).toBeTruthy();
    fireEvent.click(
      confirmation.getByRole("button", { name: en.tenantSettings.revoke }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: en.tenantSettings.revokeTitle }),
      ).toBeNull(),
    );
    expect(state.mutate).toHaveBeenLastCalledWith(
      "/api/settings/api-keys/fictional-key",
      {},
      { method: "DELETE" },
    );
    expect(access.getByText(en.tenantSettings.keyRevoked)).toBeTruthy();
  });

  it("shows actual personal notification dates and capability-aware product destinations", () => {
    render(
      localized(<ManagementPanel {...props} />, "en", [
        "platform:read",
        "voice:read",
      ]),
    );
    const notifications = tab(en.management.notificationsTab);
    expect(notifications.getByText("Fictional update")).toBeTruthy();
    expect(
      notifications.getByText("Sep 3, 2026").getAttribute("dateTime"),
    ).toBe("2026-09-03T00:00:00Z");
    expect(notifications.getByText(/1 unread of 1/u)).toBeTruthy();
    expect(notifications.queryByRole("checkbox")).toBeNull();
    const products = tab(en.tenantSettings.productSettings);
    expect(products.getAllByRole("link")).toHaveLength(1);
    expect(products.getByRole("link").getAttribute("href")).toBe("/voice");
    expect(screen.queryByText("Real delivery enabled")).toBeNull();
  });

  it("saves only the supported workspace contract and preserves an existing timezone", async () => {
    render(localized(<ManagementPanel {...props} />));
    const workspace = tab(en.management.workspaceTab);
    fireEvent.change(workspace.getByLabelText(en.management.tenantName), {
      target: { value: "Updated fictional workspace" },
    });
    fireEvent.click(
      workspace.getByRole("button", { name: en.management.save }),
    );
    await waitFor(() =>
      expect(state.mutate).toHaveBeenCalledWith(
        "/api/settings",
        {
          accentToken: null,
          businessAddress: "",
          businessEmail: "",
          businessName: "",
          businessPhone: "",
          tenantName: "Updated fictional workspace",
          displayName: "Fictional workspace",
          defaultCurrency: "ILS",
          locale: "he",
          reportFooter: "",
          reportHeader: "",
          timezone: "Asia/Jerusalem",
        },
        { method: "PATCH" },
      ),
    );
  });

  it("exposes the same real appearance and security categories in Hebrew", () => {
    render(localized(<ManagementPanel {...props} />, "he"));
    const appearance = tab(he.tenantSettings.appearance);
    expect(
      appearance.getByRole("combobox", { name: he.common.language }),
    ).toBeTruthy();
    expect(
      appearance.getByRole("combobox", { name: he.shell.themeToggle }),
    ).toBeTruthy();
    const security = tab(he.tenantSettings.security);
    expect(
      security.getByRole("button", { name: he.management.changePassword }),
    ).toBeTruthy();
    expect(screen.getByRole("tablist").getAttribute("aria-orientation")).toBe(
      "vertical",
    );
    fireEvent.keyDown(
      screen.getByRole("tab", { name: he.tenantSettings.security }),
      { key: "ArrowUp" },
    );
    expect(
      screen
        .getByRole("tab", { name: he.tenantSettings.appearance })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });
});
