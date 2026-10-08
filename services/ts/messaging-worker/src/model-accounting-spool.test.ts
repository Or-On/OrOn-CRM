import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFilesystemAccountingSpool,
  type BoundModelAttempt,
} from "./model-accounting-spool.js";

function event(): BoundModelAttempt {
  return {
    eventId: randomUUID(),
    tenantId: randomUUID(),
    jobId: randomUUID(),
    agentVersionId: randomUUID(),
    model: "gemini-2.5-flash",
    occurredAt: new Date().toISOString(),
    inputTokens: null,
    outputTokens: null,
    latencyMs: 25,
    status: "timeout",
    errorCode: "timeout",
  };
}
async function fixture(test: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "oron-accounting-"));
  try {
    await test(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
describe("durable bounded accounting metadata spool", () => {
  it("retains bounded token subsets across restart and rejects invalid accounting details", async () =>
    fixture(async (root) => {
      const attempt = {
        ...event(),
        inputTokens: 100,
        outputTokens: 20,
        tokenDetails: {
          cachedInput: 50,
          audioInput: 25,
          cachedAudioInput: null,
          reasoningOutput: 8,
          audioOutput: null,
        },
      };
      const spool = await createFilesystemAccountingSpool(root);
      await spool.put(attempt);
      expect(
        await (await createFilesystemAccountingSpool(root)).pending(),
      ).toEqual([attempt]);
      await expect(
        spool.put({
          ...attempt,
          eventId: randomUUID(),
          tokenDetails: { ...attempt.tokenDetails, reasoningOutput: 21 },
        }),
      ).rejects.toThrow("invalid provider token detail");
    }));
  it("replays completed events after a crash-left temporary file without deleting evidence", async () =>
    fixture(async (root) => {
      const attempt = event(),
        first = await createFilesystemAccountingSpool(root);
      await first.put(attempt);
      const leftover = `${randomUUID()}.${randomUUID()}.tmp`;
      await writeFile(join(root, leftover), "partial attempt metadata");
      const restarted = await createFilesystemAccountingSpool(root);
      expect(await restarted.pending()).toEqual([attempt]);
      expect(await restarted.recoveryWarnings()).toEqual([leftover]);
      await restarted.acknowledgeCommitted(attempt);
      expect(await restarted.pending()).toEqual([]);
      await expect(restarted.assertCapacity()).rejects.toThrow("recovery");
      expect(await readFile(join(root, leftover), "utf8")).toBe(
        "partial attempt metadata",
      );
    }));
  it("recovers pending attempts across instances and acknowledges exact committed data", async () =>
    fixture(async (root) => {
      const first = await createFilesystemAccountingSpool(root),
        attempt = event();
      await first.put(attempt);
      const restarted = await createFilesystemAccountingSpool(root);
      expect(await restarted.pending()).toEqual([attempt]);
      await restarted.acknowledgeCommitted(attempt);
      expect(await first.pending()).toEqual([]);
      await restarted.acknowledgeCommitted(attempt);
    }));
  it("preserves duplicate bytes, rejects changed bindings, and never persists content", async () =>
    fixture(async (root) => {
      const spool = await createFilesystemAccountingSpool(root),
        attempt = event();
      await spool.put({
        ...attempt,
        content: "private customer text",
        token: "secret",
      } as BoundModelAttempt);
      await spool.put(attempt);
      expect(
        await readFile(join(root, `${attempt.eventId}.json`), "utf8"),
      ).not.toContain("private");
      await expect(
        spool.put({ ...attempt, tenantId: randomUUID() }),
      ).rejects.toThrow("binding changed");
      await expect(
        spool.acknowledgeCommitted({ ...attempt, inputTokens: 5 }),
      ).rejects.toThrow("mismatch");
      expect(await spool.pending()).toEqual([attempt]);
    }));
  it("enforces the cap before another billed call and under concurrent inserts", async () =>
    fixture(async (root) => {
      const spool = await createFilesystemAccountingSpool(root, 1);
      const outcomes = await Promise.allSettled([
        spool.put(event()),
        spool.put(event()),
      ]);
      expect(
        outcomes.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      await expect(spool.assertCapacity()).rejects.toThrow("full");
      expect(await spool.pending()).toHaveLength(1);
    }));
  it("rejects traversal, tampering and unsafe record symlinks", async () =>
    fixture(async (root) => {
      const spool = await createFilesystemAccountingSpool(root),
        attempt = event();
      await expect(
        spool.put({ ...attempt, eventId: "../escape" }),
      ).rejects.toThrow("binding");
      await spool.put(attempt);
      await writeFile(join(root, `${attempt.eventId}.json`), "{}");
      await expect(spool.pending()).rejects.toThrow();
    }));
  it("rejects a root symlink rather than following it", async () =>
    fixture(async (root) => {
      const target = join(root, "real"),
        link = join(root, "linked");
      await createFilesystemAccountingSpool(target);
      await symlink(
        target,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(createFilesystemAccountingSpool(link)).rejects.toThrow(
        "symlink",
      );
    }));
  // Windows host lacks file-symlink privilege; directory junction denial is
  // exercised above. Run this file-symlink case on the Linux deployment CI.
  it.skipIf(process.platform === "win32")(
    "refuses an event file symlink and never reads its target",
    async () =>
      fixture(async (root) => {
        const spool = await createFilesystemAccountingSpool(root),
          attempt = event();
        const target = join(root, "outside-data");
        await writeFile(target, "private value");
        await symlink(target, join(root, `${attempt.eventId}.json`), "file");
        await expect(spool.pending()).rejects.toThrow();
        expect(await readFile(target, "utf8")).toBe("private value");
      }),
  );
  it("refuses oversized or noncanonical persisted records", async () =>
    fixture(async (root) => {
      const spool = await createFilesystemAccountingSpool(root),
        attempt = event();
      await writeFile(join(root, `${attempt.eventId}.json`), "x".repeat(2049));
      await expect(spool.pending()).rejects.toThrow("unsafe");
    }));
});
