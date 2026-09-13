import { Buffer } from "node:buffer";

import { isAuthorized, permissions } from "./authorization.js";
import {
  generateOpaqueToken,
  hashPassword,
  hashOpaqueToken,
  tokenDigestMatches,
  verifyPassword,
} from "./crypto.js";
import type {
  AuthRepository,
  AuthSession,
  InvitationRecord,
  IssuedSession,
  PublicSession,
} from "./types.js";

const IDLE_SECONDS = 12 * 60 * 60;
const ABSOLUTE_SECONDS = 7 * 24 * 60 * 60;

export class InvalidCredentialsError extends Error {
  public constructor() {
    super("Invalid email or password");
    this.name = "InvalidCredentialsError";
  }
}

export class InvalidSessionError extends Error {
  public constructor() {
    super("Session is invalid or expired");
    this.name = "InvalidSessionError";
  }
}

export class ForbiddenError extends Error {
  public constructor() {
    super("The requested operation is not permitted");
    this.name = "ForbiddenError";
  }
}

export interface AuthServiceOptions {
  readonly tokenPepper: string;
  readonly dummyPasswordHash: string;
  readonly now?: () => Date;
}

export class AuthService {
  readonly #repository: AuthRepository;
  readonly #tokenPepper: string;
  readonly #dummyPasswordHash: string;
  readonly #now: () => Date;

  public constructor(repository: AuthRepository, options: AuthServiceOptions) {
    this.#repository = repository;
    this.#tokenPepper = options.tokenPepper;
    this.#dummyPasswordHash = options.dummyPasswordHash;
    this.#now = options.now ?? (() => new Date());
  }

