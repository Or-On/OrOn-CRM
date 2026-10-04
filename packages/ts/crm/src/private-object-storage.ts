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

import { validatePrivateMp4 } from "./private-object-video.js";

const supported = {
  "video/mp4": { extension: ".mp4", maximum: 16 * 1024 * 1024 },
  "image/jpeg": { extension: ".jpg", maximum: 12 * 1024 * 1024 },
  "image/png": { extension: ".png", maximum: 12 * 1024 * 1024 },
  "image/webp": { extension: ".webp", maximum: 12 * 1024 * 1024 },
  "application/pdf": { extension: ".pdf", maximum: 20 * 1024 * 1024 },
  "text/plain": { extension: ".txt", maximum: 2 * 1024 * 1024 },
  "audio/ogg": { extension: ".ogg", maximum: 16 * 1024 * 1024 },
  "audio/wav": { extension: ".wav", maximum: 16 * 1024 * 1024 },
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
    throw new TypeError(
      "Use a JPEG, PNG, WebP, PDF, plain-text, Ogg Opus, PCM WAV, or H.264 MP4 file",
    );
  return normalized as PrivateObjectContentType;
}

const maximumImageDimension = 16_384;
const maximumImagePixels = 40_000_000;
const minimumImageDimension = 16;

function assertImageDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < minimumImageDimension ||
    height < minimumImageDimension
  )
    throw new TypeError("Image must be at least 16 by 16 pixels");
  if (
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

function validateWav(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 44 || view.getUint32(4, true) + 8 !== bytes.length)
    throw new TypeError("The WAV container length is invalid");
  let offset = 12;
  let alignment = 0;
  let sawData = false;
  while (offset + 8 <= bytes.length) {
    const type = Buffer.from(bytes.subarray(offset, offset + 4)).toString(
      "ascii",
    );
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) throw new TypeError("The WAV chunk is incomplete");
    if (type === "fmt ") {
      if (alignment !== 0 || length !== 16 || view.getUint16(start, true) !== 1)
        throw new TypeError("Only canonical PCM WAV is supported");
      const channels = view.getUint16(start + 2, true);
      const sampleRate = view.getUint32(start + 4, true);
      const bits = view.getUint16(start + 14, true);
      alignment = (channels * bits) / 8;
      if (
        ![1, 2].includes(channels) ||
        ![8, 16, 24, 32].includes(bits) ||
        sampleRate < 8000 ||
        sampleRate > 192000 ||
        view.getUint16(start + 12, true) !== alignment ||
        view.getUint32(start + 8, true) !== sampleRate * alignment
      )
        throw new TypeError("The WAV PCM format is invalid");
    } else if (type === "data") {
      if (!alignment || sawData || length === 0 || length % alignment !== 0)
        throw new TypeError("The WAV sample data is invalid");
      sawData = true;
    }
    offset = end + (length % 2);
  }
  if (offset !== bytes.length || !sawData)
    throw new TypeError("The WAV file is incomplete");
}

const oggCrcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index << 24;
  for (let bit = 0; bit < 8; bit += 1)
    value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1;
  return value >>> 0;
});

