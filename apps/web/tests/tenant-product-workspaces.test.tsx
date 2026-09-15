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

import type {
  CalendarEvent,
  Expense,
  ExpenseSummary,
  Task as TenantTask,
  TeamMember,
} from "@or-on/crm";

import { CalendarWorkspace } from "../src/features/calendar";
import { EmailWorkspace, type EmailChannel } from "../src/features/email";
import {
  FinanceWorkspace,
  type VoiceUsageEstimate,
} from "../src/features/finance";
import { ProfileWorkspace } from "../src/features/profile";
import { RolesWorkspace, type RoleRecord } from "../src/features/roles";
import { TasksWorkspace } from "../src/features/tasks";
import { UsersWorkspace } from "../src/features/users";
import { localized } from "./localized";

const transport = vi.hoisted(() => ({
  image: vi.fn(),
  mutate: vi.fn(),
  read: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  changeLocale: vi.fn(),
  setTheme: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/profile",
  useRouter: () => ({
    push: transport.push,
    refresh: transport.refresh,
  }),
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark", setTheme: transport.setTheme }),
}));
vi.mock("../src/i18n/actions", () => ({
  changeLocale: transport.changeLocale,
}));
vi.mock("../src/features/crm", () => ({
  crmMutation: transport.mutate,
  crmRead: transport.read,
  imageMutation: transport.image,
}));

const members: readonly TeamMember[] = [
  {
    userId: "operator-owner",
    displayName: "Ari Owner",
    email: "owner@example.invalid",
    role: "owner",
  },
  {
    userId: "operator-agent",
    displayName: "Maya Agent",
    email: "agent@example.invalid",
    role: "agent",
  },
  {
    userId: "operator-viewer",
    displayName: null,
    email: "viewer@example.invalid",
    role: "viewer",
  },
];

const nowIso = new Date().toISOString();

function expense(id: string, overrides: Partial<Expense> = {}): Expense {
  return {
    id,
    createdByUserId: "operator-owner",
    title: `Expense ${id}`,
    vendor: "Fictional vendor",
    category: "Operations",
    amount: "125.50",
    currency: "USD",
    status: "recorded",
    sourceKind: "manual",
    sourceReference: null,
    notes: null,
    incurredAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
  };
}

const expenses: readonly Expense[] = [
  expense("usd", { title: "Cloud hosting" }),
  expense("ils", {
    title: "Office supplies",
    amount: "200.00",
    currency: "ILS",
    status: "pending",
  }),
];

const expenseSummary: ExpenseSummary = {
  totals: [
    {
      currency: "USD",
      recordedTotal: "125.50",
      pendingTotal: "0",
      recordedCount: 1,
      pendingCount: 0,
    },
    {
      currency: "ILS",
      recordedTotal: "0",
      pendingTotal: "200.00",
      recordedCount: 0,
      pendingCount: 1,
    },
  ],
  expenseCount: 2,
  recordedCount: 1,
  pendingCount: 1,
  voidCount: 0,
};

const voiceEstimates: readonly VoiceUsageEstimate[] = [
  {
    id: "voice-session",
    createdAt: nowIso,
    totalUsd: 3.5,
    durationSeconds: 94,
    partial: true,
  },
];

function task(id: string, overrides: Partial<TenantTask> = {}): TenantTask {
  return {
    id,
    createdByUserId: "operator-owner",
    assigneeUserId: "operator-agent",
    contactId: null,
    contactName: null,
    title: `Task ${id}`,
    description: `Description ${id}`,
    status: "todo",
    priority: "medium",
    dueAt: null,
    completedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
  };
}

function currentMonthBounds() {
  const cursor = new Date();
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  first.setHours(0, 0, 0, 0);
  first.setDate(first.getDate() - first.getDay());
  const to = new Date(first);
  to.setDate(to.getDate() + 42);
  return { from: first.toISOString(), to: to.toISOString() };
}