  public async login(input: {
    email: string;
    password: string;
    requestId: string;
    userAgent?: string;
    ipAddress?: string;
  }): Promise<IssuedSession> {
    const record = await this.#repository.lookupLogin(input.email.trim());
    const candidateHash = record?.passwordHash ?? this.#dummyPasswordHash;
    const passwordValid = await verifyPassword(candidateHash, input.password);
    const now = this.#now();
    const locked = (record?.lockedUntil?.getTime() ?? 0) > now.getTime();
    if (
      record?.passwordHash === undefined ||
      record.status !== "active" ||
      locked ||
      !passwordValid
    ) {
      if (record !== undefined)
        await this.#repository.recordLoginFailure(record.userId);
      throw new InvalidCredentialsError();
    }
    const memberships = await this.#repository.membershipsForUser(
      record.userId,
    );
    const tenant = memberships[0];
    if (tenant === undefined) {
      await this.#repository.recordLoginFailure(record.userId);
      throw new InvalidCredentialsError();
    }
    await this.#repository.recordLoginSuccess(record.userId);
    const sessionToken = generateOpaqueToken();
    const csrfToken = generateOpaqueToken();
    const idleExpiresAt = new Date(now.getTime() + IDLE_SECONDS * 1000);
    const absoluteExpiresAt = new Date(now.getTime() + ABSOLUTE_SECONDS * 1000);
    const sessionId = await this.#repository.createSession({
      userId: record.userId,
      tenantId: tenant.tenantId,
      tokenHash: hashOpaqueToken(sessionToken, this.#tokenPepper),
      csrfTokenHash: hashOpaqueToken(csrfToken, this.#tokenPepper),
      idleTimeoutSeconds: IDLE_SECONDS,
      idleExpiresAt,
      absoluteExpiresAt,
      userAgentHash:
        input.userAgent === undefined
          ? undefined
          : hashOpaqueToken(input.userAgent, this.#tokenPepper),
      ipHash:
        input.ipAddress === undefined
          ? undefined
          : hashOpaqueToken(input.ipAddress, this.#tokenPepper),
      requestId: input.requestId,
    });
    return {
      sessionToken,
      csrfToken,
      session: {
        sessionId,
        userId: record.userId,
        email: record.email,
        displayName: record.displayName,
        isSuperuser: record.isSuperuser,
        tenant,
        memberships,
        csrfTokenHash: hashOpaqueToken(csrfToken, this.#tokenPepper),
        absoluteExpiresAt,
        rotationCount: 0,
      },
    };
  }

  public async resolve(sessionToken: string): Promise<AuthSession | undefined> {
    return this.#repository.resolveSession(
      hashOpaqueToken(sessionToken, this.#tokenPepper),
    );
  }

  public async requireSession(sessionToken: string): Promise<AuthSession> {
    const session = await this.resolve(sessionToken);
    if (session === undefined) throw new InvalidSessionError();
    return session;
  }

  public validateCsrf(
    session: AuthSession,
    cookieToken: string,
    headerToken: string,
  ): void {
    if (cookieToken !== headerToken) throw new ForbiddenError();
    const digest = hashOpaqueToken(headerToken, this.#tokenPepper);
    if (!tokenDigestMatches(session.csrfTokenHash, digest))
      throw new ForbiddenError();
  }

  public async switchTenant(input: {
    sessionToken: string;
    tenantId: string;
    requestId: string;
  }): Promise<{ sessionToken: string; csrfToken: string }> {
    await this.requireSession(input.sessionToken);
    const nextToken = generateOpaqueToken();
    const nextCsrf = generateOpaqueToken();
    const switched = await this.#repository.switchTenant({
      currentHash: hashOpaqueToken(input.sessionToken, this.#tokenPepper),
      tenantId: input.tenantId,
      newHash: hashOpaqueToken(nextToken, this.#tokenPepper),
      newCsrfHash: hashOpaqueToken(nextCsrf, this.#tokenPepper),
      requestId: input.requestId,
    });
    if (!switched) throw new ForbiddenError();
    return { sessionToken: nextToken, csrfToken: nextCsrf };
  }

  public async logout(sessionToken: string, requestId: string): Promise<void> {
    await this.#repository.revokeSession(
      hashOpaqueToken(sessionToken, this.#tokenPepper),
      "user_logout",
      requestId,
    );
  }

  public async verifyCurrentPassword(
    session: AuthSession,
    password: string,
  ): Promise<boolean> {
    const record = await this.#repository.lookupLogin(session.email);
    return record?.userId === session.userId &&
      record.passwordHash !== undefined
      ? verifyPassword(record.passwordHash, password)
      : false;
  }

  public async inspectInvitation(
    token: string,
  ): Promise<InvitationRecord | undefined> {
    if (token.length < 32 || token.length > 128) return undefined;
    return this.#repository.invitationRecord(
      Buffer.from(hashOpaqueToken(token, this.#tokenPepper)).toString("hex"),
    );
  }

  public async acceptInvitation(input: {
    readonly token: string;
    readonly password?: string;
    readonly displayName?: string;
    readonly requestId: string;
  }): Promise<{ readonly accountCreated: boolean }> {
    const invitation = await this.inspectInvitation(input.token);
    if (invitation === undefined) throw new InvalidCredentialsError();
    const passwordHash = invitation.existingAccount
      ? "existing-account"
      : await hashPassword(input.password ?? "");
    const accountCreated = await this.#repository.acceptInvitation({
      tokenHash: Buffer.from(
        hashOpaqueToken(input.token, this.#tokenPepper),
      ).toString("hex"),
      passwordHash,
      displayName: input.displayName?.trim() ?? "",
      requestId: input.requestId,
    });
    return { accountCreated };
  }

  public toPublicSession(session: AuthSession): PublicSession {
    return {
      user: {
        id: session.userId,
        email: session.email,
        ...(session.displayName === undefined
          ? {}
          : { displayName: session.displayName }),
        isSuperuser: session.isSuperuser,
      },
      tenant: session.tenant,
      memberships: session.memberships,
      expiresAt: session.absoluteExpiresAt.toISOString(),
      permissions: permissions.filter((permission) =>
        isAuthorized(
          { role: session.tenant.role, isSuperuser: session.isSuperuser },
          permission,
        ),
      ),
    };
  }
}
