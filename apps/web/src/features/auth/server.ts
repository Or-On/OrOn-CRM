import { cookies } from "next/headers";
import { cache } from "react";

import {
  AuthService,
  assertTrustedUnsafeRequest,
  createAuthRepository,
  isAuthorized,
  issueServiceAssertion,
  withTenantTransaction,
  type AuthSession,
  type Permission,
  type PublicSession,
  type TenantTransaction,
} from "@or-on/auth";
import { loadConfig } from "@or-on/config";

export const SESSION_COOKIE = "or_on_session";
export const CSRF_COOKIE = "or_on_csrf";

function authConfig() {
  const config = loadConfig(process.env, {
    requireAuth: true,
    requireDatabase: true,
    service: "web",
  });
  if (
    config.databaseUrl === undefined ||
    config.secrets.authTokenPepper === undefined ||
    config.secrets.authServiceSecret === undefined ||
    config.secrets.authDummyPasswordHash === undefined
  ) {
    throw new Error("validated authentication configuration is incomplete");
  }
  return {
    databaseUrl: config.databaseUrl,
    dummyPasswordHash: config.secrets.authDummyPasswordHash,
    secureCookies:
      config.environment === "production" ||
      process.env.AUTH_COOKIE_SECURE === "true",
    serviceSecret: config.secrets.authServiceSecret,
    tokenPepper: config.secrets.authTokenPepper,
  };
}

export async function withAuthService<T>(
  operation: (service: AuthService) => Promise<T>,
): Promise<T> {
  const config = authConfig();
  const repository = createAuthRepository(config.databaseUrl);
  try {
    return await operation(
      new AuthService(repository, {
        dummyPasswordHash: config.dummyPasswordHash,
        tokenPepper: config.tokenPepper,
      }),
    );
  } finally {
    await repository.close();
  }
}

async function resolveCurrentRawSession(): Promise<
  | {
      session: AuthSession;
      token: string;
      publicSession: PublicSession;
    }
  | undefined
> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token === undefined) return undefined;
  return withAuthService(async (service) => {
    const session = await service.resolve(token);
    return session === undefined
      ? undefined
      : { session, token, publicSession: service.toPublicSession(session) };
  });
}

/** Deduplicates layout and page session reads within the same server render. */
export const currentRawSession = cache(resolveCurrentRawSession);

export async function currentPublicSession(): Promise<
  PublicSession | undefined
> {
  const resolved = await currentRawSession();
  if (resolved === undefined) return undefined;
  return resolved.publicSession;
}

export async function requirePublicSession(): Promise<PublicSession> {
  const session = await currentPublicSession();
  if (session === undefined) throw new UnauthenticatedError("Unauthenticated");
  return session;
}

export async function setSessionCookies(
  sessionToken: string,
  csrfToken: string,
): Promise<void> {
  const store = await cookies();
  const { secureCookies } = authConfig();
  const common = { path: "/", sameSite: "lax" as const, secure: secureCookies };
  store.set(SESSION_COOKIE, sessionToken, {
    ...common,
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60,
  });
  store.set(CSRF_COOKIE, csrfToken, {
    ...common,
    httpOnly: false,
    maxAge: 7 * 24 * 60 * 60,
  });
}

export async function clearSessionCookies(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  store.delete(CSRF_COOKIE);
}

export async function issueLiveAgentGrant(
  session: AuthSession,
): Promise<string> {
  if (
    !isAuthorized(
      { role: session.tenant.role, isSuperuser: session.isSuperuser },
      "voice:operate",
    )
  ) {
    throw new ForbiddenError("Forbidden");
  }
  const { serviceSecret } = authConfig();
  return issueServiceAssertion({
    audience: "live-agent",
    capability: "live-session",
    identity: {
      role: session.tenant.role,
      sessionId: session.sessionId,
      tenantId: session.tenant.tenantId,
      userId: session.userId,
    },
    secret: serviceSecret,
  });
}