function calendarEvent(
  id: string,
  overrides: Partial<CalendarEvent> = {},
): CalendarEvent {
  const starts = new Date();
  starts.setHours(10, 0, 0, 0);
  const ends = new Date(starts.getTime() + 3_600_000);
  return {
    id,
    createdByUserId: "operator-owner",
    organizerUserId: "operator-agent",
    title: "Quarterly planning",
    description: "Fictional planning fixture",
    location: "Studio A",
    startsAt: starts.toISOString(),
    endsAt: ends.toISOString(),
    allDay: false,
    timezone: "Asia/Jerusalem",
    status: "confirmed",
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
  };
}

beforeEach(() => {
  transport.image.mockReset().mockResolvedValue({ ok: true });
  transport.mutate.mockReset();
  transport.read.mockReset().mockResolvedValue({ events: [] });
  transport.refresh.mockReset();
  transport.push.mockReset();
  transport.changeLocale.mockReset().mockResolvedValue(undefined);
  transport.setTheme.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Finance workspace", () => {
  it("requires a configured Stripe card before campaign funding", () => {
    const view = render(
      localized(
        <FinanceWorkspace
          defaultCurrency="USD"
          initialExpenses={[]}
          initialNextCursor={null}
          initialSummary={{
            totals: [],
            expenseCount: 0,
            recordedCount: 0,
            pendingCount: 0,
            voidCount: 0,
          }}
          initialWallet={{
            currency: "USD",
            availableMinor: 0,
            heldMinor: 0,
          }}
          initialPaymentSource={null}
          voiceEstimateAvailable={false}
          voiceEstimates={[]}
        />,
      ),
    );
    expect(screen.getByRole("button", { name: "Connect card" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Add funds" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.getByText(/Stripe is not configured for this deployment/u),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Finance" }).closest("header")
        ?.className,
    ).toContain("platform-admin-hero");
    expect(screen.getByText("Operations & billing")).toBeTruthy();

    view.rerender(
      localized(
        <FinanceWorkspace
          defaultCurrency="USD"
          initialExpenses={[]}
          initialNextCursor={null}
          initialSummary={{
            totals: [],
            expenseCount: 0,
            recordedCount: 0,
            pendingCount: 0,
            voidCount: 0,
          }}
          initialWallet={{
            currency: "USD",
            availableMinor: 0,
            heldMinor: 0,
          }}
          initialPaymentSource={{
            status: "active",
            brand: "visa",
            last4: "4242",
            expMonth: 12,
            expYear: 2032,
          }}
          realBillingEnabled
          voiceEstimateAvailable={false}
          voiceEstimates={[]}
        />,
      ),
    );
    expect(screen.getByText(/VISA · ending in 4242/u)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add funds" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("keeps each ledger currency separate from estimated voice usage", () => {
    render(
      localized(
        <FinanceWorkspace
          defaultCurrency="USD"
          initialExpenses={expenses}
          initialNextCursor={null}
          initialSummary={expenseSummary}
          voiceEstimateAvailable
          voiceEstimates={voiceEstimates}
        />,
      ),
    );

    const ledger = screen
      .getByRole("heading", {
        name: "Ledger by currency",
      })
      .closest("article");
    const voice = screen
      .getByRole("heading", {
        name: "Voice usage estimate",
      })
      .closest("article");
    if (!ledger || !voice) throw new Error("Finance summary cards missing");

    expect(ledger.textContent).toContain("USD");
    expect(ledger.textContent).toContain("$125.50");
    expect(ledger.textContent).toContain("ILS");
    expect(ledger.textContent).not.toContain("$3.50");
    expect(voice.textContent).toContain("$3.50");
    expect(voice.textContent).toContain("Separate from stored expenses");
    expect(voice.textContent).toContain("unpriced components");
  });

  it("creates a tenant expense through the canonical API without merging currencies", async () => {
    const created = expense("created", {
      title: "Design subscription",
      vendor: "Fictional Design",
      category: "Software",
      amount: "49.00",
      currency: "EUR",
    });
    transport.mutate.mockResolvedValueOnce({ expense: created });
    render(
      localized(
        <FinanceWorkspace
          defaultCurrency="USD"
          initialExpenses={expenses}
          initialNextCursor={null}
          initialSummary={expenseSummary}
          voiceEstimateAvailable
          voiceEstimates={voiceEstimates}
        />,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add expense" }));
    const dialog = screen.getByRole("dialog", { name: "Add expense" });
    fireEvent.change(within(dialog).getByLabelText("Expense title"), {
      target: { value: "Design subscription" },
    });
    fireEvent.change(within(dialog).getByLabelText("Vendor"), {
      target: { value: "Fictional Design" },
    });
    fireEvent.change(within(dialog).getByLabelText("Category"), {
      target: { value: "Software" },
    });
    fireEvent.change(within(dialog).getByLabelText("Amount"), {
      target: { value: "49.00" },
    });
    fireEvent.change(within(dialog).getByLabelText("Currency"), {
      target: { value: "eur" },
    });
    const form = within(dialog)
      .getByRole("button", { name: "Add expense" })
      .closest("form");
    if (!form) throw new Error("Expense form missing");
    fireEvent.submit(form);

    await waitFor(() => expect(transport.mutate).toHaveBeenCalledOnce());
    expect(transport.mutate).toHaveBeenCalledWith(
      "/api/finance/expenses",
      expect.objectContaining({
        title: "Design subscription",
        vendor: "Fictional Design",
        category: "Software",
        amount: "49.00",
        currency: "EUR",
        sourceKind: "manual",
      }),
      { method: "POST" },
    );
    expect(transport.refresh).toHaveBeenCalledOnce();
    expect(screen.getAllByText("Design subscription").length).toBeGreaterThan(
      0,
    );
  });
});

describe("Tasks workspace", () => {
  it("filters live rows and creates an assigned task through the tenant API", async () => {
    const initialTasks = [
      task("urgent", {
        title: "Resolve provider outage",
        priority: "urgent",
        status: "in_progress",
        contactId: "40000000-0000-4000-8000-000000000001",
        contactName: "Fictional Customer",
      }),
      task("routine", {
        title: "Review weekly notes",
        priority: "low",
        assigneeUserId: null,
      }),
    ];
    const created = task("created", {
      title: "Call enterprise customer",
      priority: "high",
    });
    transport.mutate.mockResolvedValueOnce({ task: created });
    render(
      localized(
        <TasksWorkspace
          initialTasks={initialTasks}
          members={members}
          tenantTimeZone="Asia/Jerusalem"
        />,
      ),
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks…" }), {
      target: { value: "provider" },
    });
    expect(
      screen.getAllByText("Resolve provider outage").length,
    ).toBeGreaterThan(0);
    expect(
      screen
        .getAllByRole("link", { name: "Fictional Customer" })[0]
        ?.getAttribute("href"),
    ).toBe("/contacts/40000000-0000-4000-8000-000000000001");
    expect(screen.queryByText("Review weekly notes")).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Priority" }), {
      target: { value: "low" },
    });
    expect(
      screen.getByText("No loaded tasks match these filters"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    const dialog = screen.getByRole("dialog", { name: "Add task" });
    fireEvent.change(within(dialog).getByLabelText("Task title"), {
      target: { value: "Call enterprise customer" },
    });
    fireEvent.change(within(dialog).getByLabelText("Priority"), {
      target: { value: "high" },
    });
    fireEvent.change(within(dialog).getByLabelText("Assign to"), {
      target: { value: "operator-agent" },
    });
    fireEvent.change(
      within(dialog).getByLabelText("Due date · Asia/Jerusalem"),
      { target: { value: "2026-09-16T10:30" } },
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create task" }),
    );

    await waitFor(() => expect(transport.mutate).toHaveBeenCalledOnce());
    expect(transport.mutate).toHaveBeenCalledWith(
      "/api/tasks",
      expect.objectContaining({
        title: "Call enterprise customer",
        priority: "high",
        assigneeUserId: "operator-agent",
        dueAt: "2026-09-16T07:30:00.000Z",
      }),
      { method: "POST" },
    );
    expect(transport.refresh).toHaveBeenCalledOnce();
  });
});

describe("Calendar workspace", () => {
  it("announces the UTC fallback for a legacy invalid tenant timezone", () => {
    const bounds = currentMonthBounds();
    render(
      localized(
        <CalendarWorkspace
          defaultTimezone="UTC"
          initialEvents={[]}
          initialFrom={bounds.from}
          initialTo={bounds.to}
          members={members}
          timezoneFallback
        />,
      ),
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Calendar times are shown in UTC",
    );
  });

  it("changes calendar views but keeps event editing read-only without crm:write", async () => {
    const bounds = currentMonthBounds();
    const event = calendarEvent("planning");
    transport.read.mockResolvedValue({ events: [event] });
    render(
      localized(
        <CalendarWorkspace
          defaultTimezone="Asia/Jerusalem"
          initialEvents={[event]}
          initialFrom={bounds.from}
          initialTo={bounds.to}
          members={members}
        />,
        "en",
        ["crm:read"],
      ),
    );

    expect(screen.queryByRole("button", { name: "Add event" })).toBeNull();
    const eventButton = screen
      .getAllByRole("button", { name: /Quarterly planning/u })
      .at(0);
    if (!eventButton) throw new Error("Calendar event button missing");
    fireEvent.click(eventButton);
    const dialog = screen.getByRole("dialog", { name: "Event details" });
    expect(
      within(dialog).getByLabelText<HTMLInputElement>("Event title").disabled,
    ).toBe(true);
    expect(
      within(dialog).queryByRole("button", { name: "Save changes" }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "Cancel event" }),
    ).toBeNull();
    const closeButton = within(dialog)
      .getAllByRole("button", { name: "Close" })
      .at(0);
    if (!closeButton) throw new Error("Calendar close button missing");
    fireEvent.click(closeButton);

    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    expect(
      screen.getByRole("button", { name: "Week" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await waitFor(() => expect(transport.read).toHaveBeenCalled());
    expect(String(transport.read.mock.calls.at(-1)?.[0])).toMatch(
      /^\/api\/calendar\/events\?/u,
    );
    expect(transport.mutate).not.toHaveBeenCalled();
  });

  it("keeps cancelled events read-only for users who can edit the calendar", () => {
    const bounds = currentMonthBounds();
    const event = calendarEvent("cancelled", { status: "cancelled" });
    render(
      localized(
        <CalendarWorkspace
          defaultTimezone="Asia/Jerusalem"
          initialEvents={[event]}
          initialFrom={bounds.from}
          initialTo={bounds.to}
          members={members}
        />,
      ),
    );

    const eventButton = screen
      .getAllByRole("button", { name: /Quarterly planning/u })
      .at(0);
    if (!eventButton) throw new Error("Cancelled calendar event missing");
    fireEvent.click(eventButton);
    const dialog = screen.getByRole("dialog", { name: "Event details" });
    expect(
      within(dialog).getByLabelText<HTMLInputElement>("Event title").disabled,
    ).toBe(true);
    expect(
      within(dialog).getByLabelText<HTMLSelectElement>("Status").value,
    ).toBe("cancelled");
    expect(
      within(dialog).queryByRole("button", { name: "Save changes" }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "Cancel event" }),
    ).toBeNull();
  });
});

describe("Email workspace", () => {
  it("opens and focuses an honest provider-specific setup guide in English and Hebrew", () => {
    const view = render(
      localized(<EmailWorkspace channels={[]} tenantName="Fictional tenant" />),
    );

    expect(screen.getAllByText("OAuth setup required").length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText(/encrypted token storage/u)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /Accounts/u })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByText("No email channels are configured yet."),
    ).toBeTruthy();
    const gmailSetup = screen.getByRole<HTMLButtonElement>("button", {
      name: "Connect Gmail",
    });
    expect(gmailSetup.disabled).toBe(false);
    fireEvent.click(gmailSetup);
    const googleGuide = screen.getByRole("region", {
      name: "Set up Gmail securely",
    });
    expect(googleGuide).toBe(document.activeElement);
    expect(
      screen.getByText("Create a Google Cloud OAuth web client"),
    ).toBeTruthy();
    expect(screen.getByText(/Selected provider: Gmail/u)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /Connection guide/u })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Accounts/u }));
    fireEvent.click(screen.getByRole("button", { name: "Connect Outlook" }));
    expect(
      screen.getByRole("region", { name: "Set up Outlook securely" }),
    ).toBe(document.activeElement);
    expect(
      screen.getByText("Create a Microsoft Entra app registration"),
    ).toBeTruthy();

    view.rerender(
      localized(
        <EmailWorkspace channels={[]} tenantName="סביבת בדיקה" />,
        "he",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /חשבונות/u }));
    expect(screen.getAllByText("נדרשת הגדרת OAuth").length).toBeGreaterThan(0);
    expect(screen.getByText(/אחסון מוצפן לטוקנים/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "חיבור Gmail" }));
    expect(screen.getByRole("region", { name: "הגדרה מאובטחת של Gmail" })).toBe(
      document.activeElement,
    );
    expect(screen.getByText("יצירת לקוח OAuth ב-Google Cloud")).toBeTruthy();
  });

  it("renders only persisted provider accounts as connected and can disconnect them", async () => {
    const channels: readonly EmailChannel[] = [
      {
        id: "email-channel",
        provider: "google-workspace",
        providerAccountId: "provider-account",
        displayAddress: "support@example.invalid",
        status: "active",
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ];
    render(
      localized(
        <EmailWorkspace channels={channels} tenantName="Fictional tenant" />,
      ),
    );

    expect(
      screen.getAllByText("support@example.invalid").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Connected").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Connect Gmail" })).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Connect Outlook" })
        .disabled,
    ).toBe(false);
    transport.mutate.mockResolvedValueOnce({ disconnected: true });
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Gmail" }));
    await waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        "/api/email/oauth/configuration?provider=google",
        {},
        { method: "DELETE" },
      ),
    );
    expect(screen.getByRole("button", { name: "Connect Gmail" })).toBeTruthy();
    expect(screen.queryByText("support@example.invalid")).toBeNull();
  });
});

