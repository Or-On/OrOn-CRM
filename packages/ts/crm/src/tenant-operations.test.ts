import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  createCalendarEvent,
  listCalendarEventPage,
  updateCalendarEvent,
} from "./calendar.js";
import { createExpense, listExpensePage } from "./expenses.js";
import {
  getCurrentTenantLogo,
  getCurrentUserAvatar,
  revokeTenantInvitation,
  setCurrentTenantLogo,
  setCurrentUserAvatar,
  updateTenantSettings,
} from "./management.js";
import { createTask, listTasks } from "./tasks.js";
import {
  createTenantWithDefaults,
  deleteTenantForAdministrator,
} from "./tenants.js";

const actorId = "10000000-0000-4000-8000-000000000001";
const recordId = "20000000-0000-4000-8000-000000000001";
const memberId = "30000000-0000-4000-8000-000000000001";

function transaction(results: readonly unknown[][]) {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const execute = vi.fn(
    (parts: TemplateStringsArray, ...parameters: unknown[]) => {
      statements.push(parts.join("?"));
      values.push(parameters);
      return Promise.resolve(results[statements.length - 1] ?? []);
    },
  );
  return {
    sql: execute as unknown as postgres.TransactionSql,
    statements,
    values,
  };
}

function expenseRow(id: string, incurredAt: string) {
  return {
    id,
    created_by_user_id: actorId,
    title: "Fictional hosting invoice",
    vendor: "Example Vendor",
    category: "Infrastructure",
    amount: "42.125000",
    currency: "USD",
    status: "recorded" as const,
    source_kind: "manual" as const,
    source_reference: null,
    notes: null,
    incurred_at: new Date(incurredAt),
    created_at: new Date("2026-09-10T08:00:00.000Z"),
    updated_at: new Date("2026-09-10T08:00:00.000Z"),
  };
}

function calendarRow(
  id: string,
  startsAt = "2026-09-10T12:00:00.000Z",
  endsAt = "2026-09-10T13:00:00.000Z",
) {
  return {
    id,
    created_by_user_id: actorId,
    organizer_user_id: memberId,
    title: "Fictional planning session",
    description: null,
    location: null,
    starts_at: new Date(startsAt),
    ends_at: new Date(endsAt),
    all_day: false,
    timezone: "UTC",
    status: "confirmed" as const,
    created_at: new Date("2026-09-10T08:00:00.000Z"),
    updated_at: new Date("2026-09-10T08:00:00.000Z"),
  };
}

describe("tenant finance repository", () => {
  it("keeps numeric amounts as strings and exposes a stable next cursor", async () => {
    const fixture = transaction([
      [
        expenseRow(
          "20000000-0000-4000-8000-000000000003",
          "2026-09-10T12:00:00.000Z",
        ),
        expenseRow(
          "20000000-0000-4000-8000-000000000002",
          "2026-09-10T11:00:00.000Z",
        ),
        expenseRow(recordId, "2026-09-10T10:00:00.000Z"),
      ],
    ]);
    const page = await listExpensePage(fixture.sql, { limit: 2 });
    expect(page.expenses).toHaveLength(2);
    expect(page.expenses[0]?.amount).toBe("42.125000");
    expect(page.nextCursor).toEqual({
      incurredAt: "2026-09-10T11:00:00.000Z",
      id: "20000000-0000-4000-8000-000000000002",
    });
    expect(fixture.statements[0]).toContain("(incurred_at, id) <");
    expect(fixture.statements[0]).toContain(
      "ORDER BY incurred_at DESC, id DESC",
    );
  });

  it("rejects lossy or exponent-form amount inputs before querying PostgreSQL", async () => {
    const fixture = transaction([]);
    await expect(
      createExpense(fixture.sql, actorId, {
        title: "Fictional compute",
        category: "Infrastructure",
        amount: "1e3",
        currency: "USD",
        incurredAt: "2026-09-10T12:00:00Z",
      }),
    ).rejects.toThrow("positive decimal");
    expect(fixture.statements).toHaveLength(0);
  });
});

