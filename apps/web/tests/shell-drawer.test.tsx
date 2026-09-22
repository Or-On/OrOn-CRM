// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { PublicSession } from "@or-on/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "../src/features/shell";
import { localized } from "./localized";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark", setTheme: vi.fn() }),
}));

const membership = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  tenantName: "Fictional Preview",
  tenantSlug: "fictional-preview",
  role: "owner" as const,
};
const session: PublicSession = {
  user: {
    id: "00000000-0000-4000-8000-000000000002",
    email: "operator@example.test",
    isSuperuser: false,
  },
  tenant: membership,
  memberships: [membership],
  expiresAt: "2030-01-01T00:00:00.000Z",
  permissions: [],
  applicationScope: "workspace",
};

describe("responsive workspace drawer", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        media: "(max-width: 62rem)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("moves and contains focus, shields content, and supports every close path", () => {
    const { container } = render(
      localized(
        <AppShell session={session}>
          <button type="button">Background action</button>
        </AppShell>,
      ),
    );
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    const main = container.querySelector<HTMLElement>(".shell__main");

    fireEvent.click(trigger);
    let drawer = screen.getByRole("dialog", {
      name: "Workspace navigation",
    });
    const first = drawer.querySelector<HTMLElement>("a[href]");
    const focusable = drawer.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const last = focusable.item(focusable.length - 1);

    expect(document.activeElement).toBe(first);
    expect(main?.hasAttribute("inert")).toBe(true);
    expect(main?.getAttribute("aria-hidden")).toBe("true");
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    const inDrawerClose = screen
      .getAllByRole("button", { name: "Close navigation" })
      .find((button) => drawer.contains(button));
    if (!inDrawerClose)
      throw new Error("Drawer close control was not rendered");
    fireEvent.click(inDrawerClose);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    drawer = screen.getByRole("dialog", { name: "Workspace navigation" });
    expect(drawer).toBeTruthy();
    const scrim = container.querySelector<HTMLButtonElement>(".shell__scrim");
    if (!scrim) throw new Error("Drawer scrim was not rendered");
    fireEvent.click(scrim);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
