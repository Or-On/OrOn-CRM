import { createHash } from "node:crypto";

// Verified official contracts: https://soniox.com/docs/api-reference/stt/files/upload_file
// https://soniox.com/docs/api-reference/stt/transcriptions/create_transcription
// https://soniox.com/docs/api-reference/stt/transcriptions/get_transcription_transcript
// client_reference_id is tracking, NOT a provider idempotency guarantee.
const ORIGIN = "https://api.soniox.com/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const FALLBACK =
  "קיבלתי את ההודעה הקולית, אבל לא הצלחתי לתמלל אותה כרגע. אפשר לשלוח את הבקשה בטקסט?";
const AUDIO_TYPES: Readonly<Record<string, string>> = {
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/aac": "aac",
};

export class AudioTranscriptionAuthorizationLost extends Error {
  constructor() {
    super("Audio transcription authorization or claim lost");
  }
}

export interface AudioTranscriptionTicket {
  readonly operationId: string;
  readonly fileId: string;
  readonly providerJobId: string;
}

export type AudioTranscriptionProgress =
  | { readonly phase: "upload_inflight"; readonly operationId: string }
  | {
      readonly phase: "uploaded" | "submit_inflight";
      readonly operationId: string;
      readonly fileId: string;
    }
  | { readonly phase: "submitted"; readonly ticket: AudioTranscriptionTicket };

export type AudioTranscriptionResult =
  | {
      readonly kind: "pending";
      readonly ticket: AudioTranscriptionTicket;
      readonly retryAfterMs: number;
    }
  | {
      readonly kind: "completed";
      readonly ticket: AudioTranscriptionTicket;
      readonly text: string;
    }
  | {
      readonly kind: "retry";
      readonly phase: "upload" | "submit" | "poll";
      readonly operationId: string;
      readonly retryAfterMs: number;
      readonly fileId?: string;
      readonly ticket?: AudioTranscriptionTicket;
    }
  | {
      readonly kind: "failed" | "unknown";
      readonly phase: "upload" | "submit" | "poll";
      readonly operationId: string;
      readonly code: string;
      readonly requiresOperator: true;
      readonly fallbackText: string;
      readonly fileId?: string;
      readonly ticket?: AudioTranscriptionTicket;
    };

export interface AudioTranscriptionInput {
  /** Durable, server-generated operation identity, scoped to the resolved tenant. */
  readonly operationId: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly sha256: string;
  /** Resume ONLY from a durably recorded upload with no unknown submit outcome. */
  readonly uploadedFileId?: string;
  readonly signal?: AbortSignal;
  /** Atomically compare-and-set durable phases; reject duplicate inflight or
   * submitted mutation attempts. Merely overwriting a progress field is unsafe.
   * Never retry an inflight/unknown POST blindly.
   */
  readonly checkpoint: (progress: AudioTranscriptionProgress) => Promise<void>;
  readonly beforeAttempt: () => Promise<void>;
}

export interface AudioTranscriber {
  start(input: AudioTranscriptionInput): Promise<AudioTranscriptionResult>;
  /** One bounded poll step; caller reschedules durably, never sleeps in the worker. */
  poll(
    ticket: AudioTranscriptionTicket,
    beforeAttempt: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<AudioTranscriptionResult>;
}

interface Options {
  readonly apiKey: string;
  readonly model: string;
  readonly languageHints?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxTranscriptCharacters?: number;
  readonly fetch?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function identity(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function failure(
  kind: "failed" | "unknown",
  phase: "upload" | "submit" | "poll",
  operationId: string,
  code: string,
  fileId?: string,
  ticket?: AudioTranscriptionTicket,
): AudioTranscriptionResult {
  return {
    kind,
    phase,
    operationId,
    code,
    requiresOperator: true,
    fallbackText: FALLBACK,
    ...(fileId === undefined ? {} : { fileId }),
    ...(ticket === undefined ? {} : { ticket }),
  };
}

/** Optional adapter: never constructed implicitly or supplied a default model/key.
 * Transcripts are customer input, not trusted instructions or permission evidence.
 * Caller owns tenant binding, durable claim tokens, max job age, bounded retries,
 * fallback+operator task/alert, and terminal provider-resource cleanup policy.
 */
export class SonioxAsyncAudioTranscriber implements AudioTranscriber {
  readonly #options: Options;
  readonly #timeoutMs: number;
  constructor(options: Options) {
    if (
      !options.apiKey.trim() ||
      /[\r\n]/u.test(options.apiKey) ||
      !/^[A-Za-z0-9_-]{1,32}$/u.test(options.model)
    )
      throw new TypeError("Explicit Soniox key and model are required");
    if (
      options.languageHints !== undefined &&
      (options.languageHints.length > 10 ||
        options.languageHints.some(
          (language) => !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/u.test(language),
        ))
    )
      throw new TypeError("Invalid language hints");
    this.#options = options;
    for (const limit of [
      options.timeoutMs,
      options.maxBytes,
      options.maxTranscriptCharacters,
    ]) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0))
        throw new TypeError("Invalid transcription limit");
    }
    this.#timeoutMs = Math.max(1, Math.min(15_000, options.timeoutMs ?? 8_000));
  }

