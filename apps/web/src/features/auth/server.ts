import { cookies } from "next/headers";

import {
  AuthService,
  assertTrustedUnsafeRequest,
  createAuthRepository,
  hasPermission,
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

export async function currentRawSession(): Promise<
  | {
      session: AuthSession;
      token: string;
    }
  | undefined
> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token === undefined) return undefined;
  const session = await withAuthService((service) => service.resolve(token));
  return session === undefined ? undefined : { session, token };
}

export async function currentPublicSession(): Promise<
  PublicSession | undefined
> {
  const resolved = await currentRawSession();
  if (resolved === undefined) return undefined;
  return withAuthService((service) =>
    Promise.resolve(service.toPublicSession(resolved.session)),
  );
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
  capability: "voice:read" | "voice:write",
): Promise<string> {
  const permission =
    capability === "voice:read" ? "voice:read" : "voice:operate";
  if (!hasPermission(session.tenant.role, permission)) {
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
  const resolved = await currentRawSession();
  if (resolved === undefined) throw new UnauthenticatedError("Unauthenticated");
  if (!hasPermission(resolved.session.tenant.role, permission))
    throw new ForbiddenError("Forbidden");
  const { databaseUrl } = authConfig();
  return withTenantTransaction(
    databaseUrl,
    {
      tenantId: resolved.session.tenant.tenantId,
      userId: resolved.session.userId,
      role: resolved.session.tenant.role,
    },
    (transaction) => operation(transaction, resolved.session),
  );
}
