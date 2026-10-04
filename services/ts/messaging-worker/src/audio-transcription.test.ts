import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AudioTranscriptionAuthorizationLost,
  SonioxAsyncAudioTranscriber,
} from "./audio-transcription.js";
import type {
  AudioTranscriptionInput,
  AudioTranscriptionProgress,
  AudioTranscriptionTicket,
} from "./audio-transcription.js";

const authorize = () => Promise.resolve();
const FILE = "00000000-0000-4000-8000-000000000001";
const JOB = "00000000-0000-4000-8000-000000000002";
const ticket: AudioTranscriptionTicket = {
  operationId: "synthetic-operation",
  fileId: FILE,
  providerJobId: JOB,
};
function input(): AudioTranscriptionInput {
  const bytes = new Uint8Array([1, 2, 3]);
  return {
    operationId: ticket.operationId,
    bytes,
    mimeType: "audio/ogg; codecs=opus",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    checkpoint: vi
      .fn<(progress: AudioTranscriptionProgress) => Promise<void>>()
      .mockResolvedValue(undefined),
    beforeAttempt: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}
function adapter() {
  const execute = vi.fn<typeof fetch>();
  const transcriber = new SonioxAsyncAudioTranscriber({
    apiKey: "fictional-key",
    model: "explicit-model",
    languageHints: ["he"],
    fetch: execute,
  });
  return { execute, transcriber };
}
const response = (body: unknown, status = 200) =>
  Response.json(body, { status });

describe("optional Soniox async transcription port", () => {
  it("requires explicit configuration and validates limits", () => {
    expect(
      () => new SonioxAsyncAudioTranscriber({ apiKey: "", model: "explicit" }),
    ).toThrow();
    expect(
      () => new SonioxAsyncAudioTranscriber({ apiKey: "fictional", model: "" }),
    ).toThrow();
    expect(
      () =>
        new SonioxAsyncAudioTranscriber({
          apiKey: "fictional",
          model: "explicit",
          timeoutMs: NaN,
        }),
    ).toThrow();
  });
  it("persists mutation boundaries and returns a durable ticket without polling", async () => {
    const { execute, transcriber } = adapter();
    execute
      .mockResolvedValueOnce(response({ id: FILE }, 201))
      .mockResolvedValueOnce(response({ id: JOB, status: "queued" }, 201));
    const request = input();
    expect(await transcriber.start(request)).toEqual({
      kind: "pending",
      ticket,
      retryAfterMs: 2000,
    });
    expect(
      vi
        .mocked(request.checkpoint)
        .mock.calls.map(([progress]) => progress.phase),
    ).toEqual(["upload_inflight", "uploaded", "submit_inflight", "submitted"]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0]).toBe("https://api.soniox.com/v1/files");
    expect(execute.mock.calls[0]?.[1]?.redirect).toBe("error");
    const form = execute.mock.calls[0]?.[1]?.body;
    expect(form).toBeInstanceOf(FormData);
    const body = execute.mock.calls[1]?.[1]?.body;
    if (typeof body !== "string")
      throw new Error("Missing synthetic request body");
    const submission: unknown = JSON.parse(body);
    expect(submission).toEqual({
      model: "explicit-model",
      file_id: FILE,
      client_reference_id: ticket.operationId,
      language_hints: ["he"],
    });
    expect(submission).not.toHaveProperty("audio_url");
  });
  it("honors the required durable compare-and-set hook to prevent replayed paid submissions", async () => {
    const { execute, transcriber } = adapter();
    execute
      .mockResolvedValueOnce(response({ id: FILE }, 201))
      .mockResolvedValueOnce(response({ id: JOB }, 201));
    const request = input();
    const phases = new Set<string>();
    vi.mocked(request.checkpoint).mockImplementation((progress) => {
      if (phases.has(progress.phase))
        return Promise.reject(new Error("duplicate durable phase"));
      phases.add(progress.phase);
      return Promise.resolve();
    });
    expect(await transcriber.start(request)).toMatchObject({ kind: "pending" });
    await expect(transcriber.start(request)).rejects.toThrow(
      "duplicate durable phase",
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("rejects bad MIME, size and hash before any provider operation", async () => {
    const { execute, transcriber } = adapter();
    for (const request of [
      { ...input(), mimeType: "text/html" },
      { ...input(), bytes: new Uint8Array() },
      { ...input(), sha256: "0".repeat(64) },
    ]) {
      expect(await transcriber.start(request)).toMatchObject({
        kind: "failed",
        code: "invalid_audio",
        requiresOperator: true,
      });
    }
    expect(execute).not.toHaveBeenCalled();
  });
  it("returns explicit rejection retry after 429 without inline sleeps or automatic POST retries", async () => {
    const { execute, transcriber } = adapter();
    execute.mockResolvedValue(
      new Response(null, { status: 429, headers: { "retry-after": "10000" } }),
    );
    expect(await transcriber.start(input())).toEqual({
      kind: "retry",
      phase: "upload",
      operationId: ticket.operationId,
      retryAfterMs: 60000,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("resumes a known file after explicit submit rejection without re-uploading", async () => {
    const { execute, transcriber } = adapter();
    execute.mockResolvedValue(response({}, 429));
    expect(
      await transcriber.start({ ...input(), uploadedFileId: FILE }),
    ).toMatchObject({ kind: "retry", phase: "submit", fileId: FILE });
    expect(execute.mock.calls[0]?.[0]).toBe(
      "https://api.soniox.com/v1/transcriptions",
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("marks uncertain submit as unknown instead of risking duplicate paid transcriptions", async () => {
    const { execute, transcriber } = adapter();
    execute.mockRejectedValue(
      new Error(
        "untrusted provider exception containing fictional sensitive data",
      ),
    );
    const result = await transcriber.start({
      ...input(),
      uploadedFileId: FILE,
    });
    expect(result).toMatchObject({
      kind: "unknown",
      phase: "submit",
      fileId: FILE,
      requiresOperator: true,
      code: "submit_outcome_unknown",
    });
    expect(JSON.stringify(result)).not.toContain("sensitive data");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("retains accepted job identity when its durable checkpoint fails", async () => {
    const { execute, transcriber } = adapter();
    execute.mockResolvedValue(response({ id: JOB }, 201));
    const request = { ...input(), uploadedFileId: FILE };
    vi.mocked(request.checkpoint).mockImplementation((progress) => {
      if (progress.phase === "submitted")
        return Promise.reject(new Error("synthetic DB outage"));
      return Promise.resolve();
    });
    expect(await transcriber.start(request)).toMatchObject({
      kind: "unknown",
      code: "submit_checkpoint_failed",
      ticket,
    });
  });
  it("does not submit when an accepted upload cannot be durably recorded", async () => {
    const { execute, transcriber } = adapter();
    execute.mockResolvedValue(response({ id: FILE }, 201));
    const request = input();
    vi.mocked(request.checkpoint).mockImplementation((progress) => {
      if (progress.phase === "uploaded")
        return Promise.reject(new Error("synthetic outage"));
      return Promise.resolve();
    });
    expect(await transcriber.start(request)).toMatchObject({
      kind: "unknown",
      phase: "upload",
      fileId: FILE,
      requiresOperator: true,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("keeps submit 5xx uncertain and bounds provider response and transcript size", async () => {
    const { execute, transcriber } = adapter();
    execute.mockResolvedValueOnce(response({}, 503));
    expect(
      await transcriber.start({ ...input(), uploadedFileId: FILE }),
    ).toMatchObject({ kind: "unknown", phase: "submit" });
    execute
      .mockResolvedValueOnce(response({ id: JOB, status: "completed" }))
      .mockResolvedValueOnce(response({ id: JOB, text: "x".repeat(16_385) }));
    expect(await transcriber.poll(ticket, authorize)).toMatchObject({
      kind: "failed",
      code: "invalid_transcript",
    });
    execute.mockResolvedValueOnce(
      response({ id: FILE, extra: "x".repeat(1_048_577) }, 201),
    );
    expect(await transcriber.start(input())).toMatchObject({
      kind: "unknown",
      phase: "upload",
    });
  });
  it("polls once and returns pending without claiming the annotation is a transcript", async () => {
    const { execute, transcriber } = adapter();
    execute.mockResolvedValue(
      response({ id: JOB, file_id: FILE, status: "processing" }),
    );
    expect(await transcriber.poll(ticket, authorize)).toEqual({
      kind: "pending",
      ticket,
      retryAfterMs: 2000,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("returns only bounded completed provider text, without invented confidence or authority", async () => {
    const { execute, transcriber } = adapter();
    execute
      .mockResolvedValueOnce(
        response({ id: JOB, file_id: FILE, status: "completed" }),
      )
      .mockResolvedValueOnce(
        response({ id: JOB, text: "  טקסט לקוח לא מהימן  ", tokens: [] }),
      );
    expect(await transcriber.poll(ticket, authorize)).toEqual({
      kind: "completed",
      ticket,
      text: "טקסט לקוח לא מהימן",
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("requires fallback and an operator task on failed or empty transcription", async () => {
    const { execute, transcriber } = adapter();
    execute.mockResolvedValueOnce(
      response({ id: JOB, status: "error", error_message: "do not expose" }),
    );
    const result = await transcriber.poll(ticket, authorize);
    expect(result).toMatchObject({ kind: "failed", requiresOperator: true });
    expect("fallbackText" in result && result.fallbackText.length > 0).toBe(
      true,
    );
    expect(JSON.stringify(result)).not.toContain("do not expose");
    execute
      .mockResolvedValueOnce(response({ id: JOB, status: "completed" }))
      .mockResolvedValueOnce(response({ id: JOB, text: "" }));
    expect(await transcriber.poll(ticket, authorize)).toMatchObject({
      kind: "failed",
      code: "invalid_transcript",
      requiresOperator: true,
    });
  });
  it("blocks mismatched ticket paths and provider response identities", async () => {
    const { execute, transcriber } = adapter();
    expect(
      await transcriber.poll(
        { ...ticket, providerJobId: "../../private" },
        authorize,
      ),
    ).toMatchObject({ kind: "failed", code: "invalid_ticket" });
    expect(execute).not.toHaveBeenCalled();
    execute.mockResolvedValue(
      response({ id: JOB, file_id: "another-file", status: "completed" }),
    );
    expect(await transcriber.poll(ticket, authorize)).toMatchObject({
      kind: "failed",
      code: "invalid_provider_status",
    });
  });
  it("does not send after authorization loss between checkpoint and HTTP", async () => {
    const { execute, transcriber } = adapter();
    const request = { ...input(), uploadedFileId: FILE };
    vi.mocked(request.beforeAttempt)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("lease lost"));
    await expect(transcriber.start(request)).rejects.toBeInstanceOf(
      AudioTranscriptionAuthorizationLost,
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it("bounds a stalled upload and reports unknown outcome rather than submitting again", async () => {
    const execute = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("deadline")),
            { once: true },
          );
        }),
    );
    const transcriber = new SonioxAsyncAudioTranscriber({
      apiKey: "fictional",
      model: "explicit",
      timeoutMs: 10,
      fetch: execute,
    });
    expect(await transcriber.start(input())).toMatchObject({
      kind: "unknown",
      phase: "upload",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
