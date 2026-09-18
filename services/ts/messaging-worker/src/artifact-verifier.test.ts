import { describe, expect, it } from "vitest";

import {
  ArtifactVerifierError,
  parseArtifactVerification,
  parseTranscriptTurns,
} from "./artifact-verifier.js";

function report(overrides: Record<string, unknown> = {}): unknown {
  return {
    recording: {
      state: "ready",
      detail: "verified",
      byte_size: 320_044,
      duration_seconds: 10,
      content_type: "audio/wav",
      checksum: "a".repeat(64),
      storage_backend: "local",
      storage_key: "conversations/x/recordings/merged_audio.wav",
    },
    transcript: {
      state: "valid",
      detail: "verified",
      byte_size: 420,
      turn_count: 8,
      content_type: "text/plain; charset=utf-8",
      checksum: "b".repeat(64),
      storage_backend: "local",
      storage_key: "conversations/x/transcripts/transcript.txt",
    },
    ...overrides,
  };
}

describe("artifact verification report", () => {
  it("carries the registry facts a verified artifact needs", () => {
    const parsed = parseArtifactVerification(report());

    expect(parsed.recording.state).toBe("ready");
    expect(parsed.recording.durationSeconds).toBe(10);
    expect(parsed.recording.checksum).toHaveLength(64);
    expect(parsed.transcript.turnCount).toBe(8);
  });

  it("refuses a state it does not recognise rather than guessing", () => {
    expect(() =>
      parseArtifactVerification(
        report({ recording: { state: "probably_ok" } }),
      ),
    ).toThrow(ArtifactVerifierError);
  });

  it("reduces an unrecognised detail to one opaque code", () => {
    const parsed = parseArtifactVerification(
      report({
        recording: {
          state: "failed",
          detail: "Traceback (most recent call last): boom",
        },
      }),
    );

    // The detail reaches an operator-visible column, so anything outside the
    // fixed vocabulary must not pass through verbatim.
    expect(parsed.recording.detail).toBe("unrecognised");
  });

  it("drops a checksum that is not a digest", () => {
    const parsed = parseArtifactVerification(
      report({
        recording: { state: "ready", detail: "verified", checksum: "nope" },
      }),
    );

    // Without a usable checksum nothing is registered, so the attempt cannot
    // reach `ready` on the strength of a malformed field.
    expect(parsed.recording.checksum).toBeNull();
  });

  it("rejects a body with no artifact sections at all", () => {
    expect(() => parseArtifactVerification({})).toThrow(ArtifactVerifierError);
    expect(() => parseArtifactVerification(undefined)).toThrow(
      ArtifactVerifierError,
    );
  });
});

describe("transcript turns", () => {
  it("keeps the reader's numbering so a citation keeps its meaning", () => {
    const turns = parseTranscriptTurns({
      turns: [
        { index: 1, role: "user", text: "שלום", interrupted: false },
        { index: 2, role: "assistant", text: "Hello", interrupted: true },
      ],
    });

    expect(turns.map((turn) => turn.index)).toEqual([1, 2]);
    expect(turns[1]?.interrupted).toBe(true);
  });

  it("drops a malformed turn instead of renumbering around it", () => {
    const turns = parseTranscriptTurns({
      turns: [
        { index: 1, role: "user", text: "kept" },
        { index: 0, role: "user", text: "dropped" },
        { role: "user", text: "dropped" },
        { index: 3, role: "user", text: "kept" },
      ],
    });

    expect(turns.map((turn) => turn.index)).toEqual([1, 3]);
  });

  it("returns nothing for a body with no turns", () => {
    expect(parseTranscriptTurns({ turns: [] })).toEqual([]);
    expect(parseTranscriptTurns(undefined)).toEqual([]);
  });
});
