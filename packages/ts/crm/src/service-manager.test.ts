import { beforeEach, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import type * as TenantFeaturesModule from "./tenant-features.js";
import {
  listServiceInquiries,
  resolveServiceInquiry,
  serviceManagerMetrics,
} from "./service-manager.js";
import {
  tenantFeatureKeys,
  validateTenantFeatureConfiguration,
  usesServiceManagerExperience,
  type TenantFeatureSnapshot,
} from "./tenant-features.js";

const state = vi.hoisted(() => ({ close: vi.fn(), transition: vi.fn() }));
vi.mock("./tickets.js", () => ({ closeTicket: state.close }));
vi.mock("./field-service.js", () => ({
  transitionServiceCase: state.transition,
}));
vi.mock("./tenant-features.js", async (importOriginal) => ({
  ...(await importOriginal<typeof TenantFeaturesModule>()),
  requireTenantFeature: vi.fn(),
}));

const ticketId = "10000000-0000-4000-8000-000000000001";
const caseId = "20000000-0000-4000-8000-000000000001";
function database(...results: unknown[]) {
  const statements: string[] = [];
  const query = vi.fn((parts: TemplateStringsArray) => {
    statements.push(parts.join("?"));
    return Promise.resolve(results.shift() ?? []);
  });
  return {
    sql: query as unknown as postgres.TransactionSql,
    query,
    statements,
  };
}
beforeEach(() => {
  state.close.mockReset();
  state.transition.mockReset();
});

describe("service-manager presentation", () => {
  it("is opt-in and preserves capabilities", () => {
    const snapshot = Object.fromEntries(
      tenantFeatureKeys.map((key) => [
        key,
        { key, effective: true, configuration: {} },
      ]),
    ) as unknown as TenantFeatureSnapshot;
    expect(usesServiceManagerExperience(snapshot)).toBe(false);
    const configured = {
      ...snapshot,
      field_service: {
        ...snapshot.field_service,
        configuration: { experience: "service_manager" },
      },
    };
    expect(usesServiceManagerExperience(configured)).toBe(true);
    expect(configured.voice.effective).toBe(true);
    expect(configured.whatsapp.effective).toBe(true);
    expect(
      usesServiceManagerExperience({
        ...configured,
        tickets: { ...configured.tickets, effective: false },
      }),
    ).toBe(false);
  });
  it("rejects unsupported presentation options", () => {
    expect(
      validateTenantFeatureConfiguration("field_service", {
        experience: "service_manager",
      }),
    ).toEqual({ experience: "service_manager" });
    expect(() =>
      validateTenantFeatureConfiguration("field_service", {
        experience: "other",
      }),
    ).toThrow();
    expect(() =>
      validateTenantFeatureConfiguration("field_service", { experience: null }),
    ).toThrow();
    expect(() =>
      validateTenantFeatureConfiguration("voice", {
        experience: "service_manager",
      }),
    ).toThrow();
  });
});
describe("service inquiry resolution", () => {
  const input = {
    ticketId,
    method: "telephone" as const,
    confirmation: "customer" as const,
    summary: "Customer confirmed the fault is resolved",
  };
  it("records the method in the audited closure without inferring it from the source channel", async () => {
    const db = database([{ status: "open", service_case_id: null }]);
    await resolveServiceInquiry(db.sql, ticketId, input);
    expect(state.close).toHaveBeenCalledWith(
      db.sql,
      ticketId,
      expect.objectContaining({
        serviceResolutionMethod: "telephone",
        resolutionConfirmedBy: "customer",
        closureReason: "resolved",
      }),
    );
  });
  it("requires completed technician work", async () => {
    const db = database(
      [{ status: "open", service_case_id: caseId }],
      [{ status: "in_progress" }],
    );
    await expect(
      resolveServiceInquiry(db.sql, ticketId, {
        ...input,
        method: "technician",
      }),
    ).rejects.toThrow("Complete the technician work");
    expect(state.close).not.toHaveBeenCalled();
    expect(state.transition).not.toHaveBeenCalled();
  });
  it("closes a completed case together with its inquiry", async () => {
    const db = database(
      [{ status: "open", service_case_id: caseId }],
      [{ status: "completed" }],
    );
    await resolveServiceInquiry(db.sql, ticketId, {
      ...input,
      method: "technician",
      confirmation: "authoritative_evidence",
    });
    expect(state.transition).toHaveBeenCalledWith(
      db.sql,
      { userId: ticketId },
      caseId,
      "closed",
      input.summary,
    );
    expect(state.close).toHaveBeenCalledWith(
      db.sql,
      ticketId,
      expect.objectContaining({ serviceResolutionMethod: "technician" }),
    );
  });
  it("does not hide outstanding visits through telephone closure", async () => {
    const db = database(
      [{ status: "open", service_case_id: caseId }],
      [{ status: "awaiting_scheduling" }],
      [{ active: true }],
    );
    await expect(
      resolveServiceInquiry(db.sql, ticketId, input),
    ).rejects.toThrow("Cancel pending field work");
    expect(state.close).not.toHaveBeenCalled();
  });
  it("cancels unnecessary unscheduled field work through the existing transition", async () => {
    const db = database(
      [{ status: "open", service_case_id: caseId }],
      [{ status: "awaiting_scheduling" }],
      [{ active: false }],
    );
    await resolveServiceInquiry(db.sql, ticketId, input);
    expect(state.transition).toHaveBeenCalledWith(
      db.sql,
      { userId: ticketId },
      caseId,
      "cancelled",
      input.summary,
    );
    expect(state.close).toHaveBeenCalledOnce();
  });
  it("rejects unconfirmed or duplicate closures before any mutation", async () => {
    const db = database([{ status: "closed", service_case_id: null }]);
    await expect(
      resolveServiceInquiry(db.sql, ticketId, input),
    ).rejects.toThrow("already closed");
    expect(state.close).not.toHaveBeenCalled();
  });
  it("limits the summary to the existing case history limit before mutating", async () => {
    const db = database();
    await expect(
      resolveServiceInquiry(db.sql, ticketId, {
        ...input,
        summary: "x".repeat(1001),
      }),
    ).rejects.toThrow("Enter a resolution summary");
    expect(db.query).not.toHaveBeenCalled();
    expect(state.transition).not.toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();
  });
});
describe("service register boundaries", () => {
  it("rejects invalid calendar dates and incomplete cursors", async () => {
    const db = database();
    await expect(
      listServiceInquiries(db.sql, {
        timezone: "Asia/Jerusalem",
        since: "2026-02-30",
      }),
    ).rejects.toThrow("Invalid inquiry date");
    await expect(
      listServiceInquiries(db.sql, {
        timezone: "Asia/Jerusalem",
        beforeOpenedAt: "2026-09-01",
      }),
    ).rejects.toThrow("cursor");
    expect(db.query).not.toHaveBeenCalled();
  });
  it("paginates by opening date and keeps historical closures honest", async () => {
    const rows = Array.from({ length: 26 }, (_, index) => ({
      id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      reference: `IN-${String(index)}`,
      customer: "Example",
      location: null,
      subject: "Fault",
      fault_description: null,
      opened_at: new Date("2026-09-20T10:00:00Z"),
      cursor_opened_at: "2026-09-20T10:00:00.000123Z",
      closed_at: new Date("2026-09-21T10:00:00Z"),
      status: "closed",
      case_id: null,
      case_status: null,
      technician: null,
      appointment_at: null,
      appointment_end: null,
    }));
    const db = database(rows);
    const page = await listServiceInquiries(db.sql, {
      timezone: "Asia/Jerusalem",
    });
    expect(page.inquiries).toHaveLength(25);
    expect(page.inquiries[0]?.status).toBe("closed");
    expect(page.nextCursor?.id).toBe(rows[24]?.id);
    expect(page.nextCursor?.openedAt).toBe("2026-09-20T10:00:00.000123Z");
    expect(db.statements[0]).toContain("ORDER BY opened_at DESC,id DESC");
  });
  it("counts inbound calls separately from browser and outgoing sessions", async () => {
    const result = {
      incomingCalls: 4,
      incomingMessages: 12,
      opened: 3,
      closed: 2,
      since: "2026-09-01",
      until: "2026-09-28",
    };
    const db = database([result]);
    expect(
      await serviceManagerMetrics(db.sql, "Asia/Jerusalem", "month"),
    ).toEqual(result);
    expect(db.statements[0]).toContain("direction='inbound'");
    expect(db.statements[0]).toContain("closed_at>=period.start");
  });
});