export async function issueControlApiGrant(
  session: AuthSession,
  capability:
    | "voice:read"
    | "voice:write"
    | "voice:manage"
    | "orchestration:read"
    | "orchestration:write",
): Promise<string> {
  // `voice:manage` publishes flows, routes numbers to them and creates/runs
  // campaigns: the same configuration the CRM gates on flows:manage and
  // campaigns:manage. `voice:operate` alone (agents) must not reach it.
  const required: readonly Permission[] =
    capability === "voice:read"
      ? ["voice:read"]
      : capability === "voice:write"
        ? ["voice:operate"]
        : capability === "voice:manage"
          ? ["voice:operate", "flows:manage", "campaigns:manage"]
          : capability === "orchestration:read"
            ? ["crm:read"]
            : ["flows:manage"];
  const principal = {
    role: session.tenant.role,
    isSuperuser: session.isSuperuser,
  };
  if (!required.every((permission) => isAuthorized(principal, permission))) {
    throw new ForbiddenError("Forbidden");
  }
  const { serviceSecret } = authConfig();
  return issueServiceAssertion({
    audience: "control-api",
    capability,
    identity: {
      role: session.tenant.role,
      sessionId: session.sessionId,
      tenantId: session.tenant.tenantId,
      userId: session.userId,
    },
    secret: serviceSecret,
  });
}

export async function issueDispatcherGrant(
  session: AuthSession,
): Promise<string> {
  if (
    !isAuthorized(
      { role: session.tenant.role, isSuperuser: session.isSuperuser },
      "voice:operate",
    )
  ) {
    throw new ForbiddenError("Forbidden");
  }
  const { serviceSecret } = authConfig();
  return issueServiceAssertion({
    audience: "dispatcher",
    capability: "voice:dial",
    identity: {
      role: session.tenant.role,
      sessionId: session.sessionId,
      tenantId: session.tenant.tenantId,
      userId: session.userId,
    },
    secret: serviceSecret,
  });
}

export class UnauthenticatedError extends Error {}
export class ForbiddenError extends Error {}

export async function assertAuthenticatedMutation(
  request: Request,
): Promise<AuthSession> {
  assertTrustedUnsafeRequest(request);
  const resolved = await currentRawSession();
  if (resolved === undefined) throw new UnauthenticatedError("Unauthenticated");
  const csrfCookie = (await cookies()).get(CSRF_COOKIE)?.value ?? "";
  const csrfHeader = request.headers.get("x-csrf-token") ?? "";
  await withAuthService((service) => {
    service.validateCsrf(resolved.session, csrfCookie, csrfHeader);
    return Promise.resolve();
  });
  return resolved.session;
}

export async function withCurrentTenant<T>(
  permission: Permission,
  operation: (
    transaction: TenantTransaction,
    session: AuthSession,
  ) => Promise<T>,
): Promise<T> {
  return withResolvedTenant(await currentRawSession(), permission, operation);
}

/** Recheck after an external round trip; render-scoped cached identity may be revoked. */
export async function withFreshCurrentTenant<T>(
  permission: Permission,
  operation: (
    transaction: TenantTransaction,
    session: AuthSession,
  ) => Promise<T>,
): Promise<T> {
  return withResolvedTenant(
    await resolveCurrentRawSession(),
    permission,
    operation,
    true,
  );
}

async function withResolvedTenant<T>(
  resolved: Awaited<ReturnType<typeof resolveCurrentRawSession>>,
  permission: Permission,
  operation: (
    transaction: TenantTransaction,
    session: AuthSession,
  ) => Promise<T>,
  lockAuthorization = false,
): Promise<T> {
  if (resolved === undefined) throw new UnauthenticatedError("Unauthenticated");
  if (
    !isAuthorized(
      {
        role: resolved.session.tenant.role,
        isSuperuser: resolved.session.isSuperuser,
      },
      permission,
    )
  )
    throw new ForbiddenError("Forbidden");
  const { databaseUrl } = authConfig();
  return withTenantTransaction(
    databaseUrl,
    {
      tenantId: resolved.session.tenant.tenantId,
      userId: resolved.session.userId,
      role: resolved.session.tenant.role,
      sessionId: resolved.session.sessionId,
    },
    async (transaction) => {
      if (lockAuthorization) {
        const rows = await transaction<{ allowed: boolean }[]>`
          SELECT platform.lock_current_authorization(${resolved.session.sessionId}::uuid,
            ${resolved.session.tenant.role}, ${resolved.session.isSuperuser},
            ${resolved.session.rotationCount}) AS allowed
        `;
        if (rows[0]?.allowed !== true) throw new ForbiddenError("Forbidden");
      }
      return operation(transaction, resolved.session);
    },
  );
}