function validateOggOpus(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let serial: number | undefined;
  let sequence = 0;
  let partial: number[] = [];
  let packets = 0;
  let ended = false;
  while (offset < bytes.length) {
    if (
      ended ||
      offset + 27 > bytes.length ||
      Buffer.from(bytes.subarray(offset, offset + 4)).toString("ascii") !==
        "OggS" ||
      bytes[offset + 4] !== 0
    )
      throw new TypeError("The Ogg page header is invalid");
    const flags = bytes[offset + 5] ?? 0;
    const segments = bytes[offset + 26] ?? 0;
    if (flags > 7 || offset + 27 + segments > bytes.length)
      throw new TypeError("The Ogg segment table is incomplete");
    const pageSerial = view.getUint32(offset + 14, true);
    serial ??= pageSerial;
    if (
      pageSerial !== serial ||
      view.getUint32(offset + 18, true) !== sequence ||
      Boolean(flags & 2) !== (sequence === 0) ||
      Boolean(flags & 1) !== partial.length > 0
    )
      throw new TypeError("The Ogg stream sequence is invalid");
    let body = offset + 27 + segments;
    const lengths = bytes.subarray(offset + 27, body);
    const end = body + lengths.reduce((sum, length) => sum + length, 0);
    if (end > bytes.length)
      throw new TypeError("The Ogg page body is incomplete");
    let crc = 0;
    for (let index = offset; index < end; index += 1) {
      const byte =
        index >= offset + 22 && index < offset + 26 ? 0 : (bytes[index] ?? 0);
      crc =
        ((crc << 8) ^ (oggCrcTable[((crc >>> 24) ^ byte) & 0xff] ?? 0)) >>> 0;
    }
    if (crc !== view.getUint32(offset + 22, true))
      throw new TypeError("The Ogg page checksum is invalid");
    for (const length of lengths) {
      for (const byte of bytes.subarray(body, body + length))
        partial.push(byte);
      body += length;
      if (partial.length > 65536)
        throw new TypeError("The Opus packet exceeds the safety limit");
      if (length < 255) {
        const packet = Buffer.from(partial);
        if (
          packets === 0 &&
          (packet.length !== 19 ||
            packet.toString("ascii", 0, 8) !== "OpusHead" ||
            packet[8] !== 1 ||
            ![1, 2].includes(packet[9] ?? 0) ||
            packet[18] !== 0)
        )
          throw new TypeError("Only mono/stereo Ogg Opus is supported");
        if (
          packets === 1 &&
          (packet.length < 16 || packet.toString("ascii", 0, 8) !== "OpusTags")
        )
          throw new TypeError("The Opus tags packet is invalid");
        if (packets === 1) {
          let tagOffset = 12 + packet.readUInt32LE(8);
          if (tagOffset + 4 > packet.length)
            throw new TypeError("The Opus vendor tag is incomplete");
          const count = packet.readUInt32LE(tagOffset);
          tagOffset += 4;
          if (count > 4096)
            throw new TypeError("The Opus tags exceed the safety limit");
          for (let index = 0; index < count; index += 1) {
            if (tagOffset + 4 > packet.length)
              throw new TypeError("The Opus comment is incomplete");
            const length = packet.readUInt32LE(tagOffset);
            tagOffset += 4 + length;
            if (tagOffset > packet.length)
              throw new TypeError("The Opus comment is incomplete");
          }
        }
        if (packets > 1 && packet.length === 0)
          throw new TypeError("The Opus audio packet is empty");
        packets += 1;
        partial = [];
      }
    }
    ended = Boolean(flags & 4);
    offset = end;
    sequence += 1;
  }
  if (!ended || partial.length || packets < 3)
    throw new TypeError("The Ogg Opus stream is incomplete");
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
    (type === "video/mp4" && ascii(4, 8) === "ftyp") ||
    (type === "audio/ogg" && ascii(0, 4) === "OggS") ||
    (type === "audio/wav" &&
      ascii(0, 4) === "RIFF" &&
      ascii(8, 12) === "WAVE") ||
    (type === "text/plain" && !bytes.includes(0));
  if (!valid)
    throw new TypeError("The file contents do not match its declared type");
  if (type === "video/mp4") validatePrivateMp4(bytes);
  else if (type === "image/png") validatePng(bytes);
  else if (type === "image/jpeg") validateJpeg(bytes);
  else if (type === "image/webp") validateWebp(bytes);
  else if (type === "audio/ogg") validateOggOpus(bytes);
  else if (type === "audio/wav") validateWav(bytes);
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

/** Validate an identity image without creating or staging a stored object. */
export function validatePrivateImage(
  bytes: Uint8Array,
  type: "image/png" | "image/jpeg" | "image/webp",
): void {
  if (!["image/png", "image/jpeg", "image/webp"].includes(type))
    throw new TypeError("Choose a PNG, JPEG or WebP image");
  validateMagic(bytes, type);
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
  const scope = input.scope ?? "field-service";
  if (!["field-service", "customer-files", "messaging"].includes(scope))
    throw new TypeError("Private object scope is invalid");
  if (type === "video/mp4" && scope !== "messaging")
    throw new TypeError("MP4 video storage is supported for messaging only");
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
    scope,
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