describe("tenant task repository", () => {
  it("preserves the tenant-scoped customer link for generated follow-up tasks", async () => {
    const fixture = transaction([
      [
        {
          id: recordId,
          created_by_user_id: actorId,
          assignee_user_id: memberId,
          contact_id: "40000000-0000-4000-8000-000000000001",
          contact_name: "Fictional Customer",
          title: "Follow up on support request",
          description: null,
          status: "todo",
          priority: "high",
          due_at: new Date("2026-09-16T07:00:00.000Z"),
          completed_at: null,
          created_at: new Date("2026-09-15T08:00:00.000Z"),
          updated_at: new Date("2026-09-15T08:00:00.000Z"),
        },
      ],
    ]);

    const tasks = await listTasks(fixture.sql);

    expect(tasks[0]).toMatchObject({
      contactId: "40000000-0000-4000-8000-000000000001",
      contactName: "Fictional Customer",
    });
    expect(fixture.statements[0]).toContain("LEFT JOIN crm.contacts");
    expect(fixture.statements[0]).toContain(
      "contact.tenant_id=platform.current_tenant_id()",
    );
  });

  it("guards task assignment with current-tenant membership in the write query", async () => {
    const fixture = transaction([[]]);
    await expect(
      createTask(fixture.sql, actorId, {
        title: "Review fictional account",
        assigneeUserId: memberId,
      }),
    ).rejects.toThrow("member of the current tenant");
    expect(fixture.statements[0]).toContain(
      "FROM platform.current_tenant_team()",
    );
  });
});

describe("tenant calendar repository", () => {
  it("exposes a stable cursor instead of silently truncating a full page", async () => {
    const nextId = "20000000-0000-4000-8000-000000000003";
    const fixture = transaction([
      [
        calendarRow(recordId),
        calendarRow(nextId, "2026-09-10T14:00:00Z", "2026-09-10T15:00:00Z"),
      ],
    ]);
    const page = await listCalendarEventPage(fixture.sql, { limit: 1 });
    expect(page.events).toHaveLength(1);
    expect(page.nextCursor).toEqual({
      startsAt: "2026-09-10T12:00:00.000Z",
      endsAt: "2026-09-10T13:00:00.000Z",
      id: recordId,
    });
    expect(fixture.statements[0]).toContain("(starts_at, ends_at, id) >");
  });

  it("rejects a reversed event range before any database write", async () => {
    const fixture = transaction([]);
    await expect(
      createCalendarEvent(fixture.sql, actorId, {
        title: "Fictional planning session",
        startsAt: "2026-09-10T13:00:00Z",
        endsAt: "2026-09-10T12:00:00Z",
        timezone: "UTC",
      }),
    ).rejects.toThrow("end must be after");
    expect(fixture.statements).toHaveLength(0);
  });

  it("rejects unsupported IANA time-zone names before persistence", async () => {
    const fixture = transaction([]);
    await expect(
      createCalendarEvent(fixture.sql, actorId, {
        title: "Fictional planning session",
        startsAt: "2026-09-10T12:00:00Z",
        endsAt: "2026-09-10T13:00:00Z",
        timezone: "Mars/Olympus_Mons",
      }),
    ).rejects.toThrow("valid IANA time-zone name");
    expect(fixture.statements).toHaveLength(0);
  });

  it("guards organizers with current-tenant membership in the write query", async () => {
    const fixture = transaction([[]]);
    await expect(
      createCalendarEvent(fixture.sql, actorId, {
        title: "Fictional planning session",
        startsAt: "2026-09-10T12:00:00Z",
        endsAt: "2026-09-10T13:00:00Z",
        timezone: "Asia/Jerusalem",
        organizerUserId: memberId,
      }),
    ).rejects.toThrow("member of the current tenant");
    expect(fixture.statements[0]).toContain(
      "FROM platform.current_tenant_team()",
    );
  });

  it("validates a partial time update against the stored counterpart", async () => {
    const fixture = transaction([[calendarRow(recordId)]]);
    await expect(
      updateCalendarEvent(fixture.sql, recordId, {
        startsAt: "2026-09-10T14:00:00Z",
      }),
    ).rejects.toThrow("end must be after");
    expect(fixture.statements).toHaveLength(1);
    expect(fixture.statements[0]).toContain("FOR UPDATE");
  });
});

