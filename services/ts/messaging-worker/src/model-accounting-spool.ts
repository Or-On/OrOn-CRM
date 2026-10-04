import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  link,
  unlink,
} from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";
import type { WhatsAppAiAttempt } from "./ai-provider.js";

export interface BoundModelAttempt extends WhatsAppAiAttempt {
  readonly tenantId: string;
  readonly jobId: string;
  readonly agentVersionId: string;
}
export interface ModelAccountingSpool {
  assertCapacity(): Promise<void>;
  put(attempt: BoundModelAttempt): Promise<void>;
  pending(): Promise<readonly BoundModelAttempt[]>;
  recoveryWarnings(): Promise<readonly string[]>;
  /** Call only after the accounting transaction has committed. */
  acknowledgeCommitted(attempt: BoundModelAttempt): Promise<void>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const maximumBytes = 2048;
const processLocks = new Map<string, Promise<unknown>>();

function canonical(value: BoundModelAttempt): string {
  for (const id of [
    value.eventId,
    value.tenantId,
    value.jobId,
    value.agentVersionId,
  ])
    if (typeof id !== "string" || !uuid.test(id))
      throw new TypeError("invalid accounting binding");
  if (
    typeof value.model !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value.model) ||
    typeof value.occurredAt !== "string" ||
    !Number.isFinite(Date.parse(value.occurredAt)) ||
    value.occurredAt.length > 40 ||
    !Number.isSafeInteger(value.latencyMs) ||
    value.latencyMs < 0 ||
    value.latencyMs > 2147483647 ||
    !["succeeded", "http_error", "timeout", "invalid_response"].includes(
      value.status,
    ) ||
    (value.errorCode !== null &&
      (typeof value.errorCode !== "string" ||
        !/^[a-zA-Z0-9_.-]{1,80}$/u.test(value.errorCode)))
  )
    throw new TypeError("invalid accounting metadata");
  for (const count of [value.inputTokens, value.outputTokens])
    if (count !== null && (!Number.isSafeInteger(count) || count < 0))
      throw new TypeError("invalid provider token count");
  // Explicit projection prevents request content, credentials or arbitrary extras
  // from being persisted even when a dynamically typed caller supplies them.
  return JSON.stringify({
    eventId: value.eventId,
    tenantId: value.tenantId,
    jobId: value.jobId,
    agentVersionId: value.agentVersionId,
    model: value.model,
    occurredAt: value.occurredAt,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    latencyMs: value.latencyMs,
    status: value.status,
    errorCode: value.errorCode,
  });
}

/** Dedicated directory within the configured persistent private-object volume.
 * Deployment must designate one writer process. Same-process instances share a
 * mutex; exclusive hard-link publication cannot overwrite another event.
 * Cross-process aggregate capacity is deliberately not claimed.
 */
export async function createFilesystemAccountingSpool(
  directory: string,
  maximumEntries = 1000,
): Promise<ModelAccountingSpool> {
  if (
    !directory.trim() ||
    !isAbsolute(directory) ||
    resolve(directory) === parse(resolve(directory)).root
  )
    throw new TypeError("explicit dedicated absolute spool directory required");
  if (
    !Number.isInteger(maximumEntries) ||
    maximumEntries < 1 ||
    maximumEntries > 1000
  )
    throw new TypeError("accounting capacity must be 1-1000");
  const root = resolve(directory);
  // Reject existing symlinks in every ancestor; no recursive symlink traversal.
  for (let path = root; ; path = resolve(path, "..")) {
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new Error("spool symlink denied");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    if (path === parse(path).root) break;
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const identity = await realpath(root);
  const guard = async () => {
    if (
      (await lstat(root)).isSymbolicLink() ||
      (await realpath(root)) !== identity
    )
      throw new Error("spool root changed");
  };
  const locked = <T>(action: () => Promise<T>): Promise<T> => {
    const next = (processLocks.get(identity) ?? Promise.resolve()).then(
      async () => {
        await guard();
        return await action();
      },
    );
    processLocks.set(
      identity,
      next.catch(() => undefined),
    );
    return next;
  };
  const temporaryName = /^[0-9a-f-]{36}\.[0-9a-f-]{36}\.tmp$/u;
  const warnings = async () =>
    (await readdir(root)).filter((entry) => temporaryName.test(entry));
  const files = async () => {
    const entries = await readdir(root);
    const records: string[] = [];
    for (const entry of entries) {
      if (temporaryName.test(entry)) continue;
      if (
        !/^[0-9a-f-]{36}\.json$/u.test(entry) ||
        !uuid.test(entry.slice(0, -5))
      )
        throw new Error("unexpected accounting spool entry");
      records.push(entry);
    }
    if (records.length > maximumEntries)
      throw new Error("accounting spool capacity exceeded");
    return records.sort();
  };
  const read = async (filename: string): Promise<string> => {
    const path = resolve(root, filename);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > maximumBytes)
      throw new Error("unsafe accounting record");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
  };
  const syncDirectory = async () => {
    // Windows does not support opening a directory for fsync; file sync remains
    // mandatory. Linux persistent-volume deployment fsyncs both file and rename.
    if (process.platform === "win32") return;
    const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  return {
    assertCapacity: () =>
      locked(async () => {
        if ((await warnings()).length)
          throw new Error("accounting spool requires temporary-file recovery");
        if ((await files()).length >= maximumEntries)
          throw new Error("accounting spool full");
      }),
    put: (attempt) =>
      locked(async () => {
        const bytes = canonical(attempt),
          filename = `${attempt.eventId}.json`;
        const present = await files();
        if (present.includes(filename)) {
          if ((await read(filename)) !== bytes)
            throw new Error("accounting event binding changed");
          return;
        }
        if ((await warnings()).length)
          throw new Error("accounting spool requires temporary-file recovery");
        if (present.length >= maximumEntries)
          throw new Error("accounting spool full");
        const temporary = resolve(
          root,
          `${attempt.eventId}.${randomUUID()}.tmp`,
        );
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(bytes, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await link(temporary, resolve(root, filename));
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          ))
            throw error;
          if ((await read(filename)) !== bytes)
            throw new Error("accounting event binding changed", {
              cause: error,
            });
        }
        await unlink(temporary);
        await syncDirectory();
      }),
    pending: () =>
      locked(async () => {
        const result: BoundModelAttempt[] = [];
        for (const filename of await files()) {
          const bytes = await read(filename);
          const attempt = JSON.parse(bytes) as BoundModelAttempt;
          if (
            `${attempt.eventId}.json` !== filename ||
            canonical(attempt) !== bytes
          )
            throw new Error("accounting record tampered");
          result.push(attempt);
        }
        return result;
      }),
    recoveryWarnings: () => locked(warnings),
    acknowledgeCommitted: (attempt) =>
      locked(async () => {
        const bytes = canonical(attempt),
          filename = `${attempt.eventId}.json`;
        if (!(await files()).includes(filename)) return;
        if ((await read(filename)) !== bytes)
          throw new Error("accounting acknowledgement mismatch");
        await unlink(resolve(root, filename));
        await syncDirectory();
      }),
  };
}
