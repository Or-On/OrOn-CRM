import "server-only";

import {
  normalizeNationalId,
  protectNationalIdWithKeys,
  protectedFieldKeysFromEnvironment,
  revealNationalIdWithKeys,
} from "@or-on/crm";

export { normalizeNationalId };

export function protectNationalId(tenantId: string, value: string) {
  return protectNationalIdWithKeys(
    tenantId,
    value,
    protectedFieldKeysFromEnvironment(process.env),
  );
}

export function revealNationalId(tenantId: string, ciphertext: string): string {
  return revealNationalIdWithKeys(
    tenantId,
    ciphertext,
    protectedFieldKeysFromEnvironment(process.env),
  );
}
