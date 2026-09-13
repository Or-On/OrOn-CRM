import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { withFreshCurrentTenant } from "../../../../../../features/auth";
import { crmErrorResponse } from "../../../../../../features/crm-route";
import {
  oauthProvider,
  oauthCallbackUrl,
  consumeOAuthState,
  sameOAuthIdentity,
  readOAuthCredential,
  saveOAuthCredential,
  type OAuthClientConfiguration,
} from "../../../../../../features/email";

export async function GET(
  request: Request,
  context: RouteContext<"/api/email/oauth/[provider]/callback">,
) {
  try {
    const provider = oauthProvider((await context.params).provider);
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const jar = await cookies();
    const cookie = jar.get(`or_on_oauth_${provider}`)?.value;
    jar.set(`or_on_oauth_${provider}`, "", {
      path: `/api/email/oauth/${provider}`,
      maxAge: 0,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.PLATFORM_ENV === "production",
    });
    if (!code || !state || !cookie)
      throw new TypeError("OAuth authorization was not completed");
    const pending = JSON.parse(cookie) as {
      state?: unknown;
      verifier?: unknown;
    };
    if (
      pending.state !== state ||
      typeof pending.verifier !== "string" ||
      !/^[A-Za-z0-9_-]{64}$/u.test(pending.verifier)
    )
      throw new TypeError("OAuth state did not match");
    const callback = oauthCallbackUrl(provider, request.url);
    const { client, identity } = await withFreshCurrentTenant(
      "tenant:manage",
      async (sql, session) => {
        await consumeOAuthState(sql, session, state, provider, callback);
        const configuration =
          await readOAuthCredential<OAuthClientConfiguration>(sql, provider);
        if (!configuration)
          throw new TypeError("OAuth credentials are unavailable");
        return { client: configuration, identity: session };
      },
    );
    const tokenUrl =
      provider === "google"
        ? "https://oauth2.googleapis.com/token"
        : `https://login.microsoftonline.com/${encodeURIComponent(client.directoryTenant ?? "common")}/oauth2/v2.0/token`;
    const tokenResponse = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code,
        code_verifier: pending.verifier,
        grant_type: "authorization_code",
        redirect_uri: callback,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenResponse.ok)
      throw new Error(
        `OAuth token exchange failed (${String(tokenResponse.status)})`,
      );
    const token = (await tokenResponse.json()) as Record<string, unknown>;
    if (typeof token.access_token !== "string")
      throw new Error("OAuth token response was incomplete");
    const profileResponse = await fetch(
      provider === "google"
        ? "https://openidconnect.googleapis.com/v1/userinfo"
        : "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName",
      {
        headers: { authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!profileResponse.ok)
      throw new Error("Mailbox identity could not be read");
    const profile = (await profileResponse.json()) as Record<string, unknown>;
    const accountId =
      typeof profile.sub === "string"
        ? profile.sub
        : typeof profile.id === "string"
          ? profile.id
          : "";
    const address =
      typeof profile.email === "string"
        ? profile.email
        : typeof profile.mail === "string"
          ? profile.mail
          : typeof profile.userPrincipalName === "string"
            ? profile.userPrincipalName
            : "";
    if (!accountId || !address)
      throw new Error("Mailbox identity was incomplete");
    await withFreshCurrentTenant(
      "tenant:manage",
      async (sql, currentIdentity) => {
        sameOAuthIdentity(identity, currentIdentity);
        const credentialId = await saveOAuthCredential(
          sql,
          provider,
          token,
          "token",
          accountId,
        );
        await sql`
        INSERT INTO messaging.channels
          (tenant_id, kind, provider, provider_account_id, display_address,
           credential_id, status, configuration)
        VALUES (platform.current_tenant_id(), 'email', ${provider}, ${accountId},
                ${address}, ${credentialId}::uuid, 'active',
                ${sql.json({ oauth: true, scopes: typeof token.scope === "string" ? token.scope : null })})
        ON CONFLICT (provider, provider_account_id) WHERE provider_account_id IS NOT NULL
        DO UPDATE SET display_address=EXCLUDED.display_address,
          credential_id=EXCLUDED.credential_id, status='active',
          configuration=EXCLUDED.configuration, updated_at=CURRENT_TIMESTAMP
      `;
      },
    );
    return NextResponse.redirect(new URL("/email?connected=1", callback));
  } catch (error) {
    const response = crmErrorResponse(error);
    if (response.status >= 400) {
      try {
        const provider = oauthProvider((await context.params).provider);
        return NextResponse.redirect(
          new URL(
            "/email?oauthError=1",
            oauthCallbackUrl(provider, request.url),
          ),
        );
      } catch {
        return response;
      }
    }
    return response;
  }
}
