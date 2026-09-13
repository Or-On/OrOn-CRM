import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderMarkup as renderToStaticMarkup } from "./localized";

const state = vi.hoisted(() => ({
  apiKeys: vi.fn(),
  invitations: vi.fn(),
  members: vi.fn(),
  notifications: vi.fn(),
  role: "viewer",
  settings: vi.fn(),
  superuser: false,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  usePathname: () => "/settings",
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@or-on/auth", () => ({
  permissions: [],
  hasPermission: (role: string, permission: string) =>
    role === "owner" ||
    role === "admin" ||
    (role === "agent" && permission === "members:manage"),
}));
vi.mock("@or-on/crm", () => ({
  getTenantSettings: state.settings,
  listApiKeys: state.apiKeys,
  listNotifications: state.notifications,
  listTeamMembers: state.members,
  listTenantInvitations: state.invitations,
}));
vi.mock("../src/features/auth", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  withCurrentTenant: (
    _permission: string,
    operation: (sql: object, session: object) => Promise<unknown>,
  ) =>
    operation(
      {},
      {
        displayName: "Current operator",
        email: "current@example.test",
        isSuperuser: state.superuser,
        tenant: {
          role: state.role,
          tenantName: "Restricted workspace",
        },
        userId: "00000000-0000-4000-8000-000000000001",
      },
    ),
}));

import SettingsPage from "../src/app/settings/page";

describe("settings read scope", () => {
  beforeEach(() => {
    state.role = "viewer";
    state.superuser = false;
    state.apiKeys.mockReset().mockResolvedValue([
      {
        id: "key-id",
        name: "Restricted API key",
        prefix: "private_prefix",
        scopes: ["crm:read"],
        status: "active",
        lastUsedAt: null,
        createdAt: "2026-09-09T00:00:00Z",
      },
    ]);
    state.invitations.mockReset().mockResolvedValue([
      {
        id: "invitation-id",
        email: "invitee@example.test",
        role: "agent",
        expiresAt: "2027-01-01T00:00:00Z",
        createdAt: "2026-09-09T00:00:00Z",
      },
    ]);
    state.members.mockReset().mockResolvedValue([
      {
        userId: "member-id",
        email: "member@example.test",
        displayName: "Restricted member",
        role: "admin",
      },
    ]);
    state.notifications.mockReset().mockResolvedValue([
      {
        id: "notification-id",
        title: "Personal notification",
        body: "Visible to the current user.",
        read: false,
        createdAt: "2026-09-09T00:00:00Z",
      },
    ]);
    state.settings.mockReset().mockResolvedValue({
      displayName: "Restricted workspace",
      defaultCurrency: "ILS",
      locale: "he",
      timezone: "Asia/Jerusalem",
    });
  });

  it("loads only personal account and notifications for a restricted role", async () => {
    const markup = renderToStaticMarkup(await SettingsPage());

    expect(state.notifications).toHaveBeenCalledTimes(1);
    expect(state.members).not.toHaveBeenCalled();
    expect(state.invitations).not.toHaveBeenCalled();
    expect(state.apiKeys).not.toHaveBeenCalled();
    expect(state.settings).not.toHaveBeenCalled();
    expect(markup).toContain("current@example.test");
    expect(markup).toContain("Personal notification");
    expect(markup).not.toContain("member@example.test");
    expect(markup).not.toContain("invitee@example.test");
    expect(markup).not.toContain("Restricted API key");
    expect(markup).not.toContain("Real delivery enabled");
  });

  it.each([
    ["tenant administrator", "admin", false],
    ["platform super administrator", "viewer", true],
  ] as const)(
    "loads tenant administration metadata for a %s",
    async (_label, role, superuser) => {
      state.role = role;
      state.superuser = superuser;
      const markup = renderToStaticMarkup(await SettingsPage());

      expect(state.notifications).toHaveBeenCalledTimes(1);
      expect(state.members).toHaveBeenCalledTimes(1);
      expect(state.invitations).toHaveBeenCalledTimes(1);
      expect(state.apiKeys).toHaveBeenCalledTimes(1);
      expect(state.settings).toHaveBeenCalledTimes(1);
      expect(markup).toContain("member@example.test");
      expect(markup).toContain("invitee@example.test");
      expect(markup).toContain("Restricted API key");
      expect(markup).not.toContain("Real delivery enabled");
    },
  );
});
