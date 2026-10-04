import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  stagePrivateObject,
  discardPrivateObject,
} from "./private-object-storage.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF");
  bytes.writeUInt32LE(40, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(4, 40);
  return bytes;
}
function checksumPage(page: Buffer): void {
  page.writeUInt32LE(0, 22);
  let crc = 0;
  for (const byte of page) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit += 1)
      crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  page.writeUInt32LE(crc >>> 0, 22);
}
function ogg() {
  const head = Buffer.alloc(19);
  head.write("OpusHead");
  head[8] = 1;
  head[9] = 1;
  const tags = Buffer.alloc(16);
  tags.write("OpusTags");
  return Buffer.concat(
    [head, tags, Buffer.from([0xf8, 0xff, 0xfe])].map((packet, index) => {
      const page = Buffer.alloc(28 + packet.length);
      page.write("OggS");
      page[5] = index === 0 ? 2 : index === 2 ? 4 : 0;
      page.writeUInt32LE(10, 14);
      page.writeUInt32LE(index, 18);
      page[26] = 1;
      page[27] = packet.length;
      packet.copy(page, 28);
      checksumPage(page);
      return page;
    }),
  );
}
async function stage(
  bytes: Uint8Array,
  declaredContentType: string,
  tenantId = "synthetic-tenant",
) {
  const root = await mkdtemp(join(tmpdir(), "oron-audio-test-"));
  roots.push(root);
  return stagePrivateObject(
    {
      tenantId,
      caseId: "synthetic-case",
      category: "voice-note",
      scope: "messaging",
      declaredContentType,
      bytes,
    },
    { localRoot: root },
  );
}
describe("bounded private audio", () => {
  it("preserves existing image and PDF validation", async () => {
    await expect(
      stage(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg"),
    ).rejects.toThrow("incomplete");
    await expect(
      stage(Buffer.from("%PDF-1.7\ntruncated"), "application/pdf"),
    ).rejects.toThrow("incomplete");
    const text = await stage(Buffer.from("synthetic safe note"), "text/plain");
    expect(text.contentType).toBe("text/plain");
    await discardPrivateObject(text);
  });
  it.each([
    ["audio/wav", wav],
    ["audio/ogg; codecs=opus", ogg],
  ] as const)("stages structurally valid %s", async (type, fixture) => {
    const object = await stage(fixture(), type);
    expect(object.contentType).toBe(type.split(";")[0]);
    expect(object.storageKey).toContain("synthetic-tenant/messaging/");
    await discardPrivateObject(object);
  });
  it("rejects MIME mismatch and unsupported codecs", async () => {
    await expect(stage(wav(), "audio/ogg")).rejects.toThrow("declared type");
    await expect(stage(ogg(), "audio/mpeg")).rejects.toThrow("Use a");
    const invalid = ogg();
    invalid.write("vorbis!!", 28);
    checksumPage(invalid.subarray(0, 47));
    await expect(stage(invalid, "audio/ogg")).rejects.toThrow("Opus");
  });
  it("rejects truncation, missing EOS and invalid PCM alignment", async () => {
    await expect(stage(ogg().subarray(0, -1), "audio/ogg")).rejects.toThrow(
      "incomplete",
    );
    const noEnd = ogg();
    noEnd[noEnd.length - 31 + 5] = 0;
    checksumPage(noEnd.subarray(noEnd.length - 31));
    await expect(stage(noEnd, "audio/ogg")).rejects.toThrow("incomplete");
    const bad = wav();
    bad.writeUInt16LE(1, 32);
    await expect(stage(bad, "audio/wav")).rejects.toThrow("format");
    await expect(stage(wav().subarray(0, -1), "audio/wav")).rejects.toThrow(
      "length",
    );
  });
  it("rejects corrupted Ogg page checksum", async () => {
    const invalid = ogg();
    invalid[invalid.length - 1] = (invalid[invalid.length - 1] ?? 0) ^ 1;
    await expect(stage(invalid, "audio/ogg")).rejects.toThrow("checksum");
  });
  it("rejects oversized audio before parsing and confines tenant paths", async () => {
    await expect(
      stage(new Uint8Array(16 * 1024 * 1024 + 1), "audio/ogg"),
    ).rejects.toThrow("smaller");
    await expect(stage(wav(), "audio/wav", "../other")).rejects.toThrow(
      "Tenant identifier",
    );
  });
});