describe("Profile workspace", () => {
  it("offers a personal avatar editor with a recoverable initials fallback", async () => {
    render(
      localized(
        <ProfileWorkspace
          account={{
            displayName: "Fictional Operator",
            email: "operator@example.invalid",
            isSuperuser: false,
          }}
          membershipCount={2}
          tenant={{ role: "admin", tenantName: "Fictional tenant" }}
        />,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(screen.getByText("Profile picture")).toBeTruthy();
    expect(
      screen.getByLabelText<HTMLInputElement>("Upload picture").accept,
    ).toBe("image/png,image/jpeg,image/webp");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(transport.image).toHaveBeenCalledWith("/api/account/avatar", {
        method: "DELETE",
      }),
    );
  });

  it("validates a password confirmation before calling the account API", () => {
    render(
      localized(
        <ProfileWorkspace
          account={{
            displayName: "Fictional Operator",
            email: "operator@example.invalid",
            isSuperuser: false,
          }}
          membershipCount={2}
          tenant={{ role: "admin", tenantName: "Fictional tenant" }}
        />,
      ),
    );

    const securityButton = screen.getByRole("button", { name: "Security" });
    fireEvent.click(securityButton);
    expect(securityButton.getAttribute("aria-pressed")).toBe("true");
    const panel = document.querySelector<HTMLElement>(
      "#profile-panel-security",
    );
    if (!panel) throw new Error("Profile security panel missing");
    fireEvent.change(within(panel).getByLabelText("Current password"), {
      target: { value: "fictional-current" },
    });
    fireEvent.change(within(panel).getByLabelText("New password"), {
      target: { value: "fictional-password-one" },
    });
    fireEvent.change(within(panel).getByLabelText("Confirm new password"), {
      target: { value: "fictional-password-two" },
    });
    fireEvent.click(
      within(panel).getByRole("button", { name: "Update password" }),
    );

    expect(within(panel).getByRole("alert").textContent).toContain(
      "The new passwords do not match.",
    );
    expect(transport.mutate).not.toHaveBeenCalled();
  });
});

describe("Users workspace", () => {
  it("filters members and requires confirmation before removing access", async () => {
    transport.mutate.mockResolvedValueOnce({});
    render(
      localized(
        <UsersWorkspace
          canManageOwners={false}
          currentUserId="operator-owner"
          initialRole="agent"
          invitations={[]}
          members={members}
        />,
      ),
    );

    expect(
      screen.getByRole<HTMLSelectElement>("combobox", {
        name: "Filter by role",
      }).value,
    ).toBe("agent");
    expect(
      screen.getByRole("heading", { name: "Users" }).closest("header")
        ?.className,
    ).toContain("platform-admin-hero");
    expect(screen.getByText("Total members")).toBeTruthy();
    expect(screen.getByText("Administrators")).toBeTruthy();
    expect(screen.queryByText("Ari Owner")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search users…" }), {
      target: { value: "Maya" },
    });
    expect(screen.getByText("Maya Agent")).toBeTruthy();
    expect(screen.queryByText("viewer@example.invalid")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search users…" }), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by role" }), {
      target: { value: "agent" },
    });
    expect(screen.getByText("Maya Agent")).toBeTruthy();
    expect(screen.queryByText("viewer@example.invalid")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove user: agent@example.invalid",
      }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Remove workspace access?",
    });
    expect(transport.mutate).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove access" }),
    );

    await waitFor(() => expect(transport.mutate).toHaveBeenCalledOnce());
    expect(transport.mutate).toHaveBeenCalledWith(
      "/api/settings/members/operator-agent",
      {},
      { method: "DELETE" },
    );
    expect(transport.refresh).toHaveBeenCalledOnce();
  });

  it("requires confirmation and removes a revoked pending invitation", async () => {
    transport.mutate.mockResolvedValueOnce({ ok: true });
    const invitation = {
      id: "40000000-0000-4000-8000-000000000001",
      email: "invited@example.invalid",
      role: "agent" as const,
      createdAt: "2026-09-10T08:00:00.000Z",
      expiresAt: "2026-09-17T08:00:00.000Z",
    };
    render(
      localized(
        <UsersWorkspace
          canManageOwners={false}
          currentUserId="operator-owner"
          invitations={[invitation]}
          members={members}
        />,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /Invitations/u }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Revoke invitation: invited@example.invalid",
      }),
    );
    expect(transport.mutate).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog", {
      name: "Revoke this invitation?",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Revoke invitation" }),
    );

    await waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        "/api/settings/invitations/40000000-0000-4000-8000-000000000001",
        {},
        { method: "DELETE" },
      ),
    );
    expect(screen.queryByText("invited@example.invalid")).toBeNull();
    expect(screen.getAllByText("Invitation revoked.").length).toBeGreaterThan(
      0,
    );
  });
});

