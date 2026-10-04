import type postgres from "postgres";
import type {
  AudioWorkBinding,
  AudioWorkPatch,
  AudioWorkRecord,
  AudioWorkTransaction,
} from "./audio-transcription-work.js";

export interface AudioWorkBusinessHooks {
  publishTranscript(
    tx: postgres.TransactionSql,
    record: AudioWorkRecord,
    text: string,
  ): Promise<void>;
  ensureFallbackTaskAndAlert(
    tx: postgres.TransactionSql,
    record: AudioWorkRecord,
    code: string,
    text: string,
  ): Promise<void>;
}

interface Row {
  tenant_id: string;
  operation_id: string;
  message_id: string;
  object_id: string;
  job_id: string;
  sha256: string;
  version: number;
  phase: AudioWorkRecord["phase"];
  attempts: number;
  cleanup_attempts: number;
  created_at: Date;
  next_attempt_at: Date;
  file_id: string | null;
  provider_job_id: string | null;
  transcript: string | null;
  terminal_handled: boolean;
  cleanup: AudioWorkRecord["cleanup"];
}

/** Called only inside a caller-owned tenant transaction. SQL checks the current lease on every call. */
export function createAudioWorkTransaction(
  tx: postgres.TransactionSql,
  binding: AudioWorkBinding,
  hooks: AudioWorkBusinessHooks,
): AudioWorkTransaction {
  const assertBinding = (candidate: AudioWorkBinding): void => {
    for (const key of Object.keys(binding) as (keyof AudioWorkBinding)[]) {
      if (candidate[key] !== binding[key])
        throw new Error("Audio work binding mismatch");
    }
  };
  const map = (row: Row | undefined): AudioWorkRecord => {
    if (!row) throw new Error("Audio work checkpoint missing");
    const rowBinding = {
      ...binding,
      tenantId: row.tenant_id,
      operationId: row.operation_id,
      messageId: row.message_id,
      objectId: row.object_id,
      jobId: row.job_id,
      sha256: row.sha256,
    };
    assertBinding(rowBinding);
    const createdAt = row.created_at.getTime();
    const nextAttemptAt = row.next_attempt_at.getTime();
    if (!Number.isFinite(createdAt) || !Number.isFinite(nextAttemptAt))
      throw new Error("Invalid audio work timestamp");
    return {
      binding: rowBinding,
      version: row.version,
      phase: row.phase,
      attempts: row.attempts,
      cleanupAttempts: row.cleanup_attempts,
      createdAt,
      nextAttemptAt,
      terminalHandled: row.terminal_handled,
      cleanup: row.cleanup,
      ...(row.file_id ? { fileId: row.file_id } : {}),
      ...(row.provider_job_id ? { providerJobId: row.provider_job_id } : {}),
      ...(row.transcript !== null ? { transcript: row.transcript } : {}),
    };
  };
  const load = async (): Promise<AudioWorkRecord> => {
    const rows = await tx<
      Row[]
    >`SELECT * FROM messaging.begin_audio_transcription(
      ${binding.operationId}::uuid, ${binding.messageId}::uuid, ${binding.objectId}::uuid,
      ${binding.sha256}, ${binding.jobId}::uuid, ${binding.claimToken}::uuid)`;
    return map(rows[0]);
  };
  const guardedRecord = async (record: AudioWorkRecord): Promise<void> => {
    assertBinding(record.binding);
    const current = await load();
    if (current.version !== record.version)
      throw new Error("Stale audio work checkpoint");
  };
  return {
    async loadOrCreate(candidate) {
      assertBinding(candidate);
      return load();
    },
    async compareAndSet(record, patch: AudioWorkPatch) {
      assertBinding(record.binding);
      if (
        patch.nextAttemptAt !== undefined &&
        !Number.isFinite(patch.nextAttemptAt)
      )
        throw new Error("Invalid audio retry timestamp");
      const serialized = { ...patch };
      const rows = await tx<
        Row[]
      >`SELECT * FROM messaging.advance_audio_transcription(
        ${binding.operationId}::uuid, ${binding.jobId}::uuid, ${binding.claimToken}::uuid,
        ${record.version}, ${tx.json(serialized)})`;
      return map(rows[0]);
    },
    async publishTranscript(record, text) {
      await guardedRecord(record);
      await hooks.publishTranscript(tx, record, text);
    },
    async ensureFallbackTaskAndAlert(record, code, text) {
      await guardedRecord(record);
      await hooks.ensureFallbackTaskAndAlert(tx, record, code, text);
    },
  };
}
