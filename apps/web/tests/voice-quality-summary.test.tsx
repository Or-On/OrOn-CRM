// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { VoiceQualitySummary } from "../src/features/voice";
import { localized } from "./localized";

afterEach(cleanup);

it("shows missing observations rather than fabricated latency or playback", () => {
  render(localized(<VoiceQualitySummary events={[]} />));
  expect(
    screen.getByText("No timing observations are available for this call."),
  ).toBeTruthy();
  expect(
    screen.getByText(/Exact remote playback is not confirmed/),
  ).toBeTruthy();
});

it("renders only finite measured stage statistics and rejects malformed samples", () => {
  render(
    localized(
      <VoiceQualitySummary
        events={[
          {
            sequence: 1,
            occurred_at: "2026-09-12T00:00:00Z",
            event_type: "voice.quality.summary.v1",
            payload: {
              schema_version: "1.0",
              summary_ms: {
                model_first_token_ms: { samples: 3, p50: 312, p95: 604 },
                validation_ms: { samples: 0, p50: 0, p95: 0 },
                accepted_to_transport_signal_ms: {
                  samples: 2,
                  p50: -5,
                  p95: "bad",
                },
              },
            },
          },
        ]}
      />,
    ),
  );
  expect(screen.getByText("312 ms")).toBeTruthy();
  expect(screen.getByText(/p95 604 ms/)).toBeTruthy();
  expect(screen.queryByText("0 ms")).toBeNull();
  expect(screen.queryByText("-5 ms")).toBeNull();
});

it("still reads the stages when a newer agent adds a section beside them", () => {
  // 1.1 records pipecat's per-component attribution next to these stages.
  // `summary_ms` did not change, so the panel must keep rendering rather than
  // fall back to "no observations" for every call from a newer agent.
  render(
    localized(
      <VoiceQualitySummary
        events={[
          {
            sequence: 1,
            occurred_at: "2026-09-18T00:00:00Z",
            event_type: "voice.quality.summary.v1",
            payload: {
              schema_version: "1.1",
              component_latency: {
                source: "pipecat_latency_breakdown",
                summary_ms: { total: { samples: 1, p50: 900, p95: 900 } },
              },
              summary_ms: {
                model_first_token_ms: { samples: 3, p50: 312, p95: 604 },
              },
            },
          },
        ]}
      />,
    ),
  );
  expect(screen.getByText("312 ms")).toBeTruthy();
});

it("ignores a quality payload whose schema it has never seen", () => {
  render(
    localized(
      <VoiceQualitySummary
        events={[
          {
            sequence: 1,
            occurred_at: "2026-09-18T00:00:00Z",
            event_type: "voice.quality.summary.v1",
            payload: {
              schema_version: "9.0",
              summary_ms: {
                model_first_token_ms: { samples: 3, p50: 312, p95: 604 },
              },
            },
          },
        ]}
      />,
    ),
  );
  expect(
    screen.getByText("No timing observations are available for this call."),
  ).toBeTruthy();
});
