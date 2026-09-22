import type { ApplicationScope, Role } from "./authorization.js";

export interface Membership {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantSlug: string;
  readonly role: Role;
}

export interface AuthSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | undefined;
  readonly isSuperuser: boolean;
  readonly tenant: Membership;
  readonly memberships: readonly Membership[];
  readonly csrfTokenHash: Uint8Array;
  readonly absoluteExpiresAt: Date;
  readonly rotationCount: number;
}

export interface PublicSession {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName?: string;
    readonly isSuperuser: boolean;
  };
  readonly tenant: Membership;
  readonly memberships: readonly Membership[];
  readonly expiresAt: string;
  /** Permissions usable in this session's application, not the raw role set. */
  readonly permissions: readonly string[];
  readonly applicationScope: ApplicationScope;
}

export interface IssuedSession {
  readonly session: AuthSession;
  readonly sessionToken: string;
  readonly csrfToken: string;
}

export interface LoginRecord {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | undefined;
  readonly status: string;
  readonly isSuperuser: boolean;
  readonly passwordHash: string | undefined;
  readonly failedAttempts: number;
  readonly lockedUntil: Date | undefined;
}

export interface InvitationRecord {
  readonly invitationId: string;
  readonly email: string;
  readonly tenantName: string;
  readonly role: Role;
  readonly expiresAt: Date;
  readonly existingAccount: boolean;
}

export interface CreateSessionInput {
  readonly userId: string;
  readonly tenantId: string;
  readonly tokenHash: Uint8Array;
  readonly csrfTokenHash: Uint8Array;
  readonly idleTimeoutSeconds: number;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly userAgentHash: Uint8Array | undefined;
  readonly ipHash: Uint8Array | undefined;
  readonly requestId: string;
}

export interface AuthRepository {
  lookupLogin(email: string): Promise<LoginRecord | undefined>;
  membershipsForUser(userId: string): Promise<readonly Membership[]>;
  recordLoginFailure(userId: string): Promise<void>;
  recordLoginSuccess(userId: string): Promise<void>;
  createSession(input: CreateSessionInput): Promise<string>;
  resolveSession(tokenHash: Uint8Array): Promise<AuthSession | undefined>;
  invitationRecord(tokenHash: string): Promise<InvitationRecord | undefined>;
  acceptInvitation(input: {
    readonly tokenHash: string;
    readonly passwordHash: string;
    readonly displayName: string;
    readonly requestId: string;
  }): Promise<boolean>;
  switchTenant(input: {
    currentHash: Uint8Array;
    tenantId: string;
    newHash: Uint8Array;
    newCsrfHash: Uint8Array;
    requestId: string;
  }): Promise<boolean>;
  revokeSession(
    tokenHash: Uint8Array,
    reason: string,
    requestId: string,
  ): Promise<boolean>;
  close(): Promise<void>;
}
