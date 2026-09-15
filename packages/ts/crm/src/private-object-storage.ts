import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

const supported = {
  "image/jpeg": { extension: ".jpg", maximum: 12 * 1024 * 1024 },
  "image/png": { extension: ".png", maximum: 12 * 1024 * 1024 },
  "image/webp": { extension: ".webp", maximum: 12 * 1024 * 1024 },
  "application/pdf": { extension: ".pdf", maximum: 20 * 1024 * 1024 },
  "text/plain": { extension: ".txt", maximum: 2 * 1024 * 1024 },
} as const;

export type PrivateObjectContentType = keyof typeof supported;

export interface PrivateObjectStorageOptions {
  readonly backend?: string;
  readonly localRoot?: string;
}

export interface StagedPrivateObject {
  readonly contentType: PrivateObjectContentType;
  readonly byteSize: number;
  readonly checksum: string;
  readonly storageBackend: "local";
  readonly storageKey: string;
  readonly stagedPath: string;
  readonly finalPath: string;
}

function storageRoot(options: PrivateObjectStorageOptions): string {
  const configuredRoot = options.localRoot?.trim();
  return resolve(
    configuredRoot === undefined || configuredRoot === ""
      ? ".objects"
      : configuredRoot,
  );
}

function confined(root: string, candidate: string): string {
  const target = resolve(candidate);
  const pathFromRoot = relative(root, target);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  )
    throw new TypeError("Private object path escaped its storage root");
  return target;
}

function contentType(value: string): PrivateObjectContentType {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!(normalized in supported))
    throw new TypeError("Use a JPEG, PNG, WebP, PDF, or plain-text file");
  return normalized as PrivateObjectContentType;
}

const maximumImageDimension = 16_384;
const maximumImagePixels = 40_000_000;

function assertImageDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > maximumImageDimension ||
    height > maximumImageDimension ||
    width * height > maximumImagePixels
  )
    throw new TypeError("Image dimensions exceed the supported safety limit");
}

function uint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16)
  );
}

function validatePng(bytes: Uint8Array): void {
  if (bytes.byteLength < 45) throw new TypeError("The PNG file is incomplete");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let sawHeader = false;
  let sawEnd = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.byteLength)
      throw new TypeError("The PNG chunk table is invalid");
    const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString(
      "ascii",
    );
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13)
        throw new TypeError("The PNG header is invalid");
      assertImageDimensions(
        view.getUint32(offset + 8),
        view.getUint32(offset + 12),
      );
      sawHeader = true;
    }
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.byteLength)
        throw new TypeError("The PNG end marker is invalid");
      sawEnd = true;
      break;
    }
    offset = end;
  }
  if (!sawHeader || !sawEnd) throw new TypeError("The PNG file is incomplete");
}

function validateJpeg(bytes: Uint8Array): void {
  if (bytes.byteLength < 12 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9)
    throw new TypeError("The JPEG file is incomplete");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let offset = 2;
  let dimensionsFound = false;
  while (offset + 1 < bytes.byteLength - 2) {
    if (bytes[offset] !== 0xff)
      throw new TypeError("The JPEG marker table is invalid");
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined) break;
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength)
      throw new TypeError("The JPEG segment is incomplete");
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.byteLength)
      throw new TypeError("The JPEG segment length is invalid");
    if (startOfFrame.has(marker)) {
      if (length < 7) throw new TypeError("The JPEG frame is incomplete");
      assertImageDimensions(
        view.getUint16(offset + 5),
        view.getUint16(offset + 3),
      );
      dimensionsFound = true;
    }
    if (marker === 0xda) break;
    offset += length;
  }
  if (!dimensionsFound)
    throw new TypeError("The JPEG dimensions could not be validated");
}

function validateWebp(bytes: Uint8Array): void {
  if (bytes.byteLength < 30) throw new TypeError("The WebP file is incomplete");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.byteLength)
    throw new TypeError("The WebP container length is invalid");
  let offset = 12;
  let dimensionsFound = false;
  while (offset + 8 <= bytes.byteLength) {
    const type = Buffer.from(bytes.subarray(offset, offset + 4)).toString(
      "ascii",
    );
    const length = view.getUint32(offset + 4, true);
    const data = offset + 8;
    const end = data + length;
    if (end > bytes.byteLength)
      throw new TypeError("The WebP chunk table is invalid");
    if (type === "VP8X") {
      if (length < 10) throw new TypeError("The WebP header is incomplete");
      assertImageDimensions(
        uint24LittleEndian(bytes, data + 4) + 1,
        uint24LittleEndian(bytes, data + 7) + 1,
      );
      dimensionsFound = true;
    } else if (type === "VP8L") {
      if (length < 5 || bytes[data] !== 0x2f)
        throw new TypeError("The lossless WebP header is invalid");
      const first = bytes[data + 1] ?? 0;
      const second = bytes[data + 2] ?? 0;
      const third = bytes[data + 3] ?? 0;
      const fourth = bytes[data + 4] ?? 0;
      assertImageDimensions(
        1 + first + ((second & 0x3f) << 8),
        1 + (second >> 6) + (third << 2) + ((fourth & 0x0f) << 10),
      );
      dimensionsFound = true;
    } else if (type === "VP8 ") {
      if (
        length < 10 ||
        bytes[data + 3] !== 0x9d ||
        bytes[data + 4] !== 0x01 ||
        bytes[data + 5] !== 0x2a
      )
        throw new TypeError("The lossy WebP frame is invalid");
      assertImageDimensions(
        view.getUint16(data + 6, true) & 0x3fff,
        view.getUint16(data + 8, true) & 0x3fff,
      );
      dimensionsFound = true;
    }
    offset = end + (length % 2);
  }
  if (offset !== bytes.byteLength || !dimensionsFound)
    throw new TypeError("The WebP image structure is invalid");
}