  async #request(
    path: string,
    init: RequestInit,
    beforeAttempt: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<{
    status: number;
    body?: Record<string, unknown>;
    retryAfterMs: number;
  }> {
    try {
      await beforeAttempt();
    } catch {
      throw new AudioTranscriptionAuthorizationLost();
    }
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(this.#timeoutMs);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.#options.apiKey}`);
    const response = await (this.#options.fetch ?? fetch)(`${ORIGIN}${path}`, {
      ...init,
      redirect: "error",
      headers,
      signal:
        signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
    });
    const retrySeconds = Number(response.headers.get("retry-after"));
    const retryAfterMs =
      Number.isFinite(retrySeconds) && retrySeconds > 0
        ? Math.min(60_000, Math.max(1_000, retrySeconds * 1_000))
        : 5_000;
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, retryAfterMs };
    }
    // Bounded streamed response, not an unbounded response.json() allocation.
    const reader = response.body?.getReader();
    if (reader === undefined) return { status: response.status, retryAfterMs };
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 1_048_576) throw new Error("provider_response_too_large");
        chunks.push(next.value);
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      return {
        status: response.status,
        retryAfterMs,
        ...(body === undefined ? {} : { body }),
      };
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }

  async start(
    input: AudioTranscriptionInput,
  ): Promise<AudioTranscriptionResult> {
    const mimeType = input.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
    const maximum = Math.min(
      16 * 1_048_576,
      this.#options.maxBytes ?? 16 * 1_048_576,
    );
    if (
      !identity(input.operationId) ||
      input.bytes.byteLength === 0 ||
      input.bytes.byteLength > maximum ||
      AUDIO_TYPES[mimeType] === undefined ||
      !/^[a-f0-9]{64}$/u.test(input.sha256) ||
      createHash("sha256").update(input.bytes).digest("hex") !== input.sha256
    )
      return failure("failed", "upload", input.operationId, "invalid_audio");
    let fileId = input.uploadedFileId;
    if (fileId !== undefined && !UUID.test(fileId))
      return failure(
        "failed",
        "upload",
        input.operationId,
        "invalid_file_identity",
      );
    if (fileId === undefined) {
      await input.beforeAttempt();
      input.signal?.throwIfAborted();
      await input.checkpoint({
        phase: "upload_inflight",
        operationId: input.operationId,
      });
      const form = new FormData();
      form.set("client_reference_id", input.operationId);
      form.set(
        "file",
        new Blob([new Uint8Array(input.bytes)], { type: mimeType }),
        `voice-note.${AUDIO_TYPES[mimeType]}`,
      );
      try {
        const upload = await this.#request(
          "/files",
          { method: "POST", body: form },
          input.beforeAttempt,
          input.signal,
        );
        if (upload.status === 429)
          return {
            kind: "retry",
            phase: "upload",
            operationId: input.operationId,
            retryAfterMs: upload.retryAfterMs,
          };
        if (upload.status >= 500)
          return failure(
            "unknown",
            "upload",
            input.operationId,
            "upload_outcome_unknown",
          );
        if (upload.status !== 201)
          return failure(
            "failed",
            "upload",
            input.operationId,
            "upload_rejected",
          );
        fileId =
          typeof upload.body?.id === "string" && UUID.test(upload.body.id)
            ? upload.body.id
            : undefined;
        if (fileId === undefined)
          return failure(
            "unknown",
            "upload",
            input.operationId,
            "upload_identity_unknown",
          );
        await input.checkpoint({
          phase: "uploaded",
          operationId: input.operationId,
          fileId,
        });
      } catch (error) {
        if (error instanceof AudioTranscriptionAuthorizationLost) throw error;
        return failure(
          "unknown",
          "upload",
          input.operationId,
          "upload_outcome_unknown",
          fileId,
        );
      }
    }
    await input.beforeAttempt();
    input.signal?.throwIfAborted();
    await input.checkpoint({
      phase: "submit_inflight",
      operationId: input.operationId,
      fileId,
    });
    try {
      const submitted = await this.#request(
        "/transcriptions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.#options.model,
            file_id: fileId,
            client_reference_id: input.operationId,
            ...(this.#options.languageHints === undefined
              ? {}
              : { language_hints: this.#options.languageHints }),
          }),
        },
        input.beforeAttempt,
        input.signal,
      );
      if (submitted.status === 429)
        return {
          kind: "retry",
          phase: "submit",
          operationId: input.operationId,
          fileId,
          retryAfterMs: submitted.retryAfterMs,
        };
      if (submitted.status >= 500)
        return failure(
          "unknown",
          "submit",
          input.operationId,
          "submit_outcome_unknown",
          fileId,
        );
      if (submitted.status !== 201)
        return failure(
          "failed",
          "submit",
          input.operationId,
          "submit_rejected",
          fileId,
        );
      const providerJobId =
        typeof submitted.body?.id === "string" && UUID.test(submitted.body.id)
          ? submitted.body.id
          : undefined;
      if (providerJobId === undefined)
        return failure(
          "unknown",
          "submit",
          input.operationId,
          "submit_identity_unknown",
          fileId,
        );
      const ticket = { operationId: input.operationId, fileId, providerJobId };
      try {
        await input.checkpoint({ phase: "submitted", ticket });
      } catch {
        return failure(
          "unknown",
          "submit",
          input.operationId,
          "submit_checkpoint_failed",
          fileId,
          ticket,
        );
      }
      return { kind: "pending", ticket, retryAfterMs: 2_000 };
    } catch (error) {
      if (error instanceof AudioTranscriptionAuthorizationLost) throw error;
      return failure(
        "unknown",
        "submit",
        input.operationId,
        "submit_outcome_unknown",
        fileId,
      );
    }
  }

  async poll(
    ticket: AudioTranscriptionTicket,
    beforeAttempt: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<AudioTranscriptionResult> {
    if (
      !identity(ticket.operationId) ||
      !UUID.test(ticket.fileId) ||
      !UUID.test(ticket.providerJobId)
    )
      return failure("failed", "poll", ticket.operationId, "invalid_ticket");
    await beforeAttempt();
    signal?.throwIfAborted();
    try {
      const status = await this.#request(
        `/transcriptions/${ticket.providerJobId}`,
        { method: "GET" },
        beforeAttempt,
        signal,
      );
      if (status.status === 429 || status.status >= 500)
        return {
          kind: "retry",
          phase: "poll",
          operationId: ticket.operationId,
          ticket,
          retryAfterMs: status.retryAfterMs,
        };
      if (
        status.status !== 200 ||
        status.body?.id !== ticket.providerJobId ||
        (status.body.file_id !== undefined &&
          status.body.file_id !== ticket.fileId)
      )
        return failure(
          "failed",
          "poll",
          ticket.operationId,
          "invalid_provider_status",
          ticket.fileId,
          ticket,
        );
      if (
        status.body.status === "queued" ||
        status.body.status === "processing"
      )
        return { kind: "pending", ticket, retryAfterMs: 2_000 };
      if (status.body.status !== "completed")
        return failure(
          "failed",
          "poll",
          ticket.operationId,
          "provider_transcription_failed",
          ticket.fileId,
          ticket,
        );
      const transcript = await this.#request(
        `/transcriptions/${ticket.providerJobId}/transcript`,
        { method: "GET" },
        beforeAttempt,
        signal,
      );
      if (
        transcript.status === 429 ||
        transcript.status >= 500 ||
        transcript.status === 409
      )
        return {
          kind: "retry",
          phase: "poll",
          operationId: ticket.operationId,
          ticket,
          retryAfterMs: transcript.retryAfterMs,
        };
      const text = transcript.body?.text;
      if (
        transcript.status !== 200 ||
        transcript.body?.id !== ticket.providerJobId ||
        typeof text !== "string" ||
        text.trim() === "" ||
        text.length >
          Math.min(65_536, this.#options.maxTranscriptCharacters ?? 16_384)
      )
        return failure(
          "failed",
          "poll",
          ticket.operationId,
          "invalid_transcript",
          ticket.fileId,
          ticket,
        );
      return { kind: "completed", ticket, text: text.trim() };
    } catch (error) {
      if (error instanceof AudioTranscriptionAuthorizationLost) throw error;
      return {
        kind: "retry",
        phase: "poll",
        operationId: ticket.operationId,
        ticket,
        retryAfterMs: 5_000,
      };
    }
  }
}
