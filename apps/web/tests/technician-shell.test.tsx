// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PublicSession } from "@or-on/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "../src/features/shell";
import { localized } from "./localized";

const navigation = vi.hoisted(() => ({
  pathname: "/field-service",
  prefetch: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: navigation.push,
    prefetch: navigation.prefetch,
    refresh: navigation.refresh,
    replace: navigation.replace,
  }),
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark", setTheme: vi.fn() }),
}));

const technicianMembership = {
  role: "technician" as const,
  tenantId: "00000000-0000-4000-8000-000000000011",
  tenantName: "ProTouch",
  tenantSlug: "protouch",
};
const technicianSession: PublicSession = {
  applicationScope: "field-service",
  expiresAt: "2030-01-01T00:00:00.000Z",
  memberships: [technicianMembership],
  permissions: ["field-service:read", "field-service:operate"],
  tenant: technicianMembership,
  user: {
    displayName: "ProTouch Technician",
    email: "technicians@example.test",
    id: "00000000-0000-4000-8000-000000000012",
    isSuperuser: false,
  },
};
const ownerMembership = { ...technicianMembership, role: "owner" as const };
const ownerSession: PublicSession = {
  applicationScope: "workspace",
  expiresAt: "2030-01-01T00:00:00.000Z",
  memberships: [ownerMembership],
  permissions: [
    "platform:read",
    "crm:read",
    "crm:write",
    "members:manage",
    "tenant:manage",
    "field-service:read",
    "field-service:operate",
    "field-service:manage",
  ],
  tenant: ownerMembership,
  user: {
    email: "owner@example.test",
    id: "00000000-0000-4000-8000-000000000013",
    isSuperuser: false,
  },
};
const enabledFeatures = [
  "contacts",
  "whatsapp",
  "voice",
  "agents",
  "tickets",
  "leads",
  "pipeline",
  "field_service",
  "technicians",
  "appointments",
];

const workspaceDestinations = [
  "/",
  "/inbox",
  "/email",
  "/calendar",
  "/tickets",
  "/leads",
  "/contacts",
  "/pipelines",
  "/operations",
  "/voice",
  "/orchestration",
  "/finance",
  "/profile",
  "/users",
  "/roles",
  "/tenants",
  "/system/health",
  "/settings",
  "/start",
];

function shell(session: PublicSession) {
  return render(
    localized(
      <AppShell
        enabledFeatures={enabledFeatures}
        fieldServiceEnabled
        session={session}
      >
        Field work
      </AppShell>,
      "en",
      session.permissions as never,
    ),
  );
}

describe("technician application shell", () => {
  beforeEach(() => {
    navigation.pathname = "/field-service";
    const preferences = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => preferences.get(key) ?? null,
      setItem: (key: string, value: string) => preferences.set(key, value),
      removeItem: (key: string) => preferences.delete(key),
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: false,
        removeEventListener: vi.fn(),
      })),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("no network in shell tests"))),
    );
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows only Field Service with sign-out, language and theme", () => {
    const { container } = shell(technicianSession);

    expect(
      [...container.querySelectorAll("nav .nav__item")].map((item) =>
        item.getAttribute("href"),
      ),
    ).toEqual(["/field-service"]);
    expect(
      container.querySelector('nav a.nav__item[aria-label="Field Service"]'),
    ).not.toBeNull();
    for (const href of workspaceDestinations)
      expect(container.querySelector(`a[href="${href}"]`), href).toBeNull();
    // Brand links return to the technician application, never the workspace.
    expect(
      [...container.querySelectorAll("a.brand, a.mobile-brand")].map((link) =>
        link.getAttribute("href"),
      ),
    ).toEqual(["/field-service", "/field-service"]);
    expect(screen.queryByText("Quick create")).toBeNull();
    expect(screen.queryByRole("button", { name: "Notifications" })).toBeNull();
    expect(
      screen.getByRole("combobox", { name: "Interface language" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Switch to light theme" }),
    ).toBeTruthy();
    // The shared account never requests workspace profile media.
    expect(
      container.querySelector('img[src*="/api/account/avatar"]'),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(container.querySelector('a[href="/profile"]')).toBeNull();
  });

  it("offers only Field Service in the command palette", () => {
    shell(technicianSession);
    const trigger = screen.getAllByRole("button", {
      name: "Open command palette",
    })[0];
    if (!trigger) throw new Error("Command trigger was not rendered");
    fireEvent.click(trigger);
    const results = () =>
      [...document.querySelectorAll('#command-results [role="option"]')].map(
        (option) => option.textContent,
      );
    expect(results()).toHaveLength(1);
    expect(results()[0]).toContain("Field Service");
    fireEvent.change(
      screen.getByRole("combobox", { name: "Find a destination" }),
      {
        target: { value: "contacts" },
      },
    );
    expect(results()).toHaveLength(0);
  });

  it("keeps the owner workspace shell unchanged", () => {
    navigation.pathname = "/";
    const { container } = shell(ownerSession);
    for (const href of [
      "/",
      "/contacts",
      "/settings",
      "/start",
      "/system/health",
    ])
      expect(container.querySelector(`a[href="${href}"]`), href).not.toBeNull();
    expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(
      container.querySelector('.account-menu__panel a[href="/profile"]'),
    ).not.toBeNull();
  });
});
