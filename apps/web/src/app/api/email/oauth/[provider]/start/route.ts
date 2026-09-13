import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { withFreshCurrentTenant } from "../../../../../../features/auth";
import { crmErrorResponse } from "../../../../../../features/crm-route";
import {
  oauthProvider,
  oauthCallbackUrl,
  createOAuthState,
  readOAuthCredential,
  type OAuthClientConfiguration,
} from "../../../../../../features/email";

const b64 = (value: Buffer) => value.toString("base64url");

export async function GET(
  request: Request,
  context: RouteContext<"/api/email/oauth/[provider]/start">,
) {
  try {
    if (request.headers.get("sec-fetch-site") === "cross-site")
      return new Response(null, { status: 403 });
    const provider = oauthProvider((await context.params).provider);
    const state = b64(randomBytes(32));
    const verifier = b64(randomBytes(48));
    const challenge = b64(createHash("sha256").update(verifier).digest());
    const callback = oauthCallbackUrl(provider, request.url);
    const client = await withFreshCurrentTenant(
      "tenant:manage",
      async (sql, session) => {
        const configuration =
          await readOAuthCredential<OAuthClientConfiguration>(sql, provider);
        if (!configuration)
          throw new TypeError("Configure OAuth credentials first");
        await createOAuthState(sql, session, state, provider, callback);
        return configuration;
      },
    );
    const authorization =
      provider === "google"
        ? new URL("https://accounts.google.com/o/oauth2/v2/auth")
        : new URL(
            `https://login.microsoftonline.com/${encodeURIComponent(client.directoryTenant ?? "common")}/oauth2/v2.0/authorize`,
          );
    authorization.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: callback,
      response_type: "code",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope:
        provider === "google"
          ? "openid email profile"
          : "openid offline_access User.Read",
      ...(provider === "google"
        ? { access_type: "offline", prompt: "consent" }
        : {}),
    }).toString();
    (await cookies()).set(
      `or_on_oauth_${provider}`,
      JSON.stringify({ state, verifier }),
      {
        httpOnly: true,
        maxAge: 600,
        path: `/api/email/oauth/${provider}`,
        sameSite: "lax",
        secure: process.env.PLATFORM_ENV === "production",
      },
    );
    return NextResponse.redirect(authorization);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