describe("tenant settings repository", () => {
  it("reads and writes identity images through scoped database functions", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const updatedAt = new Date("2026-09-11T15:00:00.000Z");
    const fixture = transaction([
      [{ data: bytes, content_type: "image/png", updated_at: updatedAt }],
      [{ data: bytes, content_type: "image/png", updated_at: updatedAt }],
      [],
      [],
    ]);

    await expect(getCurrentUserAvatar(fixture.sql)).resolves.toEqual({
      data: bytes,
      contentType: "image/png",
      updatedAt: updatedAt.toISOString(),
    });
    await expect(getCurrentTenantLogo(fixture.sql)).resolves.toEqual({
      data: bytes,
      contentType: "image/png",
      updatedAt: updatedAt.toISOString(),
    });
    await setCurrentUserAvatar(
      fixture.sql,
      { data: bytes, contentType: "image/png" },
      "avatar-request",
    );
    await setCurrentTenantLogo(fixture.sql, undefined, "logo-request");

    expect(fixture.statements[0]).toContain("platform.current_user_avatar");
    expect(fixture.statements[1]).toContain("platform.current_tenant_logo");
    expect(fixture.statements[2]).toContain("platform.set_current_user_avatar");
    expect(fixture.values[2]).toEqual([bytes, "image/png", "avatar-request"]);
    expect(fixture.statements[3]).toContain("platform.set_current_tenant_logo");
    expect(fixture.values[3]).toEqual([null, null, "logo-request"]);
  });

  it("revokes invitations through the tenant-scoped database function", async () => {
    const fixture = transaction([[{ revoked: true }]]);

    await expect(
      revokeTenantInvitation(fixture.sql, recordId, "revoke-request"),
    ).resolves.toBe(true);
    expect(fixture.statements[0]).toContain(
      "platform.revoke_current_tenant_invitation",
    );
    expect(fixture.values[0]).toEqual([recordId, "revoke-request"]);
  });

  it("rejects unsupported IANA time-zone names before persistence", async () => {
    const fixture = transaction([]);

    await expect(
      updateTenantSettings(fixture.sql, {
        displayName: "Fictional workspace",
        defaultCurrency: "USD",
        locale: "en",
        timezone: "Mars/Olympus_Mons",
      }),
    ).rejects.toThrow("valid IANA time-zone name");
    expect(fixture.statements).toHaveLength(0);
  });
});

describe("platform tenant administration repository", () => {
  it("rejects unsupported IANA time-zone names before tenant creation", async () => {
    const fixture = transaction([]);

    await expect(
      createTenantWithDefaults(fixture.sql, {
        name: "Fictional workspace",
        slug: "fictional-workspace",
        currency: "USD",
        locale: "en",
        timezone: "Mars/Olympus_Mons",
      }),
    ).rejects.toThrow("valid currency and timezone");
    expect(fixture.statements).toHaveLength(0);
  });

  it("deletes only through the guarded database function", async () => {
    const fixture = transaction([[{ deleted: true }]]);

    await expect(
      deleteTenantForAdministrator(
        fixture.sql,
        recordId,
        "delete-tenant-request",
      ),
    ).resolves.toBe(true);
    expect(fixture.statements[0]).toContain(
      "platform.delete_tenant_for_administrator",
    );
    expect(fixture.values[0]).toEqual([recordId, "delete-tenant-request"]);
  });

  it("rejects invalid tenant identifiers before querying PostgreSQL", async () => {
    const fixture = transaction([]);

    await expect(
      deleteTenantForAdministrator(
        fixture.sql,
        "not-a-tenant",
        "delete-tenant-request",
      ),
    ).rejects.toThrow("valid tenant identifier");
    expect(fixture.statements).toHaveLength(0);
  });
});
