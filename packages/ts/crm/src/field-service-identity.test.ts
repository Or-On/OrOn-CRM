import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  identifyTechnicianSession,
  signVisitAttendance,
} from "./field-service.js";

const sessionId = "10000000-0000-4000-8000-000000000001";
const visitId = "20000000-0000-4000-8000-000000000001";
const technicianId = "30000000-0000-4000-8000-000000000001";
const identityId = "40000000-0000-4000-8000-000000000001";
const signatureObjectId = "50000000-0000-4000-8000-000000000001";

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
  const sql = Object.assign(execute, {
    json: (value: unknown) => value,
  }) as unknown as postgres.TransactionSql;
  return { sql, statements, values };
}

const enabledFeature = [
  {
    available: true,
    enabled: true,
    shared_technician_login_enabled: true,
  },
];

describe("technician session identity repository boundary", () => {
  it("derives the session id and expiry exclusively from the locked database context", async () => {
    const fixture = transaction([
      enabledFeature,
      [
        {
          session_id: sessionId,
          absolute_expires_at: new Date("2026-09-16T12:00:00.000Z"),
        },
      ],
      [],
      [{ id: identityId }],
      [],
    ]);

    await expect(
      identifyTechnicianSession(fixture.sql, {
        visitId,
        technicianId,
        fullName: "Fictional Technician",
        employeeIdentifier: "TECH-01",
        requestId: "identity-test-request",
      }),
    ).resolves.toBe(identityId);

    expect(fixture.statements[1]).toContain(
      "service.lock_current_technician_session_context()",
    );
    expect(fixture.statements.join("\n")).not.toContain(
      "FROM platform.auth_sessions",
    );
    expect(fixture.statements[3]).toContain(
      "INSERT INTO service.technician_session_identities",
    );
    expect(fixture.values[2]).toContain(sessionId);
    expect(fixture.values[3]).toContain(sessionId);
    expect(fixture.values[3]).toContainEqual(
      new Date("2026-09-16T12:00:00.000Z"),
    );
  });

  it("performs no identity query or write when the database session context is invalid", async () => {
    const fixture = transaction([enabledFeature, []]);

    await expect(
      identifyTechnicianSession(fixture.sql, {
        visitId,
        technicianId,
        fullName: "Fictional Technician",
      }),
    ).rejects.toThrow("authenticated session is no longer valid");
    expect(fixture.statements).toHaveLength(2);
    expect(fixture.statements[1]).toContain(
      "service.lock_current_technician_session_context()",
    );
  });

  it("binds attendance lookup to the same validated database session", async () => {
    const fixture = transaction([
      enabledFeature,
      [{ session_id: sessionId }],
      [],
    ]);

    await expect(
      signVisitAttendance(fixture.sql, {
        visitId,
        signatureObjectId,
        kind: "arrival",
      }),
    ).rejects.toThrow("Identify the assigned technician before signing");
    expect(fixture.statements[1]).toContain(
      "service.lock_current_technician_session_context()",
    );
    expect(fixture.statements[2]).toContain(
      "identity.auth_session_id = ?::uuid",
    );
    expect(fixture.values[2]).toContain(sessionId);
  });
});
