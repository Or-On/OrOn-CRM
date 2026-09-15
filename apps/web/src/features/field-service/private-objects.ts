import "server-only";

import {
  commitPrivateObject,
  discardPrivateObject,
  privateObjectStorageOptionsFromEnvironment,
  readPrivateObject as readSharedPrivateObject,
  stagePrivateObject as stageSharedPrivateObject,
  type PrivateObjectContentType,
  type StagedPrivateObject,
} from "@or-on/crm";

export type { PrivateObjectContentType, StagedPrivateObject };
export { commitPrivateObject, discardPrivateObject };

export function stagePrivateObject(
  input: Parameters<typeof stageSharedPrivateObject>[0],
) {
  return stageSharedPrivateObject(
    input,
    privateObjectStorageOptionsFromEnvironment(process.env),
  );
}

export function readPrivateObject(
  storageKey: string,
  expected: { readonly byteSize: number; readonly checksum: string },
) {
  return readSharedPrivateObject(
    storageKey,
    expected,
    privateObjectStorageOptionsFromEnvironment(process.env),
  );
}
