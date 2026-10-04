import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { validatePrivateImage } from "./private-object-storage.js";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, bytes: Buffer) {
  const length = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const payload = Buffer.concat([Buffer.from(type), bytes]);
  checksum.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, checksum]);
}
function png(width: number, height: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc(32 * (32 * 3 + 1)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
describe("pure identity image validation", () => {
  it("accepts a complete synthetic PNG without storage side effects", () => {
    expect(() => validatePrivateImage(png(32, 32), "image/png")).not.toThrow();
  });
  it.each([
    ["image/png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
    ["image/jpeg", Buffer.from([255, 216, 255])],
    ["image/webp", Buffer.from("RIFF0000WEBP")],
  ] as const)("rejects a truncated %s container", (type, bytes) => {
    expect(() => validatePrivateImage(bytes, type)).toThrow(TypeError);
  });
  it.each([
    [1, 32],
    [32, 1],
    [16385, 32],
    [10000, 10000],
  ])("retains dimension and pixel limits for %s × %s", (width, height) =>
    expect(() => validatePrivateImage(png(width, height), "image/png")).toThrow(
      TypeError,
    ),
  );
  it("rejects bytes declared as another image type", () => {
    expect(() => validatePrivateImage(png(32, 32), "image/jpeg")).toThrow(
      TypeError,
    );
  });
});
