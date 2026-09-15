import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  commitPrivateObject,
  deletePrivateObject,
  readPrivateObject,
  stagePrivateObject,
} from "./private-objects";

const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

describe("field-service private object storage", () => {
  let root = "";
  const previousRoot = process.env.ARTIFACTS_LOCAL_ROOT;
  const previousBackend = process.env.ARTIFACTS_BACKEND;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "or-on-field-service-"));
    process.env.ARTIFACTS_LOCAL_ROOT = root;
    process.env.ARTIFACTS_BACKEND = "local";
  });

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env.ARTIFACTS_LOCAL_ROOT;
    else process.env.ARTIFACTS_LOCAL_ROOT = previousRoot;
    if (previousBackend === undefined) delete process.env.ARTIFACTS_BACKEND;
    else process.env.ARTIFACTS_BACKEND = previousBackend;
    await rm(root, { force: true, recursive: true });
  });

  it("stores an authenticated object under a generated tenant-scoped key", async () => {
    const staged = await stagePrivateObject({
      tenantId: "00000000-0000-4000-8000-000000000001",
      caseId: "00000000-0000-4000-8000-000000000002",
      category: "fault_photo",
      declaredContentType: "image/png",
      bytes: png,
    });
    expect(staged.storageKey).toContain(
      "00000000-0000-4000-8000-000000000001/field-service/",
    );
    await commitPrivateObject(staged);
    const restored = await readPrivateObject(staged.storageKey, {
      byteSize: staged.byteSize,
      checksum: staged.checksum,
    });
    expect(Array.from(restored)).toEqual(Array.from(png));
  });

  it("rejects declared MIME mismatches and detects later tampering", async () => {
    await expect(
      stagePrivateObject({
        tenantId: "tenant",
        caseId: "case",
        category: "fault_photo",
        declaredContentType: "image/jpeg",
        bytes: png,
      }),
    ).rejects.toThrow(/do not match/u);

    const staged = await stagePrivateObject({
      tenantId: "tenant",
      caseId: "case",
      category: "fault_photo",
      declaredContentType: "image/png",
      bytes: png,
    });
    await commitPrivateObject(staged);
    await writeFile(staged.finalPath, Buffer.from("tampered"));
    await expect(
      readPrivateObject(staged.storageKey, {
        byteSize: Buffer.byteLength("tampered"),
        checksum: staged.checksum,
      }),
    ).rejects.toThrow(/integrity/u);
  });

  it("rejects truncated images and unsafe decoded dimensions", async () => {
    await expect(
      stagePrivateObject({
        tenantId: "tenant",
        caseId: "case",
        category: "fault_photo",
        declaredContentType: "image/png",
        bytes: png.subarray(0, 12),
      }),
    ).rejects.toThrow(/incomplete/u);

    const oversized = Uint8Array.from(png);
    new DataView(oversized.buffer).setUint32(16, 20_000);
    await expect(
      stagePrivateObject({
        tenantId: "tenant",
        caseId: "case",
        category: "fault_photo",
        declaredContentType: "image/png",
        bytes: oversized,
      }),
    ).rejects.toThrow(/dimensions/u);
  });

  it("rejects traversal keys", async () => {
    await expect(
      readPrivateObject("../outside.txt", { byteSize: 1, checksum: "x" }),
    ).rejects.toThrow(/escaped|invalid/u);
  });

  it("removes only a committed object inside the configured private root", async () => {
    const staged = await stagePrivateObject({
      tenantId: "tenant",
      caseId: "conversation",
      category: "whatsapp_media",
      scope: "messaging",
      declaredContentType: "image/png",
      bytes: png,
    });
    await commitPrivateObject(staged);

    await deletePrivateObject(staged.storageKey);

    await expect(
      readPrivateObject(staged.storageKey, {
        byteSize: staged.byteSize,
        checksum: staged.checksum,
      }),
    ).rejects.toThrow();
    await expect(deletePrivateObject("../outside.jpg")).rejects.toThrow(
      /escaped|invalid/u,
    );
  });
});
