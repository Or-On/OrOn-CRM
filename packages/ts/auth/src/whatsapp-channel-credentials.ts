import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const algorithm = "aes-256-gcm:whatsapp-channel:v2";
const kind = "whatsapp_access_token_v2";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export interface ChannelCredentialEnvelope {
  readonly tenantId: string;
  readonly channelId: string;
  readonly credentialId: string;
  readonly kind: string;
  readonly algorithm: string | null;
  readonly keyVersion: string | null;
  readonly ciphertext: string | null;
  readonly nonce: string | null;
}
function aad(
  envelope: Pick<
    ChannelCredentialEnvelope,
    "tenantId" | "channelId" | "credentialId"
  >,
): Buffer {
  if (
    ![envelope.tenantId, envelope.channelId, envelope.credentialId].every(
      (id) => uuid.test(id),
    )
  )
    throw new TypeError("credential_binding_invalid");
  return Buffer.from(
    JSON.stringify([
      "oron.whatsapp.channel.v2",
      envelope.tenantId,
      envelope.channelId,
      envelope.credentialId,
    ]),
  );
}
export function channelCredentialKey(
  encoded: string | undefined,
): Buffer | undefined {
  if (encoded === undefined) return undefined;
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded)
    throw new TypeError("credential_key_invalid");
  return key;
}
export function channelCredentialKeys(
  environment: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<string, Buffer> {
  const keys = new Map<string, Buffer>();
  const current = channelCredentialKey(environment.CREDENTIAL_ENCRYPTION_KEY);
  if (current !== undefined) keys.set("env:wa:v2", current);
  if (environment.CREDENTIAL_ENCRYPTION_KEYRING !== undefined) {
    try {
      const value: unknown = JSON.parse(
        environment.CREDENTIAL_ENCRYPTION_KEYRING,
      );
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        Object.keys(value).length > 16
      )
        throw new TypeError();
      for (const [version, encoded] of Object.entries(value)) {
        if (
          !/^[A-Za-z0-9:_.-]{1,100}$/u.test(version) ||
          version === "env:v1" ||
          typeof encoded !== "string" ||
          keys.has(version)
        )
          throw new TypeError();
        const key = channelCredentialKey(encoded);
        if (key === undefined) throw new TypeError();
        keys.set(version, key);
      }
    } catch {
      throw new TypeError("credential_keyring_invalid");
    }
  }
  return keys;
}
/** Explicit provisioning format only; never called with an invented runtime key. */
export function sealChannelCredential(
  binding: Pick<
    ChannelCredentialEnvelope,
    "tenantId" | "channelId" | "credentialId"
  >,
  accessToken: string,
  key: Buffer,
  keyVersion = "env:wa:v2",
): ChannelCredentialEnvelope {
  if (key.length !== 32 || !/^[A-Za-z0-9:_.-]{1,100}$/u.test(keyVersion))
    throw new TypeError("credential_key_invalid");
  if (!/^[\x21-\x7e]{1,8192}$/u.test(accessToken))
    throw new TypeError("credential_token_invalid");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(binding));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ accessToken }), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    ...binding,
    kind,
    algorithm,
    keyVersion,
    ciphertext: ciphertext.toString("hex"),
    nonce: nonce.toString("hex"),
  };
}
/** Metadata is freshly projected under job authority even on every cache hit. */
export function createChannelCredentialResolver(
  keys: ReadonlyMap<string, Buffer>,
  ttlMs = 5000,
) {
  const cache = new Map<string, { token: string; expires: number }>();
  return (envelope: ChannelCredentialEnvelope): string => {
    const binding = aad(envelope);
    const key =
      envelope.keyVersion === null ? undefined : keys.get(envelope.keyVersion);
    if (
      envelope.kind !== kind ||
      envelope.algorithm !== algorithm ||
      key?.length !== 32 ||
      envelope.ciphertext === null ||
      envelope.nonce === null ||
      !/^[0-9a-f]{34,20000}$/u.test(envelope.ciphertext) ||
      envelope.ciphertext.length % 2 !== 0 ||
      !/^[0-9a-f]{24}$/u.test(envelope.nonce)
    )
      throw new TypeError("channel_credential_unavailable");
    const fingerprint = createHash("sha256")
      .update(binding)
      .update(key)
      .update(envelope.keyVersion ?? "")
      .update(envelope.ciphertext)
      .update(envelope.nonce)
      .digest("hex");
    const hit = cache.get(fingerprint);
    if (hit !== undefined && hit.expires > Date.now()) return hit.token;
    try {
      const ciphertext = Buffer.from(envelope.ciphertext, "hex");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(envelope.nonce, "hex"),
      );
      decipher.setAAD(binding);
      decipher.setAuthTag(ciphertext.subarray(-16));
      const payload: unknown = JSON.parse(
        Buffer.concat([
          decipher.update(ciphertext.subarray(0, -16)),
          decipher.final(),
        ]).toString("utf8"),
      );
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload) ||
        Object.keys(payload).length !== 1 ||
        !("accessToken" in payload) ||
        typeof payload.accessToken !== "string" ||
        !/^[\x21-\x7e]{1,8192}$/u.test(payload.accessToken)
      )
        throw new TypeError("channel_credential_unavailable");
      if (cache.size >= 100) cache.delete(cache.keys().next().value ?? "");
      cache.set(fingerprint, {
        token: payload.accessToken,
        expires: Date.now() + Math.min(Math.max(ttlMs, 0), 5000),
      });
      return payload.accessToken;
    } catch {
      throw new TypeError("channel_credential_unavailable");
    }
  };
}
