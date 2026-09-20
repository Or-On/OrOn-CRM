// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { PublicSession } from "@or-on/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "../src/features/shell";
import en from "../src/i18n/messages/en.json";
import { localized } from "./localized";

const navigation = vi.hoisted(() => ({
  pathname: "/",
  prefetch: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  search: "",
}));
const theme = vi.hoisted(() => ({ setTheme: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({
    push: navigation.push,
    prefetch: navigation.prefetch,
    refresh: navigation.refresh,
    replace: navigation.replace,
  }),
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark", setTheme: theme.setTheme }),
}));

const membership = {
  role: "owner" as const,
  tenantId: "00000000-0000-4000-8000-000000000001",
  tenantName: "Fictional Preview",
  tenantSlug: "fictional-preview",
};
const session: PublicSession = {
  expiresAt: "2030-01-01T00:00:00.000Z",
  memberships: [membership],
  permissions: [
    "platform:read",
    "crm:read",
    "crm:write",
    "messaging:operate",
    "campaigns:manage",
    "voice:read",
    "flows:manage",
  ],
  tenant: membership,
  user: {
    email: "operator@example.test",
    id: "00000000-0000-4000-8000-000000000002",
    isSuperuser: false,
  },
};

function openPalette() {
  const trigger = screen.getAllByRole("button", {
    name: "Open command palette",
  })[0];
  if (!trigger) throw new Error("Command trigger was not rendered");
  fireEvent.click(trigger);
}

