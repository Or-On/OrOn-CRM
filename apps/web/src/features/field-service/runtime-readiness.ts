import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { FieldServiceRuntimeReadiness } from "./field-service-settings";

type Environment = Readonly<Record<string, string | undefined>>;
type AccessCheck = (path: string, mode: number) => Promise<void>;

function configured(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function protectedFieldsConfigured(environment: Environment): boolean {
  const cipher = environment.FIELD_CIPHER_LOCAL_KEY;
  const blindIndex = environment.BLIND_INDEX_KEY;
  if (
    cipher === undefined ||
    blindIndex === undefined ||
    !configured(cipher) ||
    !configured(blindIndex)
  )
    return false;
  return (
    Buffer.from(cipher, "base64").byteLength === 32 &&
    Buffer.from(blindIndex, "base64").byteLength >= 32
  );
}

export async function fieldServiceRuntimeReadiness(
  environment: Environment = process.env,
  accessCheck: AccessCheck = access,
): Promise<FieldServiceRuntimeReadiness> {
  const storageBackend =
    environment.ARTIFACTS_BACKEND?.trim().toLowerCase() ?? "unconfigured";
  const storageRoot = environment.ARTIFACTS_LOCAL_ROOT?.trim();
  let privateStorageConfigured = false;
  if (
    storageBackend === "local" &&
    storageRoot !== undefined &&
    isAbsolute(storageRoot)
  ) {
    try {
      await accessCheck(storageRoot, constants.R_OK | constants.W_OK);
      privateStorageConfigured = true;
    } catch {
      privateStorageConfigured = false;
    }
  }

  return {
    aiProviderConfigured:
      environment.ENABLE_WHATSAPP_AI?.toLowerCase() === "true" &&
      environment.LLM_PROVIDER === "openai-compat" &&
      configured(environment.LLM_API_KEY) &&
      configured(environment.LLM_BASE_URL) &&
      configured(environment.LLM_MODEL),
    protectedFieldsConfigured: protectedFieldsConfigured(environment),
    privateStorageConfigured,
    storageBackend,
  };
}
