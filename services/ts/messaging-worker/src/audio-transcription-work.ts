import type {
  AudioTranscriber,
  AudioTranscriptionProgress,
  AudioTranscriptionResult,
  AudioTranscriptionTicket,
} from "./audio-transcription.js";

export type AudioWorkPhase =
  | "new"
  | "upload_inflight"
  | "uploaded"
  | "submit_inflight"
  | "submitted"
  | "completed"
  | "failed"
  | "unknown";
export interface AudioWorkBinding {
  readonly tenantId: string;
  readonly operationId: string;
  readonly messageId: string;
  readonly objectId: string;
  readonly jobId: string;
  readonly claimToken: string;
  readonly sha256: string;
}
export interface AudioWorkRecord {
  readonly binding: AudioWorkBinding;
  readonly version: number;
  readonly phase: AudioWorkPhase;
  readonly attempts: number;
  readonly createdAt: number;
  readonly nextAttemptAt: number;
  readonly fileId?: string;
  readonly providerJobId?: string;
  readonly transcript?: string;
  readonly terminalHandled: boolean;
  readonly cleanupAttempts: number;
  readonly cleanup: "none" | "pending" | "complete" | "blocked";
}
export type AudioWorkPatch = Partial<
  Pick<
    AudioWorkRecord,
    | "phase"
    | "attempts"
    | "nextAttemptAt"
    | "fileId"
    | "providerJobId"
    | "transcript"
    | "terminalHandled"
    | "cleanup"
    | "cleanupAttempts"
  >
>;
export interface AudioWorkTransaction {
  /** Guarded DB function verifies fresh claim, message/object ownership and FORCE RLS. */
  loadOrCreate(binding: AudioWorkBinding): Promise<AudioWorkRecord>;
  /** Atomic CAS, returning incremented version; never overwrite a stale snapshot. */
  compareAndSet(
    record: AudioWorkRecord,
    patch: AudioWorkPatch,
  ): Promise<AudioWorkRecord>;
  publishTranscript(record: AudioWorkRecord, transcript: string): Promise<void>;
  /** One transaction: idempotent fallback+operator task+alert outbox keyed by operation. */
  ensureFallbackTaskAndAlert(
    record: AudioWorkRecord,
    code: string,
    fallbackText: string,
  ): Promise<void>;
}
export interface AudioWorkPorts {
  /** Must recheck DB claim token/lease AND tenant context on every transaction. */
  ownedTransaction<T>(
    binding: AudioWorkBinding,
    run: (transaction: AudioWorkTransaction) => Promise<T>,
  ): Promise<T>;
  /** Resolve the immutable, private object through server-side tenant ownership. */
  readPrivateAudio(
    binding: AudioWorkBinding,
  ): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string }>;
  readonly transcriber?: AudioTranscriber;
  /** Explicit provider cleanup port must verify terminal provider status first.
   * Never delete a file referenced by queued/processing/unknown transcription.
   */
  cleanupTerminalProviderResources?(
    ticket: AudioTranscriptionTicket,
  ): Promise<"complete" | "pending" | "blocked">;
  readonly now?: () => number;
}
export type AudioWorkOutcome =
  | { readonly kind: "rescheduled"; readonly availableAt: number }
  | {
      readonly kind: "completed" | "terminal";
      readonly cleanup: AudioWorkRecord["cleanup"];
    };
const FALLBACK =
  "קיבלתי את ההודעה הקולית, אבל לא הצלחתי לתמלל אותה כרגע. אפשר לשלוח את הבקשה בטקסט?";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function sameBinding(left: AudioWorkBinding, right: AudioWorkBinding): boolean {
  return [
    "tenantId",
    "operationId",
    "messageId",
    "objectId",
    "jobId",
    "sha256",
  ].every(
    (key) =>
      left[key as keyof AudioWorkBinding] ===
      right[key as keyof AudioWorkBinding],
  );
}
function ticket(record: AudioWorkRecord): AudioTranscriptionTicket | undefined {
  return record.fileId === undefined || record.providerJobId === undefined
    ? undefined
    : {
        operationId: record.binding.operationId,
        fileId: record.fileId,
        providerJobId: record.providerJobId,
      };
}

