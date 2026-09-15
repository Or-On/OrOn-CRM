import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

import type { ProtectedNationalIdEnvelope } from "./field-service.js";

const prefix = "v1:";
const nonceLength = 12;

export interface ProtectedFieldKeys {
  readonly cipherKeyBase64: string;
  readonly blindIndexKeyBase64: string;
}

function decodeKeys(keys: ProtectedFieldKeys): {
  readonly cipher: Buffer;
  readonly blindIndex: Buffer;
} {
  const cipher = Buffer.from(keys.cipherKeyBase64, "base64");
  const blindIndex = Buffer.from(keys.blindIndexKeyBase64, "base64");
  if (cipher.length !== 32)
    throw new TypeError(
      "FIELD_CIPHER_LOCAL_KEY must decode to exactly 32 bytes",
    );
  if (blindIndex.length < 32)
    throw new TypeError("BLIND_INDEX_KEY must decode to at least 32 bytes");
  return { cipher, blindIndex };
}

export function protectedFieldKeysFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): ProtectedFieldKeys {
  const cipherKeyBase64 = environment.FIELD_CIPHER_LOCAL_KEY;
  const blindIndexKeyBase64 = environment.BLIND_INDEX_KEY;
  if (!cipherKeyBase64)
    throw new TypeError("FIELD_CIPHER_LOCAL_KEY is not configured");
  if (!blindIndexKeyBase64)
    throw new TypeError("BLIND_INDEX_KEY is not configured");
  return { cipherKeyBase64, blindIndexKeyBase64 };
}

export function normalizeNationalId(value: string): string {
  const normalized = value.replace(/[\s-]/gu, "");
  if (!/^\d{4,32}$/u.test(normalized))
    throw new TypeError("National ID must contain 4 to 32 digits");
  return normalized;
}

export function protectNationalIdWithKeys(
  tenantId: string,
  value: string,
  keys: ProtectedFieldKeys,
): ProtectedNationalIdEnvelope {
  const normalized = normalizeNationalId(value);
  const decoded = decodeKeys(keys);
  const nonce = randomBytes(nonceLength);
  const cipher = createCipheriv("aes-256-gcm", decoded.cipher, nonce);
  cipher.setAAD(Buffer.from(tenantId, "utf8"));
  const ciphertext = Buffer.concat([
    nonce,
    cipher.update(normalized, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    ciphertext: `${prefix}${ciphertext.toString("base64")}`,
    blindIndex: createHmac("sha256", decoded.blindIndex)
      .update(`${tenantId}:${normalized}`, "utf8")
      .digest("hex"),
    hint: normalized.slice(-4),
  };
}

export function revealNationalIdWithKeys(
  tenantId: string,
  ciphertext: string,
  keys: ProtectedFieldKeys,
): string {
  if (!ciphertext.startsWith(prefix))
    throw new TypeError("Unsupported protected-field version");
  const envelope = Buffer.from(ciphertext.slice(prefix.length), "base64");
  if (envelope.length <= nonceLength + 16)
    throw new TypeError("Protected national ID is invalid");
  const decoded = decodeKeys(keys);
  const nonce = envelope.subarray(0, nonceLength);
  const payload = envelope.subarray(nonceLength);
  const tag = payload.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", decoded.cipher, nonce);
  decipher.setAAD(Buffer.from(tenantId, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(payload.subarray(0, -16)),
    decipher.final(),
  ]).toString("utf8");
}
