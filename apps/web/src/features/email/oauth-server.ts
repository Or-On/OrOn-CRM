import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type postgres from "postgres";

export type OAuthProvider = "google" | "microsoft";
export interface OAuthClientConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly directoryTenant?: string;
}

function encryptionKey(): Buffer {
  const encoded = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!encoded) throw new TypeError("Credential encryption is not configured");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32)
    throw new TypeError("Credential encryption key must be 32 bytes (base64)");
  return key;
}

function seal(value: unknown): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { ciphertext: encrypted, nonce };
}

function open(ciphertext: Buffer, nonce: Buffer): unknown {
  if (ciphertext.length < 17)
    throw new TypeError("Invalid encrypted credential");
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), nonce);
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([
      decipher.update(ciphertext.subarray(0, -16)),
      decipher.final(),
    ]).toString("utf8"),
  ) as unknown;
}

export async function saveOAuthCredential(
  sql: postgres.TransactionSql,
  provider: OAuthProvider,
  value: OAuthClientConfiguration | Record<string, unknown>,
  type: "client" | "token" = "client",
  accountId?: string,
): Promise<string> {
  if (type === "token" && !accountId)
    throw new TypeError("Mailbox identity is required for token storage");
  const envelope = seal(value);
  const suffix =
    type === "token"
      ? `_${createHash("sha256")
          .update(accountId ?? "")
          .digest("hex")}`
      : "";
  const kind = `email_oauth_${type}_${provider}${suffix}`;
  // Serialize first-create as well as updates. Locks are tenant/provider/account
  // scoped and transaction-local; no provider request runs inside this boundary.
  await sql`
    SELECT pg_advisory_xact_lock(hashtextextended(
      platform.current_tenant_id()::text || ':' || ${kind}, 0))
  `;
  const existing = await sql<{ id: string }[]>`
    UPDATE platform.credential_records
    SET display_hint=${provider}, ciphertext=${envelope.ciphertext},
        nonce=${envelope.nonce}, algorithm='aes-256-gcm', key_version='env:v1',
        rotated_at=CURRENT_TIMESTAMP
    WHERE id=(
      SELECT id FROM platform.credential_records
      WHERE kind=${kind} ORDER BY created_at DESC, id DESC LIMIT 1
    )
    RETURNING id
  `;
  if (existing[0]?.id) return existing[0].id;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO platform.credential_records
      (tenant_id, kind, display_hint, ciphertext, nonce, algorithm, key_version)
    VALUES (platform.current_tenant_id(), ${kind}, ${provider},
            ${envelope.ciphertext}, ${envelope.nonce}, 'aes-256-gcm', 'env:v1')
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error("Credential could not be stored");
  return id;
}

export async function readOAuthCredential<T>(
  sql: postgres.TransactionSql,
  provider: OAuthProvider,
  type: "client" | "token" = "client",
): Promise<T | undefined> {
  const rows = await sql<
    {
      ciphertext: Buffer;
      nonce: Buffer;
      algorithm: string;
      key_version: string;
    }[]
  >`
    SELECT ciphertext, nonce, algorithm, key_version FROM platform.credential_records
    WHERE kind=${`email_oauth_${type}_${provider}`}
    ORDER BY created_at DESC, id DESC LIMIT 1
  `;
  const row = rows[0];
  if (!row) return undefined;
  if (row.algorithm !== "aes-256-gcm" || row.key_version !== "env:v1")
    throw new TypeError("Unsupported credential envelope");
  return open(row.ciphertext, row.nonce) as T;
}

/**
 * Revoke this workspace's local ability to use one mailbox provider.
 *
 * The provider client configuration is deliberately retained so an authorized
 * administrator can reconnect without re-entering the application client. All
 * account tokens are cryptographically tombstoned, channel credential links
 * are removed, and pending authorization states are invalidated. Upstream
 * provider grants may remain valid until the customer revokes them at the
 * provider; this application can no longer read or refresh those grants.
 */
export async function disconnectOAuthProvider(
  sql: postgres.TransactionSql,
  actorUserId: string,
  provider: OAuthProvider,
  requestId: string,
): Promise<{ readonly channels: number; readonly credentials: number }> {
  const tokenKind = `email_oauth_token_${provider}`;
  await sql`
    SELECT pg_advisory_xact_lock(hashtextextended(
      platform.current_tenant_id()::text || ':email-oauth-disconnect:' || ${provider}, 0))
  `;
  const channels = await sql<{ id: string }[]>`
    UPDATE messaging.channels SET
      credential_id=NULL, status='revoked', updated_at=CURRENT_TIMESTAMP
    WHERE kind='email' AND provider=${provider}
      AND (status <> 'revoked' OR credential_id IS NOT NULL)
    RETURNING id
  `;
  const credentials = await sql<{ id: string }[]>`
    UPDATE platform.credential_records SET
      display_hint='revoked', ciphertext=NULL, nonce=NULL, algorithm=NULL,
      key_version=NULL, rotated_at=CURRENT_TIMESTAMP
    WHERE (kind=${tokenKind} OR starts_with(kind, ${`${tokenKind}_`}))
      AND ciphertext IS NOT NULL
    RETURNING id
  `;
  await sql`
    DELETE FROM platform.oauth_authorizations WHERE provider=${provider}
  `;
  await sql`
    INSERT INTO audit.records(
      tenant_id, actor_user_id, action, target_type, request_id, metadata
    ) VALUES (
      platform.current_tenant_id(), ${actorUserId}::uuid,
      'email.oauth.disconnected', 'email_provider', ${requestId},
      ${sql.json({
        provider,
        channelCount: channels.length,
        credentialCount: credentials.length,
      })}
    )
  `;
  return { channels: channels.length, credentials: credentials.length };
}

export function oauthProvider(value: string): OAuthProvider {
  if (value !== "google" && value !== "microsoft")
    throw new TypeError("Unsupported OAuth provider");
  return value;
}