/** One durable worker step. No provider request/byte read is made inside a DB
 * transaction. Caller reschedules the SAME job and preserves unknown POST state.
 * Configuration absence is terminal fallback+task+alert, never endless retries.
 */
export async function runAudioTranscriptionWork(
  binding: AudioWorkBinding,
  ports: AudioWorkPorts,
  limits: { readonly maxAttempts?: number; readonly maxAgeMs?: number } = {},
): Promise<AudioWorkOutcome> {
  for (const key of [
    binding.tenantId,
    binding.operationId,
    binding.messageId,
    binding.objectId,
    binding.jobId,
    binding.claimToken,
  ]) {
    if (!UUID.test(key))
      throw new TypeError("Invalid server audio-work identity");
  }
  if (!/^[a-f0-9]{64}$/u.test(binding.sha256))
    throw new TypeError("Invalid server audio hash");
  const maxAttempts = limits.maxAttempts ?? 8,
    maxAgeMs = limits.maxAgeMs ?? 90_000;
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 20 ||
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs < 1 ||
    maxAgeMs > 120_000
  )
    throw new TypeError("Invalid bounded audio-work policy");
  const now = ports.now ?? Date.now;
  let record = await ports.ownedTransaction(binding, (tx) =>
    tx.loadOrCreate(binding),
  );
  if (!sameBinding(record.binding, binding))
    throw new Error("Audio-work immutable binding conflict");
  const persist = async (patch: AudioWorkPatch): Promise<void> => {
    record = await ports.ownedTransaction(binding, (tx) =>
      tx.compareAndSet(record, patch),
    );
  };
  const guard = async (): Promise<void> => {
    await ports.ownedTransaction(binding, async (tx) => {
      const current = await tx.loadOrCreate(binding);
      if (
        !sameBinding(current.binding, binding) ||
        current.version !== record.version
      )
        throw new Error("Audio-work ownership or version lost");
    });
  };
  const terminal = async (
    phase: "failed" | "unknown",
    code: string,
  ): Promise<AudioWorkOutcome> => {
    record = await ports.ownedTransaction(binding, async (tx) => {
      await tx.ensureFallbackTaskAndAlert(record, code, FALLBACK);
      return tx.compareAndSet(record, {
        phase,
        terminalHandled: true,
        cleanup: phase === "unknown" ? "blocked" : "pending",
      });
    });
    return finishCleanup("terminal");
  };
  const finishCleanup = async (
    kind: "completed" | "terminal",
  ): Promise<AudioWorkOutcome> => {
    if (record.cleanup === "complete" || record.cleanup === "blocked")
      return { kind, cleanup: record.cleanup };
    if (record.nextAttemptAt > now())
      return { kind: "rescheduled", availableAt: record.nextAttemptAt };
    const known = ticket(record);
    if (
      known === undefined ||
      ports.cleanupTerminalProviderResources === undefined ||
      record.cleanupAttempts >= 3
    ) {
      await persist({ cleanup: "blocked" });
      return { kind, cleanup: "blocked" };
    }
    await persist({ cleanupAttempts: record.cleanupAttempts + 1 });
    await guard();
    let cleanup: "complete" | "pending" | "blocked";
    try {
      cleanup = await ports.cleanupTerminalProviderResources(known);
    } catch {
      cleanup = "pending";
    }
    await persist({ cleanup });
    if (cleanup === "pending" && record.cleanupAttempts < 3) {
      const availableAt = now() + 5_000;
      await persist({ nextAttemptAt: availableAt });
      return { kind: "rescheduled", availableAt };
    }
    if (cleanup === "pending") {
      await persist({ cleanup: "blocked" });
      return { kind, cleanup: "blocked" };
    }
    return { kind, cleanup };
  };
  if (record.phase === "completed") return finishCleanup("completed");
  if (record.phase === "unknown" || record.phase === "failed") {
    if (!record.terminalHandled)
      return terminal(record.phase, "audio_previous_failure");
    return finishCleanup("terminal");
  }
  if (record.phase === "upload_inflight" || record.phase === "submit_inflight")
    return terminal("unknown", "audio_submission_outcome_unknown");
  if (record.attempts >= maxAttempts || now() - record.createdAt >= maxAgeMs)
    return terminal("failed", "audio_retry_budget_exhausted");
  if (ports.transcriber === undefined)
    return terminal("failed", "audio_transcriber_not_configured");
  if (record.nextAttemptAt > now())
    return { kind: "rescheduled", availableAt: record.nextAttemptAt };
  await persist({ attempts: record.attempts + 1 });
  let result: AudioTranscriptionResult;
  if (record.phase === "submitted") {
    const known = ticket(record);
    if (known === undefined) return terminal("unknown", "audio_ticket_missing");
    result = await ports.transcriber.poll(known, guard);
  } else {
    await guard();
    let audio;
    try {
      audio = await ports.readPrivateAudio(binding);
    } catch {
      return terminal("failed", "audio_private_object_unavailable");
    }
    const checkpoint = async (
      progress: AudioTranscriptionProgress,
    ): Promise<void> => {
      const expected: Readonly<
        Record<AudioTranscriptionProgress["phase"], AudioWorkPhase>
      > = {
        upload_inflight: "new",
        uploaded: "upload_inflight",
        submit_inflight: "uploaded",
        submitted: "submit_inflight",
      };
      if (record.phase !== expected[progress.phase])
        throw new Error("Audio mutation checkpoint replay denied");
      if (progress.phase === "submitted")
        await persist({
          phase: "submitted",
          fileId: progress.ticket.fileId,
          providerJobId: progress.ticket.providerJobId,
        });
      else
        await persist({
          phase: progress.phase,
          ...("fileId" in progress ? { fileId: progress.fileId } : {}),
        });
    };
    result = await ports.transcriber.start({
      operationId: binding.operationId,
      bytes: audio.bytes,
      mimeType: audio.mimeType,
      sha256: binding.sha256,
      checkpoint,
      beforeAttempt: guard,
      ...(record.fileId === undefined ? {} : { uploadedFileId: record.fileId }),
    });
  }
  if (result.kind === "failed" || result.kind === "unknown") {
    if (result.fileId !== undefined || result.ticket !== undefined)
      await persist({
        ...(result.fileId === undefined ? {} : { fileId: result.fileId }),
        ...(result.ticket === undefined
          ? {}
          : {
              fileId: result.ticket.fileId,
              providerJobId: result.ticket.providerJobId,
            }),
      });
    return terminal(result.kind, result.code);
  }
  if (result.kind === "completed") {
    record = await ports.ownedTransaction(binding, async (tx) => {
      await tx.publishTranscript(record, result.text);
      return tx.compareAndSet(record, {
        phase: "completed",
        transcript: result.text,
        fileId: result.ticket.fileId,
        providerJobId: result.ticket.providerJobId,
        terminalHandled: true,
        cleanup: "pending",
      });
    });
    return finishCleanup("completed");
  }
  switch (result.kind) {
    case "pending":
    case "retry":
      break;
    default:
      throw new Error("Unexpected audio transcription outcome");
  }
  const availableAt =
    now() + Math.min(60_000, Math.max(1_000, result.retryAfterMs));
  if (
    availableAt - record.createdAt >= maxAgeMs ||
    record.attempts >= maxAttempts
  )
    return terminal("failed", "audio_retry_budget_exhausted");
  if (result.kind === "pending")
    await persist({
      phase: "submitted",
      fileId: result.ticket.fileId,
      providerJobId: result.ticket.providerJobId,
      nextAttemptAt: availableAt,
    });
  else
    await persist({
      phase:
        result.phase === "upload"
          ? "new"
          : result.phase === "submit"
            ? "uploaded"
            : "submitted",
      nextAttemptAt: availableAt,
    });
  return { kind: "rescheduled", availableAt };
}
