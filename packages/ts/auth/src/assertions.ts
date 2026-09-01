import { jwtVerify, SignJWT, errors } from "jose";

import { normalizeRole, type Role } from "./authorization.js";

export interface AssertionIdentity {
  readonly userId: string;
  readonly tenantId: string;
  readonly role: Role;
  readonly sessionId: string;
}

export async function issueServiceAssertion(input: {
  readonly secret: string;
  readonly audience: string;
  readonly identity: AssertionIdentity;
  readonly capability?: string;
  readonly ttlSeconds?: number;
}): Promise<string> {
  if (input.secret.length < 32)
    throw new TypeError("service secret must be at least 32 characters");
  const ttl = Math.min(Math.max(input.ttlSeconds ?? 60, 15), 120);
  const claims: Record<string, string> = {
    tenant_id: input.identity.tenantId,
    role: input.identity.role,
    session_id: input.identity.sessionId,
  };
  if (input.capability !== undefined) claims.capability = input.capability;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("or-on-platform-web")
    .setAudience(input.audience)
    .setSubject(input.identity.userId)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${String(ttl)}s`)
    .sign(new TextEncoder().encode(input.secret));
}

export async function verifyServiceAssertion(input: {
  readonly token: string;
  readonly secret: string;
  readonly audience: string;
}): Promise<AssertionIdentity & { readonly capability?: string }> {
  if (input.secret.length < 32)
    throw new TypeError("service secret must be at least 32 characters");
  try {
    const { payload } = await jwtVerify(
      input.token,
      new TextEncoder().encode(input.secret),
      {
        algorithms: ["HS256"],
        issuer: "or-on-platform-web",
        audience: input.audience,
        maxTokenAge: "2m",
      },
    );
    if (
      typeof payload.sub !== "string" ||
      typeof payload.tenant_id !== "string" ||
      typeof payload.role !== "string" ||
      typeof payload.session_id !== "string"
    ) {
      throw new TypeError("assertion is missing identity claims");
    }
    const role = normalizeRole(payload.role);
    if (role === undefined)
      throw new TypeError("assertion contains an invalid role");
    const capability =
      typeof payload.capability === "string" ? payload.capability : undefined;
    return {
      userId: payload.sub,
      tenantId: payload.tenant_id,
      role,
      sessionId: payload.session_id,
      ...(capability === undefined ? {} : { capability }),
    };
  } catch (error) {
    if (error instanceof errors.JOSEError || error instanceof TypeError) {
      throw new TypeError("service assertion is invalid", { cause: error });
    }
    throw error;
  }
}
