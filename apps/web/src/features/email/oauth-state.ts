import { createHash } from "node:crypto";
import type { AuthSession, TenantTransaction } from "@or-on/auth";
import type { OAuthProvider } from "./oauth-server";

export function oauthCallbackUrl(
  provider: OAuthProvider,
  requestUrl: string,
): string {
  const configured = process.env.PUBLIC_SITE_URL;
  if (!configured && process.env.PLATFORM_ENV === "production")
    throw new TypeError("PUBLIC_SITE_URL is required for OAuth");
  const origin = new URL(configured ?? new URL(requestUrl).origin);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new TypeError("Invalid OAuth public origin");
  if (
    origin.protocol !== "https:" &&
    !(
      origin.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
    )
  )
    throw new TypeError("OAuth requires HTTPS");
  return new URL(`/api/email/oauth/${provider}/callback`, origin).toString();
}

function digest(state: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(state))
    throw new TypeError("Invalid OAuth state");
  return createHash("sha256").update(state).digest("hex");
}

export function sameOAuthIdentity(
  expected: AuthSession,
  actual: AuthSession,
): void {
  if (
    expected.sessionId !== actual.sessionId ||
    expected.userId !== actual.userId ||
    expected.tenant.tenantId !== actual.tenant.tenantId
  )
    throw new TypeError(
      "OAuth identity changed; reconnect from the intended workspace",
    );
}

export async function createOAuthState(
  sql: TenantTransaction,
  session: AuthSession,
  state: string,
  provider: OAuthProvider,
  callback: string,
): Promise<void> {
  // Bounded lifetime and no token/verifier stored. Prune only this principal's expired rows.
  await sql`DELETE FROM platform.oauth_authorizations WHERE expires_at < CURRENT_TIMESTAMP`;
  await sql`
    INSERT INTO platform.oauth_authorizations
      (state_hash, tenant_id, user_id, session_id, provider, redirect_uri)
    VALUES (${digest(state)}, ${session.tenant.tenantId}::uuid, ${session.userId}::uuid,
            ${session.sessionId}::uuid, ${provider}, ${callback})
  `;
}

export async function consumeOAuthState(
  sql: TenantTransaction,
  session: AuthSession,
  state: string,
  provider: OAuthProvider,
  callback: string,
): Promise<void> {
  const rows = await sql`
    UPDATE platform.oauth_authorizations SET consumed_at=CURRENT_TIMESTAMP
    WHERE state_hash=${digest(state)} AND session_id=${session.sessionId}::uuid
      AND tenant_id=${session.tenant.tenantId}::uuid AND user_id=${session.userId}::uuid
      AND provider=${provider} AND redirect_uri=${callback}
      AND consumed_at IS NULL AND expires_at>CURRENT_TIMESTAMP
    RETURNING state_hash
  `;
  if (rows.length !== 1)
    throw new TypeError(
      "OAuth request expired, changed identity or was already used",
    );
}
