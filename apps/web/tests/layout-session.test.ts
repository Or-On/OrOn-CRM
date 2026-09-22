import { beforeEach, describe, expect, it, vi } from "vitest";
const { currentPublicSession, shellTenant, path } = vi.hoisted(() => ({
  currentPublicSession: vi.fn(),
  shellTenant: vi.fn(),
  path: { value: "/field-service" },
}));
vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "font-latin" }),
  Geist_Mono: () => ({ variable: "font-mono" }),
  Heebo: () => ({ variable: "font-hebrew" }),
}));
vi.mock("next-intl/server", () => ({
  getLocale: vi.fn().mockResolvedValue("en"),
  getTranslations: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve(new Headers({ "x-or-on-pathname": path.value })),
}));
vi.mock("next/navigation", () => ({
  redirect: (destination: string) => {
    throw new Error(`redirect:${destination}`);
  },
}));
vi.mock("../src/features/auth", () => ({
  currentPublicSession,
  withCurrentShellTenant: shellTenant,
}));
import RootLayout from "../src/app/layout";

const membership = {
  role: "technician" as const,
  tenantId: "00000000-0000-4000-8000-000000000001",
  tenantName: "ProTouch",
  tenantSlug: "protouch",
};

function session(scope: "workspace" | "field-service") {
  return {
    applicationScope: scope,
    expiresAt: "2030-01-01T00:00:00.000Z",
    memberships: [membership],
    permissions: ["field-service:read"],
    tenant:
      scope === "workspace" ? { ...membership, role: "owner" } : membership,
    user: {
      email: "technicians@example.test",
      id: "00000000-0000-4000-8000-000000000002",
      isSuperuser: false,
    },
  };
}

describe("application layout session resolution", () => {
  beforeEach(() => {
    currentPublicSession.mockReset();
    shellTenant.mockReset().mockResolvedValue({
      businessName: "ProTouch",
      accentToken: null,
      fieldServiceEnabled: true,
      enabledFeatures: ["field_service"],
    });
    path.value = "/field-service";
  });
  it("resolves session state for the application entry", async () => {
    currentPublicSession.mockResolvedValue(undefined);
    await RootLayout({ children: null });
    expect(currentPublicSession).toHaveBeenCalledOnce();
  });
  it("returns a technician to the Field Service app on a workspace page", async () => {
    currentPublicSession.mockResolvedValue(session("field-service"));
    path.value = "/profile";
    await expect(RootLayout({ children: null })).rejects.toThrow(
      "redirect:/field-service",
    );
  });
  it("keeps technician pages and workspace sessions in place", async () => {
    currentPublicSession.mockResolvedValue(session("field-service"));
    path.value = "/field-service/cases/10000000-0000-4000-8000-000000000001";
    await expect(RootLayout({ children: null })).resolves.toBeTruthy();

    currentPublicSession.mockResolvedValue(session("workspace"));
    path.value = "/profile";
    await expect(RootLayout({ children: null })).resolves.toBeTruthy();
  });
});
