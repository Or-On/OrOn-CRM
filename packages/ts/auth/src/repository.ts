import postgres, { type Sql } from "postgres";

import { normalizeRole } from "./authorization.js";
import type {
  AuthRepository,
  AuthSession,
  CreateSessionInput,
  InvitationRecord,
  LoginRecord,
  Membership,
} from "./types.js";

interface LoginRow {
  user_id: string;
  email: string;
  display_name: string | null;
  status: string;
  is_superuser: boolean;
  password_hash: string | null;
  failed_attempts: number | null;
  locked_until: Date | null;
}

interface MembershipRow {
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  role: string;
}

interface SessionRow extends MembershipRow {
  session_id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  is_superuser: boolean;
  csrf_token_hash: Uint8Array;
  absolute_expires_at: Date;
  rotation_count: number;
}

interface InvitationRow {
  invitation_id: string;
  email: string;
  tenant_name: string;
  role: string;
  expires_at: Date;
  existing_account: boolean;
}

export function createAuthRepository(databaseUrl: string): AuthRepository {
  if (!/^postgres(?:ql)?:\/\//u.test(databaseUrl)) {
    throw new TypeError("databaseUrl must use PostgreSQL");
  }
  const sql: Sql = postgres(databaseUrl, {
    connect_timeout: 3,
    idle_timeout: 10,
    max: 4,
    prepare: false,
  });

  async function membershipsForUser(
    userId: string,
  ): Promise<readonly Membership[]> {
    const rows = await sql<MembershipRow[]>`
      SELECT * FROM platform.auth_memberships_for_user(${userId}::uuid)
    `;
    return rows.flatMap((row) => {
      const role = normalizeRole(row.role);
      return role === undefined
        ? []
        : [
            {
              tenantId: row.tenant_id,
              tenantName: row.tenant_name,
              tenantSlug: row.tenant_slug,
              role,
            },
          ];
    });
  }

  return {
    async lookupLogin(email: string): Promise<LoginRecord | undefined> {
      const rows = await sql<LoginRow[]>`
        SELECT * FROM platform.auth_login_record(${email}::citext)
      `;
      const row = rows[0];
      return row === undefined
        ? undefined
        : {
            userId: row.user_id,
            email: row.email,
            displayName: row.display_name ?? undefined,
            status: row.status,
            isSuperuser: row.is_superuser,
            passwordHash: row.password_hash ?? undefined,
            failedAttempts: row.failed_attempts ?? 0,
            lockedUntil: row.locked_until ?? undefined,
          };
    },
    membershipsForUser,
    async recordLoginFailure(userId: string): Promise<void> {
      await sql`SELECT platform.auth_record_login_failure(${userId}::uuid)`;
    },
    async recordLoginSuccess(userId: string): Promise<void> {
      await sql`SELECT platform.auth_record_login_success(${userId}::uuid)`;
    },
    async createSession(input: CreateSessionInput): Promise<string> {
      const rows = await sql<{ id: string }[]>`
        SELECT platform.auth_create_session(
          ${input.userId}::uuid, ${input.tenantId}::uuid,
          ${input.tokenHash}::bytea, ${input.csrfTokenHash}::bytea,
          ${input.idleTimeoutSeconds}::integer, ${input.idleExpiresAt}::timestamptz,
          ${input.absoluteExpiresAt}::timestamptz, ${input.userAgentHash ?? null}::bytea,
          ${input.ipHash ?? null}::bytea, ${input.requestId}::text
        ) AS id
      `;
      const id = rows[0]?.id;
      if (id === undefined)
        throw new Error("session creation returned no identifier");
      return id;
    },
    async resolveSession(
      tokenHash: Uint8Array,
    ): Promise<AuthSession | undefined> {
      const rows = await sql<SessionRow[]>`
        SELECT * FROM platform.auth_resolve_session(${tokenHash}::bytea)
      `;
      const row = rows[0];
      if (row === undefined) return undefined;
      const role = normalizeRole(row.role);
      if (role === undefined) return undefined;
      const memberships = await membershipsForUser(row.user_id);
      return {
        sessionId: row.session_id,
        userId: row.user_id,
        email: row.email,
        displayName: row.display_name ?? undefined,
        isSuperuser: row.is_superuser,
        tenant: {
          tenantId: row.tenant_id,
          tenantName: row.tenant_name,
          tenantSlug: row.tenant_slug,
          role,
        },
        memberships,
        csrfTokenHash: row.csrf_token_hash,
        absoluteExpiresAt: row.absolute_expires_at,
        rotationCount: row.rotation_count,
      };
    },
    async invitationRecord(tokenHash): Promise<InvitationRecord | undefined> {
      const rows = await sql<InvitationRow[]>`
        SELECT * FROM platform.auth_invitation_record(${tokenHash}::text)
      `;
      const row = rows[0];
      if (row === undefined) return undefined;
      const role = normalizeRole(row.role);
      if (role === undefined) return undefined;
      return {
        invitationId: row.invitation_id,
        email: row.email,
        tenantName: row.tenant_name,
        role,
        expiresAt: row.expires_at,
        existingAccount: row.existing_account,
      };
    },
    async acceptInvitation(input): Promise<boolean> {
      const rows = await sql<{ created: boolean }[]>`
        SELECT platform.auth_accept_invitation(
          ${input.tokenHash}::text, ${input.passwordHash}::text,
          ${input.displayName}::text, ${input.requestId}::text
        ) AS created
      `;
      return rows[0]?.created === true;
    },
    async switchTenant(input): Promise<boolean> {
      const rows = await sql<{ switched: boolean }[]>`
        SELECT platform.auth_switch_session_tenant(
          ${input.currentHash}::bytea, ${input.tenantId}::uuid,
          ${input.newHash}::bytea, ${input.newCsrfHash}::bytea,
          ${input.requestId}::text
        ) AS switched
      `;
      return rows[0]?.switched === true;
    },
    async revokeSession(tokenHash, reason, requestId): Promise<boolean> {
      const rows = await sql<{ revoked: boolean }[]>`
        SELECT platform.auth_revoke_session(
          ${tokenHash}::bytea, ${reason}::text, ${requestId}::text
        ) AS revoked
      `;
      return rows[0]?.revoked === true;
    },
    async close(): Promise<void> {
      await sql.end({ timeout: 2 });
    },
  };
}
