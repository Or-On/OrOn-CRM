import { issueServiceAssertion } from "@or-on/auth";
import type { VerifiedArtifact, VerifiedTranscript } from "@or-on/crm";

/**
 * Asking the service that owns the bytes whether the bytes are any good.
 *
 * The worker deliberately does not read object storage itself. The recording
 * may be behind `gs://` in one deployment and `file://` in another, and only
 * the control API's artifact layer knows how to open both — the same layer the
 * authenticated playback route reads through. Verifying anywhere else would
 * give a verdict about a path the operator's play button never uses.
 *
 * The assertion is minted per request with the narrowest capability that can
 * read a recording, and it lives for a minute.
 */
export interface ArtifactVerification {
  readonly recording: VerifiedArtifact;
  readonly transcript: VerifiedTranscript;
}

export interface ArtifactVerificationRequest {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly actorUserId: string;
  readonly jobId: string;
}

export interface TranscriptTurn {
  readonly index: number;
  readonly role: string;
  readonly text: string;
  readonly interrupted: boolean;
}

export interface ArtifactVerifier {
  verify(request: ArtifactVerificationRequest): Promise<ArtifactVerification>;
  /** The parsed turns an analysis may cite, numbered by the canonical reader. */
  transcript(
    request: ArtifactVerificationRequest,
  ): Promise<readonly TranscriptTurn[]>;
}

export class ArtifactVerifierError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
    this.name = "ArtifactVerifierError";
  }
}

const RECORDING_STATES = new Set(["ready", "partial", "unavailable", "failed"]);
const TRANSCRIPT_STATES = new Set([
  "valid",
  "partial",
  "empty",
  "missing",
  "failed",
]);
const BACKENDS = new Set(["local", "gcs"]);

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function safeCode(value: unknown): string {
  // A fixed vocabulary crosses this boundary; anything else becomes a single
  // opaque code rather than reaching an operator-visible column verbatim.
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,39}$/u.test(value)
    ? value
    : "unrecognised";
}

function count(value: unknown, maximum: number): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= maximum
    ? value
    : null;
}

function backend(value: unknown): "local" | "gcs" | null {
  return typeof value === "string" && BACKENDS.has(value)
    ? (value as "local" | "gcs")
    : null;
}

function storageKey(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    ? value
    : null;
}

function checksum(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value)
    ? value
    : null;
}

function contentType(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 120
    ? value
    : null;
}

/** Parse the report conservatively: an unreadable field degrades, never lies. */
export function parseArtifactVerification(
  payload: unknown,
): ArtifactVerification {
  const body = record(payload);
  const recording = record(body?.recording);
  const transcript = record(body?.transcript);
  if (recording === undefined || transcript === undefined)
    throw new ArtifactVerifierError("artifact_invalid_output", false);
  const recordingState = recording.state;
  const transcriptState = transcript.state;
  if (
    typeof recordingState !== "string" ||
    !RECORDING_STATES.has(recordingState) ||
    typeof transcriptState !== "string" ||
    !TRANSCRIPT_STATES.has(transcriptState)
  )
    throw new ArtifactVerifierError("artifact_invalid_state", false);
  return {
    recording: {
      state: recordingState as VerifiedArtifact["state"],
      detail: safeCode(recording.detail),
      byteSize: count(recording.byte_size, Number.MAX_SAFE_INTEGER),
      durationSeconds: count(recording.duration_seconds, 86_400),
      contentType: contentType(recording.content_type),
      checksum: checksum(recording.checksum),
      storageBackend: backend(recording.storage_backend),
      storageKey: storageKey(recording.storage_key),
    },
    transcript: {
      state: transcriptState as VerifiedTranscript["state"],
      detail: safeCode(transcript.detail),
      byteSize: count(transcript.byte_size, Number.MAX_SAFE_INTEGER),
      turnCount: count(transcript.turn_count, 100_000) ?? 0,
      contentType: contentType(transcript.content_type),
      checksum: checksum(transcript.checksum),
      storageBackend: backend(transcript.storage_backend),
      storageKey: storageKey(transcript.storage_key),
    },
  };
}

/** Bounded so a pathological transcript cannot become an unbounded prompt. */
const MAX_TURNS = 400;
const MAX_TURN_TEXT = 2_000;

export function parseTranscriptTurns(
  payload: unknown,
): readonly TranscriptTurn[] {
  const body = record(payload);
  if (!Array.isArray(body?.turns)) return [];
  return (body.turns as readonly unknown[])
    .slice(0, MAX_TURNS)
    .map((item) => {
      const turn = record(item);
      const index = turn?.index;
      const role = turn?.role;
      const text = turn?.text;
      if (
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 1 ||
        typeof role !== "string" ||
        typeof text !== "string"
      )
        return undefined;
      return {
        index,
        role: role.slice(0, 40),
        text: text.slice(0, MAX_TURN_TEXT),
        interrupted: turn?.interrupted === true,
      };
    })
    .filter((turn): turn is TranscriptTurn => turn !== undefined);
}

export class ControlApiArtifactVerifier implements ArtifactVerifier {
  public constructor(
    private readonly options: {
      readonly controlApiUrl: string;
      readonly serviceSecret: string | undefined;
      readonly timeoutMs?: number;
    },
  ) {}

  public async verify(
    request: ArtifactVerificationRequest,
  ): Promise<ArtifactVerification> {
    return parseArtifactVerification(await this.read(request, "artifacts"));
  }

  public async transcript(
    request: ArtifactVerificationRequest,
  ): Promise<readonly TranscriptTurn[]> {
    return parseTranscriptTurns(await this.read(request, "transcript"));
  }

  private async read(
    request: ArtifactVerificationRequest,
    resource: "artifacts" | "transcript",
  ): Promise<unknown> {
    if (this.options.serviceSecret === undefined)
      throw new ArtifactVerifierError("artifact_auth_unavailable", false);
    const assertion = await issueServiceAssertion({
      audience: "control-api",
      capability: "voice:read",
      identity: {
        role: "agent",
        // The job, not a person: this read is the platform verifying its own
        // artifact, and attributing it to a user would misrepresent the actor.
        sessionId: request.jobId,
        tenantId: request.tenantId,
        userId: request.actorUserId,
      },
      secret: this.options.serviceSecret,
    });
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 20_000,
    );
    try {
      const response = await fetch(
        new URL(
          `/api/v1/voice/sessions/${encodeURIComponent(request.sessionId)}/${resource}`,
          this.options.controlApiUrl,
        ),
        {
          cache: "no-store",
          headers: { authorization: `Bearer ${assertion}` },
          signal: controller.signal,
        },
      );
      if (response.status === 404)
        throw new ArtifactVerifierError("artifact_session_unknown", false);
      if (!response.ok) {
        const retryable =
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;
        throw new ArtifactVerifierError(
          `artifact_http_${String(response.status)}`,
          retryable,
        );
      }
      return (await response.json().catch(() => undefined)) as unknown;
    } catch (error) {
      if (error instanceof ArtifactVerifierError) throw error;
      if (error instanceof Error && error.name === "AbortError")
        throw new ArtifactVerifierError("artifact_timeout", true);
      throw new ArtifactVerifierError("artifact_transport_error", true);
    } finally {
      clearTimeout(timeout);
    }
  }
}