describe("route-backed workspace commands", () => {
  beforeEach(() => {
    navigation.pathname = "/";
    navigation.search = "";
    const preferences = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      clear: () => preferences.clear(),
      getItem: (key: string) => preferences.get(key) ?? null,
      key: (index: number) => [...preferences.keys()][index] ?? null,
      get length() {
        return preferences.size;
      },
      removeItem: (key: string) => {
        preferences.delete(key);
      },
      setItem: (key: string, value: string) => {
        preferences.set(key, value);
      },
    });
    navigation.push.mockReset();
    navigation.prefetch.mockReset();
    navigation.refresh.mockReset();
    navigation.replace.mockReset();
    theme.setTheme.mockReset();
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: false,
        media: "(max-width: 62rem)",
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("hides empty navigation groups and unavailable commands in leads-only workspaces", () => {
    const { container } = render(
      localized(
        <AppShell session={session} enabledFeatures={["contacts", "leads"]}>
          Workspace
        </AppShell>,
      ),
    );
    expect(
      [...container.querySelectorAll(".nav__group-label")].map(
        (element) => element.textContent,
      ),
    ).not.toContain("Operations");
    expect(container.querySelector('a[href="/inbox"]')).toBeNull();
    expect(container.querySelector('a[href="/voice"]')).toBeNull();
    expect(container.querySelector('a[href="/tickets"]')).toBeNull();
    openPalette();
    const palette = screen.getByRole("dialog");
    expect(within(palette).queryByText("Start campaign")).toBeNull();
    expect(within(palette).queryByText("Open agents")).toBeNull();
  });

  it("switches the header from dark to light through the shared theme behavior", () => {
    render(localized(<AppShell session={session}>Workspace</AppShell>));

    fireEvent.click(
      screen.getByRole("button", { name: "Switch to light theme" }),
    );

    expect(theme.setTheme).toHaveBeenCalledOnce();
    expect(theme.setTheme).toHaveBeenCalledWith("light");
  });

  it("applies tenant white-label identity through approved shell tokens", () => {
    const { container } = render(
      localized(
        <AppShell
          session={session}
          tenantBranding={{
            businessName: "Northstar Service",
            accentToken: "emerald",
          }}
        >
          Workspace
        </AppShell>,
      ),
    );

    expect(screen.getAllByText("Northstar Service").length).toBeGreaterThan(0);
    expect(
      container.querySelector(".shell")?.getAttribute("data-tenant-accent"),
    ).toBe("emerald");
    const marks = container.querySelectorAll(".workspace-brand-mark img");
    expect(marks).toHaveLength(2);
    for (const mark of marks) {
      expect(mark.getAttribute("src")).toBe(
        `/api/settings/logo?v=0&context=${membership.tenantId}`,
      );
      expect(mark.getAttribute("alt")).toBe("");
    }
    expect(container.querySelector(".brand .product-logo")).toBeNull();
  });

  it("uses the active tenant logo in all Inbox brand surfaces and resets it on switching", () => {
    navigation.pathname = "/inbox";
    const view = render(
      localized(<AppShell session={session}>Inbox</AppShell>),
    );
    const marks = view.container.querySelectorAll(".workspace-brand-mark img");
    expect(marks).toHaveLength(3);
    for (const mark of marks) fireEvent.load(mark);
    const changed = {
      ...session,
      tenant: {
        ...membership,
        tenantId: "tenant-b",
        tenantName: "Second workspace",
      },
    };
    view.rerender(localized(<AppShell session={changed}>Inbox</AppShell>));
    for (const mark of view.container.querySelectorAll(
      ".workspace-brand-mark img",
    )) {
      expect(mark.getAttribute("src")).toContain("context=tenant-b");
      expect(mark.hasAttribute("data-loaded")).toBe(false);
    }
    expect(
      view.container.querySelector(".inbox-topbar-brand .workspace-brand-name")
        ?.textContent,
    ).toBe("Second workspace");
    expect(
      view.container
        .querySelector(".inbox-topbar-brand")
        ?.getAttribute("aria-label"),
    ).toBe(en.shell.brandHome);
  });

  it("keeps Inbox search synchronized with same-route navigation and reset without remounting drafts", () => {
    navigation.pathname = "/inbox";
    navigation.search = "search=Priority%20client";
    const workspace = () =>
      localized(
        <AppShell session={session}>
          <textarea aria-label="Reply draft" defaultValue="" />
        </AppShell>,
      );
    const view = render(workspace());
    const search = screen.getByRole<HTMLInputElement>("searchbox");
    const reply = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Reply draft",
    });
    expect(search.value).toBe("Priority client");
    fireEvent.change(reply, { target: { value: "Unsent reply" } });

    // Next's route hook supplies each committed query, including back/forward.
    for (const term of ["Maya Cohen", "Priority client", "Maya Cohen", ""]) {
      navigation.search = term ? `search=${encodeURIComponent(term)}` : "";
      view.rerender(workspace());
      expect(search.value).toBe(term);
      expect(
        screen.getByRole<HTMLTextAreaElement>("textbox", {
          name: "Reply draft",
        }),
      ).toBe(reply);
      expect(reply.value).toBe("Unsent reply");
    }
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("retains unsubmitted Inbox search text during conversation and filter changes", () => {
    navigation.pathname = "/inbox";
    navigation.search = "search=Priority&conversation=first";
    const workspace = () =>
      localized(<AppShell session={session}>Inbox</AppShell>);
    const view = render(workspace());
    const search = screen.getByRole<HTMLInputElement>("searchbox");
    fireEvent.change(search, { target: { value: "  Maya & team  " } });

    navigation.search = "search=Priority&conversation=second&filter=unread";
    view.rerender(workspace());
    expect(search.value).toBe("  Maya & team  ");

    if (!search.form) throw new Error("Inbox search form was not rendered");
    fireEvent.submit(search.form);
    expect(navigation.replace).toHaveBeenLastCalledWith(
      "/inbox?search=Maya+%26+team&conversation=second&filter=unread",
    );
    expect(search.value).toBe("Maya & team");
  });

  it("clears only the Inbox search parameter and does not leave a trailing query separator", () => {
    navigation.pathname = "/inbox";
    navigation.search = "conversation=second&search=Priority&filter=unread";
    const workspace = () =>
      localized(<AppShell session={session}>Inbox</AppShell>);
    const view = render(workspace());
    const search = screen.getByRole<HTMLInputElement>("searchbox");
    if (!search.form) throw new Error("Inbox search form was not rendered");

    fireEvent.change(search, { target: { value: "   " } });
    fireEvent.submit(search.form);
    expect(navigation.replace).toHaveBeenLastCalledWith(
      "/inbox?conversation=second&filter=unread",
    );
    expect(search.value).toBe("");

    navigation.search = "search=Priority";
    view.rerender(workspace());
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.submit(search.form);
    expect(navigation.replace).toHaveBeenLastCalledWith("/inbox");
  });

  it("routes real creation and entity-search intents with keyboard-safe labels", () => {
    render(localized(<AppShell session={session}>Workspace</AppShell>));

    expect(screen.getAllByText("Ctrl/⌘ K").length).toBeGreaterThan(0);
    openPalette();
    fireEvent.click(screen.getByRole("option", { name: /Create contact/u }));
    expect(navigation.push).toHaveBeenLastCalledWith("/contacts?create=1");

    openPalette();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Find a destination" }),
      {
        target: { value: "Maya Cohen" },
      },
    );
    fireEvent.click(
      screen.getByRole("option", { name: /Search contacts for “Maya Cohen”/u }),
    );
    expect(navigation.push).toHaveBeenLastCalledWith(
      "/contacts?q=Maya%20Cohen",
    );

    openPalette();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Find a destination" }),
      {
        target: { value: "Priority client" },
      },
    );
    fireEvent.click(
      screen.getByRole("option", {
        name: /Search conversations for “Priority client”/u,
      }),
    );
    expect(navigation.push).toHaveBeenLastCalledWith(
      "/inbox?search=Priority%20client",
    );
  });

  it("keeps authenticated navigation across routes and hides it for signed-out users", () => {
    const view = render(
      localized(<AppShell session={session}>Nested content</AppShell>),
    );
    expect(
      screen.getByRole("navigation", { name: "Platform modules" }),
    ).toBeTruthy();

    navigation.pathname = "/en";
    view.rerender(
      localized(<AppShell session={session}>Public content</AppShell>),
    );
    expect(
      screen.getByRole("navigation", { name: "Platform modules" }),
    ).toBeTruthy();

    navigation.pathname = "/en/product";
    view.rerender(
      localized(<AppShell session={session}>Nested content</AppShell>),
    );
    expect(
      screen.getByRole("navigation", { name: "Platform modules" }),
    ).toBeTruthy();
    view.rerender(localized(<AppShell session={undefined}>Sign in</AppShell>));
    expect(
      screen.queryByRole("navigation", { name: "Platform modules" }),
    ).toBeNull();
  });

  it("never exposes authenticated navigation on an invitation link", () => {
    navigation.pathname = "/invite";
    render(localized(<AppShell session={session}>Join workspace</AppShell>));

    expect(screen.getByText("Join workspace")).toBeTruthy();
    expect(
      screen.queryByRole("navigation", { name: "Platform modules" }),
    ).toBeNull();
    expect(document.querySelector(".auth-layout")).toBeTruthy();
  });

  it("warms route data only when a user shows navigation intent", () => {
    render(localized(<AppShell session={session}>Workspace</AppShell>));
    const tickets = screen.getByRole("link", { name: "Tickets" });

    expect(navigation.prefetch).not.toHaveBeenCalled();
    fireEvent.mouseEnter(tickets);
    expect(navigation.prefetch).toHaveBeenLastCalledWith("/tickets");

    fireEvent.focus(tickets);
    expect(navigation.prefetch).toHaveBeenLastCalledWith("/tickets");
  });

  it("starts expanded, persists navigation density, and collapses with Escape", () => {
    const view = render(
      localized(
        <AppShell session={session}>
          <button type="button">Workspace action</button>
        </AppShell>,
      ),
    );
    const trigger = screen.getByRole("button", {
      name: "Collapse navigation",
    });
    const shell = view.container.querySelector(".shell");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(shell?.classList.contains("shell--expanded")).toBe(true);

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(shell?.classList.contains("shell--expanded")).toBe(false);
    expect(window.localStorage.getItem("or-on.navigation-rail")).toBe(
      "collapsed",
    );

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(shell?.classList.contains("shell--expanded")).toBe(true);
    expect(window.localStorage.getItem("or-on.navigation-rail")).toBe(
      "expanded",
    );

    const outside = screen.getByRole("button", { name: "Workspace action" });
    outside.focus();
    fireEvent.pointerDown(outside);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(outside);

    navigation.pathname = "/contacts";
    view.rerender(localized(<AppShell session={session}>Contacts</AppShell>));
    expect(shell?.classList.contains("shell--expanded")).toBe(true);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(window.localStorage.getItem("or-on.navigation-rail")).toBe(
      "collapsed",
    );
    expect(document.activeElement).toBe(trigger);
  });

  it("shows contextual navigation only for a module with true subroutes", () => {
    navigation.pathname = "/contacts";
    const view = render(
      localized(<AppShell session={session}>Contacts</AppShell>),
    );
    expect(
      screen.queryByRole("navigation", { name: "Related workspace views" }),
    ).toBeNull();

    navigation.pathname = "/voice";
    view.rerender(localized(<AppShell session={session}>Voice</AppShell>));
    const contextual = screen.getByRole("navigation", {
      name: "Related workspace views",
    });
    expect(contextual.querySelectorAll("a")).toHaveLength(3);
    expect(
      view.container.querySelector(".shell__main--with-context"),
    ).toBeTruthy();
  });

  it("makes the active tenant context explicit for a platform administrator", () => {
    const elevated: PublicSession = {
      ...session,
      user: { ...session.user, isSuperuser: true },
    };
    const { container } = render(
      localized(<AppShell session={elevated}>Workspace</AppShell>),
    );
    const switcher = container.querySelector(".tenant-switcher");
    expect(container.querySelector(".brand__name")?.textContent).toBe(
      membership.tenantName,
    );
    expect(
      switcher?.classList.contains("tenant-switcher--platform-admin"),
    ).toBe(true);
    expect(switcher?.textContent).toContain("Platform administrator");
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(
      screen.getByRole("combobox", { name: /Platform administrator/u }),
    ).toBeTruthy();
  });

  it("closes the account popover with Escape, restores its trigger and keeps the rail expanded", () => {
    render(localized(<AppShell session={session}>Workspace</AppShell>));
    const trigger = screen.getByRole("button", { name: "Account menu" });
    fireEvent.click(trigger);
    const accountMenu = screen.getByRole("dialog", { name: "Account menu" });
    expect(accountMenu).toBeTruthy();
    expect(
      within(accountMenu).queryByRole("combobox", {
        name: "Interface language",
      }),
    ).toBeNull();
    expect(
      within(accountMenu).queryByRole("combobox", {
        name: "Toggle color theme",
      }),
    ).toBeNull();
    const signOut = screen.getByRole("button", { name: "Sign out" });
    signOut.focus();
    fireEvent.keyDown(signOut, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog", { name: "Account menu" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(
      screen
        .getByRole("button", { name: "Collapse navigation" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("dismisses the account outside its panel without moving focus from the workspace", () => {
    render(
      localized(
        <AppShell session={session}>
          <button type="button">Workspace action</button>
        </AppShell>,
      ),
    );
    const trigger = screen.getByRole("button", { name: "Account menu" });
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("dialog", { name: "Account menu" }));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const outside = screen.getByRole("button", { name: "Workspace action" });
    outside.focus();
    fireEvent.pointerDown(outside);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(outside);
  });

  it("closes the account after navigation and protects the command dialog from the rail Escape handler", () => {
    const view = render(
      localized(<AppShell session={session}>Workspace</AppShell>),
    );
    const trigger = screen.getByRole("button", { name: "Account menu" });
    fireEvent.click(trigger);
    navigation.pathname = "/contacts";
    view.rerender(localized(<AppShell session={session}>Contacts</AppShell>));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    fireEvent.keyDown(window, { ctrlKey: true, key: "k" });
    const search = screen.getByRole("combobox", { name: "Find a destination" });
    expect(document.activeElement).toBe(search);
    // The new modal takes focus, so the nonmodal account popover dismisses.
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    const expanded = screen.getByRole("button", {
      name: "Collapse navigation",
    });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(expanded.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(search);
  });

  it("quick-create exposes real permitted routes with menu keyboard navigation", () => {
    render(localized(<AppShell session={session}>Workspace</AppShell>));
    const trigger = screen.getByRole("button", { name: "Quick create" });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    const first = screen.getByRole("menuitem", { name: "Create contact" });
    const campaign = screen.getByRole("menuitem", {
      name: "Start messaging campaign",
    });
    expect(first.getAttribute("href")).toBe("/contacts?create=1");
    expect(campaign.getAttribute("href")).toBe("/operations?create=campaign");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(campaign);
    fireEvent.keyDown(campaign, { key: "Home" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Quick create" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(
      screen
        .getByRole("button", { name: "Collapse navigation" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });
});
