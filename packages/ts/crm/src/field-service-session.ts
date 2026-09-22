import { randomUUID } from "node:crypto";

import type postgres from "postgres";

import type { TechnicianSummary } from "./field-service.js";
import { requireFieldService } from "./tenant-features.js";

/**
 * How the current technician session identifies its physical technician:
 * - `individual`: the account is linked to its own technician profile;
 * - `shared`: one account serves many technicians, each session names one;
 * - `unlinked`: a technician account with no profile and shared login off;
 * - `not_technician`: owner, admin, agent and viewer sessions.
 */
export type TechnicianSessionMode =
  "individual" | "shared" | "unlinked" | "not_technician";

/**
 * The physical technician of a session. The employee identifier confirms the
 * binding on a shared device, so it is never returned to the device.
 */
export interface SessionTechnician {
  readonly id: string;
  readonly fullName: string;
  readonly identityVerification: TechnicianSummary["identityVerification"];
}

export interface TechnicianSessionContext {
  readonly mode: TechnicianSessionMode;
  /** The physical technician of this exact authenticated browser session. */
  readonly technician: SessionTechnician | null;
}

export async function getTechnicianSessionContext(
  sql: postgres.TransactionSql,
): Promise<TechnicianSessionContext> {
  const rows = await sql<
    {
      mode: TechnicianSessionMode;
      id: string | null;
      full_name: string | null;
      identity_verification: TechnicianSummary["identityVerification"] | null;
    }[]
  >`
    WITH current AS (
      SELECT service.current_technician_session_mode() AS mode,
             service.current_session_technician_id() AS technician_id
    )
    SELECT current.mode, technician.id, technician.full_name,
           technician.identity_verification
    FROM current
    LEFT JOIN service.technicians technician
      ON technician.id = current.technician_id
     AND technician.tenant_id = platform.current_tenant_id()
  `;
  const row = rows[0];
  return {
    mode: row?.mode ?? "not_technician",
    technician:
      row?.id === null ||
      row?.id === undefined ||
      row.full_name === null ||
      row.identity_verification === null
        ? null
        : {
            id: row.id,
            fullName: row.full_name,
            identityVerification: row.identity_verification,
          },
  };
}

/**
 * Names the physical technician of the current authenticated session from the
 * details that technician typed on the shared device. PostgreSQL reuses the
 * active profile holding that employee identifier, or records a self-declared
 * one, and binds it to the transaction's own session: the caller supplies no
 * session, tenant, user or technician identifier, and sibling sessions of the
 * same account are unaffected.
 */
export async function bindTechnicianSession(
  sql: postgres.TransactionSql,
  input: {
    readonly fullName: string;
    readonly employeeIdentifier: string;
    readonly phone?: string | null;
    readonly requestId?: string;
  },
): Promise<SessionTechnician> {
  await requireFieldService(sql);
  const phone = input.phone?.trim() ?? "";
  const rows = await sql<
    {
      binding: {
        technicianId: string;
        fullName: string;
        identityVerification: TechnicianSummary["identityVerification"];
        profileCreated: boolean;
      };
    }[]
  >`
    SELECT service.bind_current_technician_session(
      ${input.fullName}, ${input.employeeIdentifier},
      ${phone === "" ? null : phone}, ${input.requestId ?? randomUUID()}
    ) AS binding
  `;
  const binding = rows[0]?.binding;
  if (binding === undefined)
    throw new Error("Technician session binding returned no result");
  return {
    id: binding.technicianId,
    fullName: binding.fullName,
    identityVerification: binding.identityVerification,
  };
}

/** Ends this session's technician identity, e.g. to hand a device over. */
export async function releaseTechnicianSession(
  sql: postgres.TransactionSql,
  requestId: string = randomUUID(),
): Promise<boolean> {
  const rows = await sql<{ released: boolean }[]>`
    SELECT service.release_current_technician_session(${requestId}) AS released
  `;
  return rows[0]?.released === true;
}
