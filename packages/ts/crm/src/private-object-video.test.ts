import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validatePrivateMp4 } from "./private-object-video.js";
import {
  commitPrivateObject,
  discardPrivateObject,
  readPrivateObject,
  stagePrivateObject,
} from "./private-object-storage.js";
const fixture = readFileSync(
  new URL("./fixtures/customer-video.mp4", import.meta.url),
);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const corrupt = (mutate: (bytes: Buffer) => void) => {
  const bytes = Buffer.from(fixture);
  mutate(bytes);
  return bytes;
};
describe("bounded private native-encoded MP4", () => {
  it("accepts actual native-encoded H264 with AAC-LC and denies HE-AAC", () => {
    const bytes = readFileSync(
      new URL("./fixtures/customer-video-aac.mp4", import.meta.url),
    );
    expect(() => validatePrivateMp4(bytes)).not.toThrow();
    const altered = Buffer.from(bytes);
    const config = altered.indexOf(Buffer.from([5, 128, 128, 128, 2]));
    expect(config).toBeGreaterThan(0);
    altered.writeUInt16BE(0x2990, config + 5);
    expect(() => validatePrivateMp4(altered)).toThrow("AAC-LC");
  });

  it("stores the complete real H264 file privately and verifies bytes and checksum", async () => {
    const root = await mkdtemp(join(tmpdir(), "oron-video-"));
    roots.push(root);
    const object = await stagePrivateObject(
      {
        tenantId: "synthetic-tenant",
        caseId: "synthetic-conversation",
        scope: "messaging",
        category: "whatsapp-video",
        declaredContentType: "video/mp4",
        bytes: fixture,
      },
      { localRoot: root },
    );
    expect(object.storageKey).toMatch(
      /^synthetic-tenant\/messaging\/.*\.mp4$/u,
    );
    await commitPrivateObject(object);
    expect(
      Buffer.from(
        await readPrivateObject(object.storageKey, object, { localRoot: root }),
      ),
    ).toEqual(fixture);
    await discardPrivateObject(object);
  });
  it.each([
    ["truncation", () => fixture.subarray(0, fixture.length - 1)],
    ["signature only", () => fixture.subarray(0, 32)],
    ["oversize", () => Buffer.alloc(16 * 1024 * 1024 + 1)],
    [
      "HEVC codec",
      () => corrupt((b) => b.write("hvc1", b.indexOf("avc1", 40))),
    ],
    [
      "encrypted codec",
      () => corrupt((b) => b.write("encv", b.indexOf("avc1", 40))),
    ],
    [
      "external URL reference",
      () => corrupt((b) => b.writeUInt32BE(0, b.indexOf("url ") + 4)),
    ],
    [
      "sample outside mdat",
      () => corrupt((b) => b.writeUInt32BE(0, b.indexOf("stco") + 12)),
    ],
    [
      "sample count allocation",
      () => corrupt((b) => b.writeUInt32BE(0xffffffff, b.indexOf("stsz") + 12)),
    ],
    [
      "duration limit",
      () => corrupt((b) => b.writeUInt32BE(181000, b.indexOf("mdhd") + 20)),
    ],
    [
      "forged dimensions",
      () => corrupt((b) => b.writeUInt16BE(640, b.indexOf("avc1", 40) + 28)),
    ],
    [
      "truncated NAL",
      () => corrupt((b) => b.writeUInt32BE(0xffffffff, b.indexOf("mdat") + 4)),
    ],
    [
      "fragmented movie",
      () =>
        Buffer.concat([fixture, Buffer.from([0, 0, 0, 8, 109, 111, 111, 102])]),
    ],
  ] as const)("rejects %s", (_label, bytes) => {
    expect(() => validatePrivateMp4(bytes())).toThrow(TypeError);
  });
  it("rejects declarations, tenant traversal, and corrupted stored bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "oron-video-"));
    roots.push(root);
    const input = {
      tenantId: "synthetic-tenant",
      caseId: "synthetic-conversation",
      scope: "messaging" as const,
      category: "whatsapp-video",
      declaredContentType: "video/mp4",
      bytes: fixture,
    };
    await expect(
      stagePrivateObject(
        { ...input, declaredContentType: "video/quicktime" },
        { localRoot: root },
      ),
    ).rejects.toThrow("Use a");
    await expect(
      stagePrivateObject(
        { ...input, tenantId: "../foreign" },
        { localRoot: root },
      ),
    ).rejects.toThrow("identifier");
    const object = await stagePrivateObject(input, { localRoot: root });
    await commitPrivateObject(object);
    await expect(
      readPrivateObject(
        object.storageKey,
        { ...object, checksum: "forged" },
        { localRoot: root },
      ),
    ).rejects.toThrow("integrity");
  });
});