function validateMagic(
  bytes: Uint8Array,
  type: PrivateObjectContentType,
): void {
  const starts = (...values: number[]) =>
    values.every((value, index) => bytes[index] === value);
  const ascii = (start: number, end: number) =>
    Buffer.from(bytes.subarray(start, end)).toString("ascii");
  const valid =
    (type === "image/jpeg" && starts(0xff, 0xd8, 0xff)) ||
    (type === "image/png" &&
      starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) ||
    (type === "image/webp" &&
      ascii(0, 4) === "RIFF" &&
      ascii(8, 12) === "WEBP") ||
    (type === "application/pdf" && ascii(0, 5) === "%PDF-") ||
    (type === "text/plain" && !bytes.includes(0));
  if (!valid)
    throw new TypeError("The file contents do not match its declared type");
  if (type === "image/png") validatePng(bytes);
  else if (type === "image/jpeg") validateJpeg(bytes);
  else if (type === "image/webp") validateWebp(bytes);
  else if (type === "application/pdf") {
    const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 1_024)))
      .toString("ascii")
      .trimEnd();
    if (!tail.endsWith("%%EOF"))
      throw new TypeError("The PDF file is incomplete");
  } else {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (/[^\t\n\r\P{Cc}]/u.test(text))
        throw new TypeError("The text file contains unsupported control data");
    } catch (error) {
      if (error instanceof TypeError && error.message.includes("unsupported"))
        throw error;
      throw new TypeError("The text file is not valid UTF-8", { cause: error });
    }
  }
}

function safeSegment(value: string, label: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(value))
    throw new TypeError(`${label} is invalid`);
  return value;
}

export function privateObjectStorageOptionsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): PrivateObjectStorageOptions {
  return {
    ...(environment.ARTIFACTS_BACKEND === undefined
      ? {}
      : { backend: environment.ARTIFACTS_BACKEND }),
    ...(environment.ARTIFACTS_LOCAL_ROOT === undefined
      ? {}
      : { localRoot: environment.ARTIFACTS_LOCAL_ROOT }),
  };
}

function requireLocalBackend(options: PrivateObjectStorageOptions): void {
  if (options.backend?.toLowerCase() === "gcs")
    throw new TypeError(
      "A private cloud object adapter is not configured in this runtime",
    );
}

export async function stagePrivateObject(
  input: {
    readonly tenantId: string;
    readonly caseId: string;
    readonly category: string;
    readonly scope?: "field-service" | "customer-files" | "messaging";
    readonly declaredContentType: string;
    readonly bytes: Uint8Array;
  },
  options: PrivateObjectStorageOptions = {},
): Promise<StagedPrivateObject> {
  requireLocalBackend(options);
  const type = contentType(input.declaredContentType);
  const definition = supported[type];
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > definition.maximum)
    throw new TypeError(
      `The file must be smaller than ${String(definition.maximum)} bytes`,
    );
  validateMagic(input.bytes, type);
  const root = storageRoot(options);
  const now = new Date();
  const storageKey = [
    safeSegment(input.tenantId, "Tenant identifier"),
    input.scope ?? "field-service",
    safeSegment(input.caseId, "Case identifier"),
    safeSegment(input.category, "Attachment category"),
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    `${randomUUID()}${definition.extension}`,
  ].join("/");
  const finalPath = confined(root, resolve(root, ...storageKey.split("/")));
  const stagedPath = confined(root, `${finalPath}.${randomUUID()}.pending`);
  await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
  const handle = await open(stagedPath, "wx", 0o600);
  try {
    await handle.writeFile(input.bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    contentType: type,
    byteSize: input.bytes.byteLength,
    checksum: createHash("sha256").update(input.bytes).digest("hex"),
    storageBackend: "local",
    storageKey,
    stagedPath,
    finalPath,
  };
}

export async function commitPrivateObject(
  staged: StagedPrivateObject,
): Promise<void> {
  await rename(staged.stagedPath, staged.finalPath);
}

export async function discardPrivateObject(
  staged: StagedPrivateObject,
): Promise<void> {
  await rm(staged.stagedPath, { force: true });
  await rm(staged.finalPath, { force: true });
}

/**
 * Remove one committed private object after its database metadata has been
 * tombstoned. Callers must commit the metadata transaction before invoking
 * this function so a database rollback can never leave a live record without
 * its file.
 */
export async function deletePrivateObject(
  storageKey: string,
  options: PrivateObjectStorageOptions = {},
): Promise<void> {
  requireLocalBackend(options);
  if (
    storageKey.includes("\\") ||
    storageKey.startsWith("/") ||
    extname(storageKey) === ""
  )
    throw new TypeError("Private object key is invalid");
  const root = storageRoot(options);
  const path = confined(root, resolve(root, ...storageKey.split("/")));
  await rm(path, { force: true });
}

export async function readPrivateObject(
  storageKey: string,
  expected: { readonly byteSize: number; readonly checksum: string },
  options: PrivateObjectStorageOptions = {},
): Promise<Uint8Array> {
  requireLocalBackend(options);
  if (
    storageKey.includes("\\") ||
    storageKey.startsWith("/") ||
    extname(storageKey) === ""
  )
    throw new TypeError("Private object key is invalid");
  const root = storageRoot(options);
  const path = confined(root, resolve(root, ...storageKey.split("/")));
  const information = await stat(path);
  if (!information.isFile() || information.size !== expected.byteSize)
    throw new TypeError(
      "Private object metadata does not match the stored file",
    );
  const bytes = await readFile(path);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (checksum !== expected.checksum)
    throw new TypeError("Private object integrity check failed");
  return bytes;
}
