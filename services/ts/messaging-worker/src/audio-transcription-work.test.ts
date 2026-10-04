import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AudioTranscriber } from "./audio-transcription.js";
import { runAudioTranscriptionWork } from "./audio-transcription-work.js";
import type {
  AudioWorkBinding,
  AudioWorkPorts,
  AudioWorkRecord,
  AudioWorkTransaction,
} from "./audio-transcription-work.js";

const id = (number: number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const bytes = new Uint8Array([1, 2, 3]);
const binding: AudioWorkBinding = {
  tenantId: id(1),
  operationId: id(2),
  messageId: id(3),
  objectId: id(4),
  jobId: id(5),
  claimToken: id(6),
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const ticket = {
  operationId: binding.operationId,
  fileId: id(7),
  providerJobId: id(8),
};

function fixture(initial: Partial<AudioWorkRecord> = {}) {
  let current: AudioWorkRecord = {
    binding,
    version: 0,
    phase: "new",
    attempts: 0,
    cleanupAttempts: 0,
    createdAt: 0,
    nextAttemptAt: 0,
    terminalHandled: false,
    cleanup: "none",
    ...initial,
  };
  let now = 0,
    authorized = true;
  const published = vi
    .fn<(record: AudioWorkRecord, text: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  const fallback = vi
    .fn<
      (record: AudioWorkRecord, code: string, text: string) => Promise<void>
    >()
    .mockResolvedValue(undefined);
  const tx: AudioWorkTransaction = {
    loadOrCreate: () => Promise.resolve(current),
    compareAndSet: (snapshot, patch) => {
      if (snapshot.version !== current.version)
        return Promise.reject(new Error("CAS conflict"));
      current = { ...current, ...patch, version: current.version + 1 };
      return Promise.resolve(current);
    },
    publishTranscript: published,
    ensureFallbackTaskAndAlert: fallback,
  };
  const start = vi
    .fn<AudioTranscriber["start"]>()
    .mockImplementation(async (request) => {
      if (request.uploadedFileId === undefined) {
        await request.checkpoint({
          phase: "upload_inflight",
          operationId: binding.operationId,
        });
        await request.checkpoint({
          phase: "uploaded",
          operationId: binding.operationId,
          fileId: ticket.fileId,
        });
      }
      await request.checkpoint({
        phase: "submit_inflight",
        operationId: binding.operationId,
        fileId: ticket.fileId,
      });
      await request.checkpoint({ phase: "submitted", ticket });
      return { kind: "pending", ticket, retryAfterMs: 2000 };
    });
  const poll = vi.fn<AudioTranscriber["poll"]>().mockResolvedValue({
    kind: "completed",
    ticket,
    text: "Fictional customer transcript",
  });
  const read = vi
    .fn<AudioWorkPorts["readPrivateAudio"]>()
    .mockResolvedValue({ bytes, mimeType: "audio/ogg" });
  const ports: AudioWorkPorts = {
    ownedTransaction: (request, work) => {
      if (
        !authorized ||
        request.tenantId !== binding.tenantId ||
        request.claimToken !== binding.claimToken
      )
        return Promise.reject(new Error("fresh claim denied"));
      return work(tx);
    },
    readPrivateAudio: read,
    transcriber: { start, poll },
    now: () => now,
  };
  return {
    ports,
    start,
    poll,
    read,
    fallback,
    published,
    record: () => current,
    setNow: (value: number) => {
      now = value;
    },
    revoke: () => {
      authorized = false;
    },
  };
}

describe("durable audio transcription orchestration (synthetic persistence ports)", () => {
  it("reschedules a known provider ticket then publishes one transcript atomically", async () => {
    const f = fixture();
    expect(await runAudioTranscriptionWork(binding, f.ports)).toEqual({
      kind: "rescheduled",
      availableAt: 2000,
    });
    expect(f.record()).toMatchObject({
      phase: "submitted",
      fileId: ticket.fileId,
      providerJobId: ticket.providerJobId,
      attempts: 1,
    });
    f.setNow(2000);
    expect(await runAudioTranscriptionWork(binding, f.ports)).toEqual({
      kind: "completed",
      cleanup: "blocked",
    });
    await runAudioTranscriptionWork(binding, f.ports);
    expect(f.published).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.fallback).not.toHaveBeenCalled();
  });
  it("fails safely when the provider is unconfigured instead of leaving a silent pending turn", async () => {
    const f = fixture();
    const ports = {
      ownedTransaction: f.ports.ownedTransaction.bind(f.ports),
      readPrivateAudio: f.ports.readPrivateAudio.bind(f.ports),
      now: () => 0,
    };
    expect(await runAudioTranscriptionWork(binding, ports)).toEqual({
      kind: "terminal",
      cleanup: "blocked",
    });
    expect(f.fallback).toHaveBeenCalledOnce();
    expect(f.fallback.mock.calls[0]?.[1]).toBe(
      "audio_transcriber_not_configured",
    );
    expect(f.fallback.mock.calls[0]?.[2].length).toBeGreaterThan(0);
    await runAudioTranscriptionWork(binding, ports);
    expect(f.fallback).toHaveBeenCalledOnce();
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each(["upload_inflight", "submit_inflight"] as const)(
    "never resubmits an abandoned %s mutation",
    async (phase) => {
      const f = fixture({ phase });
      expect(await runAudioTranscriptionWork(binding, f.ports)).toEqual({
        kind: "terminal",
        cleanup: "blocked",
      });
      expect(f.record().phase).toBe("unknown");
      expect(f.start).not.toHaveBeenCalled();
      expect(f.fallback).toHaveBeenCalledOnce();
    },
  );
  it("preserves an inflight crash marker so restart produces fallback rather than duplicate charges", async () => {
    const f = fixture();
    f.start.mockImplementation(async (request) => {
      await request.checkpoint({
        phase: "upload_inflight",
        operationId: binding.operationId,
      });
      throw new Error("synthetic process crash");
    });
    await expect(runAudioTranscriptionWork(binding, f.ports)).rejects.toThrow(
      "synthetic process crash",
    );
    expect(f.record().phase).toBe("upload_inflight");
    await runAudioTranscriptionWork(binding, f.ports);
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.fallback).toHaveBeenCalledOnce();
  });
  it("bounds poll attempts and age with fallback, operator and alert work", async () => {
    const f = fixture({
      phase: "submitted",
      fileId: ticket.fileId,
      providerJobId: ticket.providerJobId,
      attempts: 8,
    });
    await runAudioTranscriptionWork(binding, f.ports);
    expect(f.poll).not.toHaveBeenCalled();
    expect(f.fallback).toHaveBeenCalledOnce();
    const old = fixture();
    old.setNow(90_000);
    await runAudioTranscriptionWork(binding, old.ports);
    expect(old.start).not.toHaveBeenCalled();
    expect(old.fallback).toHaveBeenCalledOnce();
  });
  it("does not schedule a provider retry past the final response deadline", async () => {
    const f = fixture({
      phase: "submitted",
      fileId: ticket.fileId,
      providerJobId: ticket.providerJobId,
    });
    f.setNow(60_000);
    f.poll.mockResolvedValue({
      kind: "retry",
      phase: "poll",
      operationId: binding.operationId,
      ticket,
      retryAfterMs: 60_000,
    });
    expect(await runAudioTranscriptionWork(binding, f.ports)).toMatchObject({
      kind: "terminal",
    });
    expect(f.fallback).toHaveBeenCalledOnce();
  });
  it("guards tenant, immutable message binding and fresh lease before reading media or submitting", async () => {
    const f = fixture();
    await expect(
      runAudioTranscriptionWork({ ...binding, tenantId: id(9) }, f.ports),
    ).rejects.toThrow("fresh claim denied");
    await expect(
      runAudioTranscriptionWork({ ...binding, messageId: id(9) }, f.ports),
    ).rejects.toThrow("immutable binding conflict");
    f.revoke();
    await expect(runAudioTranscriptionWork(binding, f.ports)).rejects.toThrow(
      "fresh claim denied",
    );
    expect(f.read).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });
  it("retries terminal cleanup at most three times without republishing or resubmitting", async () => {
    const f = fixture({
      phase: "completed",
      fileId: ticket.fileId,
      providerJobId: ticket.providerJobId,
      transcript: "Fictional",
      terminalHandled: true,
      cleanup: "pending",
    });
    const cleanup = vi
      .fn<NonNullable<AudioWorkPorts["cleanupTerminalProviderResources"]>>()
      .mockResolvedValue("pending");
    const ports = { ...f.ports, cleanupTerminalProviderResources: cleanup };
    expect(await runAudioTranscriptionWork(binding, ports)).toEqual({
      kind: "rescheduled",
      availableAt: 5000,
    });
    f.setNow(5000);
    await runAudioTranscriptionWork(binding, ports);
    f.setNow(10000);
    expect(await runAudioTranscriptionWork(binding, ports)).toEqual({
      kind: "completed",
      cleanup: "blocked",
    });
    await runAudioTranscriptionWork(binding, ports);
    expect(cleanup).toHaveBeenCalledTimes(3);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.published).not.toHaveBeenCalled();
  });
});
