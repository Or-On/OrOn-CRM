import { hash, verify, type Options } from "@node-rs/argon2";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ARGON2_OPTIONS = {
  // @node-rs/argon2 declares Algorithm as an ambient const enum, which strict
  // verbatim-module builds cannot reference. Its documented Argon2id value is 2.
  algorithm: 2,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} as const satisfies Options;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 1024) {
    throw new TypeError("password must contain between 12 and 1024 characters");
  }
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(passwordHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string, pepper: string): Uint8Array {
  if (pepper.length < 32)
    throw new TypeError("token pepper must be at least 32 characters");
  return createHmac("sha256", pepper).update(token, "utf8").digest();
}

export function tokenDigestMatches(
  expected: Uint8Array,
  actual: Uint8Array,
): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}