describe("Roles workspace", () => {
  const roles: readonly RoleRecord[] = [
    {
      name: "owner",
      memberCount: 2,
      permissions: ["platform:read", "members:manage", "crm:read"],
    },
    {
      name: "agent",
      memberCount: 7,
      permissions: ["platform:read", "crm:read"],
    },
    {
      name: "viewer",
      memberCount: 3,
      permissions: ["platform:read"],
    },
  ];

  it("shows live member counts and a truthful permission matrix", () => {
    const view = render(
      localized(
        <RolesWorkspace
          allPermissions={["platform:read", "members:manage", "crm:read"]}
          roles={roles}
        />,
      ),
    );

    expect(
      screen.getByRole("link", { name: "7 members" }).getAttribute("href"),
    ).toBe("/users?role=agent");
    expect(
      screen
        .getByRole("heading", { name: "Roles & Permissions" })
        .closest("header")?.className,
    ).toContain("platform-admin-hero");
    expect(screen.getByText("Assigned members")).toBeTruthy();
    expect(screen.getByText("Broad-access roles")).toBeTruthy();
    expect(
      screen
        .getByRole("region", { name: "Scrollable roles table" })
        .getAttribute("tabindex"),
    ).toBe("0");
    expect(screen.getByText("Enforced built-in access model")).toBeTruthy();
    expect(screen.queryByText(/not available/u)).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Manage role assignments" })
        .getAttribute("href"),
    ).toBe("/users");
    fireEvent.click(screen.getByRole("button", { name: "Permission matrix" }));

    const matrix = screen.getByRole("table");
    expect(
      screen
        .getByRole("region", { name: "Scrollable permission matrix" })
        .getAttribute("tabindex"),
    ).toBe("0");
    expect(within(matrix).getByText("members:manage")).toBeTruthy();
    expect(
      within(matrix).getByLabelText("Owner: members:manage: Granted"),
    ).toBeTruthy();
    expect(
      within(matrix).getByText("Agent: members:manage: Denied"),
    ).toBeTruthy();

    view.rerender(
      localized(
        <RolesWorkspace
          allPermissions={["platform:read", "members:manage", "crm:read"]}
          roles={roles}
        />,
        "he",
      ),
    );
    expect(screen.getByText("נציג: members:manage: לא מורשה")).toBeTruthy();
    expect(transport.mutate).not.toHaveBeenCalled();
  });
});

