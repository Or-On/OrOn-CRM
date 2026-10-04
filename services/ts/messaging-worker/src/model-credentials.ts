import { channelCredentialKey } from "./channel-credentials.js";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const algorithm = "aes-256-gcm:model-provider:v2";
const kind = "llm_api_key_v2";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export interface ResolvedModelCredential {
  readonly apiKey: string;
  readonly fingerprint: string;
}
export interface ModelCredentialEnvelope {
  readonly tenantId: string;
  readonly modelConfigurationId: string;
  readonly credentialId: string;
  readonly provider: "openai" | "gemini";
  readonly kind: string;
  readonly algorithm: string | null;
  readonly keyVersion: string | null;
  readonly ciphertext: string | null;
  readonly nonce: string | null;
}
function aad(
  envelope: Pick<
    ModelCredentialEnvelope,
    "tenantId" | "modelConfigurationId" | "credentialId" | "provider"
  >,
): Buffer {
  if (
    ![
      envelope.tenantId,
      envelope.modelConfigurationId,
      envelope.credentialId,
    ].every((id) => uuid.test(id))
  )
    throw new TypeError("credential_binding_invalid");
  if (!["openai", "gemini"].includes(envelope.provider))
    throw new TypeError("credential_binding_invalid");
  return Buffer.from(
    JSON.stringify([
      "oron.model.provider.v2",
      envelope.tenantId,
      envelope.modelConfigurationId,
      envelope.credentialId,
      envelope.provider,
    ]),
  );
}
export function modelCredentialKeys(
  environment: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<string, Buffer> {
  const keys = new Map<string, Buffer>();
  const current = channelCredentialKey(environment.CREDENTIAL_ENCRYPTION_KEY);
  if (current !== undefined) keys.set("env:model:v2", current);
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
export function sealModelCredential(
  binding: Pick<
    ModelCredentialEnvelope,
    "tenantId" | "modelConfigurationId" | "credentialId" | "provider"
  >,
  apiKey: string,
  key: Buffer,
  keyVersion = "env:model:v2",
): ModelCredentialEnvelope {
  if (
    key.length !== 32 ||
    keyVersion === "env:v1" ||
    !/^[A-Za-z0-9:_.-]{1,100}$/u.test(keyVersion)
  )
    throw new TypeError("credential_key_invalid");
  if (!/^[\x21-\x7e]{1,8192}$/u.test(apiKey))
    throw new TypeError("credential_token_invalid");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(binding));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ apiKey }), "utf8"),
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
export function createModelCredentialResolver(
  keys: ReadonlyMap<string, Buffer>,
  ttlMs = 5000,
) {
  const cache = new Map<string, { token: string; expires: number }>();
  return (envelope: ModelCredentialEnvelope): ResolvedModelCredential => {
    const binding = aad(envelope);
    const key =
      envelope.keyVersion === null ? undefined : keys.get(envelope.keyVersion);
    if (
      envelope.kind !== kind ||
      envelope.algorithm !== algorithm ||
      envelope.keyVersion === "env:v1" ||
      key?.length !== 32 ||
      envelope.ciphertext === null ||
      envelope.nonce === null ||
      !/^[0-9a-f]{34,20000}$/u.test(envelope.ciphertext) ||
      envelope.ciphertext.length % 2 !== 0 ||
      !/^[0-9a-f]{24}$/u.test(envelope.nonce)
    )
      throw new TypeError("model_credential_unavailable");
    const fingerprint = createHash("sha256")
      .update(binding)
      .update(key)
      .update(envelope.keyVersion ?? "")
      .update(envelope.ciphertext)
      .update(envelope.nonce)
      .digest("hex");
    const hit = cache.get(fingerprint);
    if (hit !== undefined && hit.expires > Date.now())
      return { apiKey: hit.token, fingerprint };
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
        !("apiKey" in payload) ||
        typeof payload.apiKey !== "string" ||
        !/^[\x21-\x7e]{1,8192}$/u.test(payload.apiKey)
      )
        throw new TypeError("model_credential_unavailable");
      if (cache.size >= 100) cache.delete(cache.keys().next().value ?? "");
      cache.set(fingerprint, {
        token: payload.apiKey,
        expires: Date.now() + Math.min(Math.max(ttlMs, 0), 5000),
      });
      return { apiKey: payload.apiKey, fingerprint };
    } catch {
      throw new TypeError("model_credential_unavailable");
    }
  };
}