describe("Hebrew tenant product labels", () => {
  it("renders the new operational areas with native, truthful labels", () => {
    const views = [
      [
        <FinanceWorkspace
          defaultCurrency="ILS"
          initialExpenses={[]}
          initialNextCursor={null}
          initialSummary={{
            totals: [],
            expenseCount: 0,
            recordedCount: 0,
            pendingCount: 0,
            voidCount: 0,
          }}
          voiceEstimateAvailable={false}
          voiceEstimates={[]}
        />,
        "כספים",
      ],
      [
        <TasksWorkspace
          initialTasks={[]}
          members={[]}
          tenantTimeZone="Asia/Jerusalem"
        />,
        "משימות",
      ],
      [
        <UsersWorkspace
          canManageOwners={false}
          currentUserId="operator-owner"
          invitations={[]}
          members={[]}
        />,
        "משתמשים",
      ],
      [<RolesWorkspace allPermissions={[]} roles={[]} />, "תפקידים והרשאות"],
    ] as const;

    for (const [component, label] of views) {
      const mounted = render(localized(component, "he"));
      expect(screen.getByText(label)).toBeTruthy();
      mounted.unmount();
    }

    const bounds = currentMonthBounds();
    const calendar = render(
      localized(
        <CalendarWorkspace
          defaultTimezone="Asia/Jerusalem"
          initialEvents={[]}
          initialFrom={bounds.from}
          initialTo={bounds.to}
          members={[]}
        />,
        "he",
      ),
    );
    expect(
      calendar.container.querySelector('[aria-label="לוח שנה"]'),
    ).toBeTruthy();
    calendar.unmount();

    const profile = render(
      localized(
        <ProfileWorkspace
          account={{
            displayName: "מפעיל בדיקה",
            email: "operator@example.invalid",
            isSuperuser: false,
          }}
          membershipCount={1}
          tenant={{ role: "agent", tenantName: "סביבת בדיקה" }}
        />,
        "he",
      ),
    );
    expect(screen.getByRole("group", { name: "פרופיל" })).toBeTruthy();
    profile.unmount();
  });
});
