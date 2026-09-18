"""Measure the voice stack's Hebrew behaviour without calling a provider.

    uv run --group voice python -m scripts.voice_quality.benchmark

Writes `.artifacts/voice-quality/report.json` and `report.md`, both ignored by
git. Nothing here contacts Soniox, LiveKit or an LLM, and nothing here needs a
credential — which is the point: the parts of the turn this repository controls
(aggregation, trimming, Hebrew normalization) are measurable on every machine
and on every run, so a regression in them is caught before a call is booked.

What it does NOT measure, and must not be read as measuring:

* Recognition accuracy. Word error rate needs human Hebrew speech and a
  provider; a TTS→STT loop measures the synthesizer, not the caller.
* Endpoint delay. When Soniox decides a caller finished is a property of the
  provider and real speech. Sweep it with the per-call `soniox_endpoint_*`
  overrides on a live stack.
* Anything audible. Voice naturalness, prosody and pronunciation are a
  listening test. This file cannot hear.

The three stages it does measure are the three that sit between "the model
produced a word" and "the transport has audio": how long text waits before the
first synthesis request, whether a synthesis boundary lands inside a number or
a product name, and how much of the synthesized head is dropped as silence.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import statistics
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from oron_agent.tts_clause import FirstClauseAggregator
from oron_agent.tts_trim import TrimLeadingSilence
from oron_agent.voice_quality import VoiceQualityConfig, make_speech_transformer
from pipecat.frames.frames import Frame, TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame
from pipecat.processors.frame_processor import FrameDirection
from pipecat.utils.text.base_text_aggregator import AggregationType
from pipecat.utils.text.simple_text_aggregator import SimpleTextAggregator

from scripts.voice_quality.corpus import SPOKEN_CORPUS, TURN_STREAMS, SpokenCase, TurnStream

ARTIFACTS = Path(__file__).resolve().parents[2] / ".artifacts" / "voice-quality"
SAMPLE_RATE = 24000  # what the pipeline runs Soniox TTS and LiveKit output at


# --- Text aggregation ---------------------------------------------------------


@dataclass
class _Segment:
    text: str
    chunk_index: int


def _aggregators(mode: AggregationType) -> dict[str, Any]:
    """The arms worth comparing, each constructed the way build_tts does."""
    return {
        "simple": SimpleTextAggregator(aggregation_type=mode),
        "first_clause": FirstClauseAggregator(aggregation_type=mode),
    }


async def _segments(aggregator: Any, stream: TurnStream) -> list[_Segment]:
    """Replay one model turn and collect what would reach `run_tts`.

    `aggregate` is an async generator that may yield several completed
    aggregations for one streamed chunk, so it is iterated, not awaited.
    """
    out: list[_Segment] = []
    for index, chunk in enumerate(stream.chunks):
        async for aggregation in aggregator.aggregate(chunk):
            if aggregation is not None and aggregation.text.strip():
                out.append(_Segment(aggregation.text, index))
    flushed = await aggregator.flush()
    if flushed is not None and flushed.text.strip():
        out.append(_Segment(flushed.text, len(stream.chunks) - 1))
    return out


def _split_atoms(segments: list[_Segment], stream: TurnStream) -> list[str]:
    """Atomic strings that did not survive inside a single segment.

    A price or a phone number cut in half is heard as a stumble: the two halves
    are synthesized by separate Soniox streams, with a gap and no shared
    prosodic context between them.
    """
    texts = [segment.text for segment in segments]
    return [atom for atom in stream.atomic if not any(atom in text for text in texts)]


async def measure_aggregation() -> dict[str, Any]:
    results: dict[str, Any] = {}
    for mode in (AggregationType.SENTENCE, AggregationType.TOKEN):
        for arm, _ in _aggregators(mode).items():
            key = f"{mode.value}+{arm}"
            per_turn = []
            for stream in TURN_STREAMS:
                aggregator = _aggregators(mode)[arm]
                segments = await _segments(aggregator, stream)
                per_turn.append(
                    {
                        "turn": stream.name,
                        # The knob that decides when audio can start: how many
                        # streamed chunks the caller waits through before any
                        # text is handed to the synthesizer.
                        "chunks_to_first_segment": (
                            segments[0].chunk_index + 1 if segments else None
                        ),
                        "characters_to_first_segment": (
                            len(segments[0].text) if segments else None
                        ),
                        # Each segment opens its own Soniox stream, so this is
                        # also the number of seams a listener can hear.
                        "segments": len(segments),
                        "split_atoms": _split_atoms(segments, stream),
                        "segment_texts": [segment.text for segment in segments],
                    }
                )
            firsts = [
                row["chunks_to_first_segment"]
                for row in per_turn
                if row["chunks_to_first_segment"] is not None
            ]
            results[key] = {
                "turns": per_turn,
                "median_chunks_to_first_segment": (statistics.median(firsts) if firsts else None),
                "total_segments": sum(row["segments"] for row in per_turn),
                "total_split_atoms": sum(len(row["split_atoms"]) for row in per_turn),
            }
    return results


# --- Leading-silence trimming -------------------------------------------------


def _pcm(*, silence_ms: int, onset_ms: int, onset_amplitude: int, body_ms: int) -> bytes:
    """Silence, then a quiet onset, then a normal-level body.

    The quiet onset stands in for a Hebrew initial fricative — ש, ס, ח — whose
    energy is well below a vowel's. If trimming eats it, the first consonant of
    every such word is clipped, and "שלום" arrives as "לום".
    """
    import numpy as np

    def block(ms: int, amplitude: int, seed: int) -> np.ndarray:
        count = int(SAMPLE_RATE * ms / 1000)
        if count == 0:
            return np.zeros(0, dtype=np.int16)
        rng = np.random.default_rng(seed)
        return (rng.standard_normal(count) * amplitude).clip(-32768, 32767).astype(np.int16)

    return (
        np.concatenate(
            [
                np.zeros(int(SAMPLE_RATE * silence_ms / 1000), dtype=np.int16),
                block(onset_ms, onset_amplitude, 1),
                block(body_ms, 6000, 2),
            ]
        )
        .astype("<i2")
        .tobytes()
    )


async def _trim(audio: bytes, *, chunk_ms: int = 20) -> tuple[bytes, int]:
    """Push audio through the real processor in transport-sized chunks."""
    trim = TrimLeadingSilence()
    collected = bytearray()

    async def capture(frame: Frame, _direction: FrameDirection = FrameDirection.DOWNSTREAM):
        if isinstance(frame, TTSAudioRawFrame):
            collected.extend(frame.audio)

    trim.push_frame = capture  # type: ignore[method-assign]
    await trim.process_frame(TTSStartedFrame(context_id="c"), FrameDirection.DOWNSTREAM)
    step = int(SAMPLE_RATE * chunk_ms / 1000) * 2
    for offset in range(0, len(audio), step):
        await trim.process_frame(
            TTSAudioRawFrame(audio[offset : offset + step], SAMPLE_RATE, 1, context_id="c"),
            FrameDirection.DOWNSTREAM,
        )
    await trim.process_frame(TTSStoppedFrame(context_id="c"), FrameDirection.DOWNSTREAM)
    dropped_ms = round((len(audio) - len(collected)) / 2 / SAMPLE_RATE * 1000)
    return bytes(collected), dropped_ms


async def measure_trim() -> dict[str, Any]:
    cases = {
        # A generous silent head with a clearly voiced start: the case the
        # processor exists for.
        "loud_onset_after_300ms": dict(
            silence_ms=300, onset_ms=60, onset_amplitude=6000, body_ms=400
        ),
        # A soft fricative onset. Anything dropped past 300ms here is a clipped
        # Hebrew consonant, not headroom.
        "soft_fricative_onset_after_300ms": dict(
            silence_ms=300, onset_ms=80, onset_amplitude=500, body_ms=400
        ),
        "very_soft_onset_after_300ms": dict(
            silence_ms=300, onset_ms=80, onset_amplitude=200, body_ms=400
        ),
        # Soniox with no silent head at all: trimming must be a no-op.
        "no_leading_silence": dict(silence_ms=0, onset_ms=60, onset_amplitude=6000, body_ms=400),
        # An entirely silent response still has to reach the caller.
        "all_silence": dict(silence_ms=500, onset_ms=0, onset_amplitude=0, body_ms=0),
    }
    out: dict[str, Any] = {}
    for name, spec in cases.items():
        audio = _pcm(**spec)  # type: ignore[arg-type]
        trimmed, dropped_ms = await _trim(audio)
        out[name] = {
            "input_ms": round(len(audio) / 2 / SAMPLE_RATE * 1000),
            "dropped_ms": dropped_ms,
            "kept_ms": round(len(trimmed) / 2 / SAMPLE_RATE * 1000),
            "silence_ms": spec["silence_ms"],
            # Negative means the onset itself was eaten.
            "headroom_margin_ms": spec["silence_ms"] - dropped_ms,
        }
    return out


# --- Hebrew semantic-critical corpus ------------------------------------------


async def _spoken(case: SpokenCase) -> str:
    transform = make_speech_transformer(
        VoiceQualityConfig(language=case.language),  # type: ignore[arg-type]
        lambda: None,
        get_language=lambda: case.language,
    )
    return await transform(case.authored, None)


async def measure_corpus() -> dict[str, Any]:
    rows = []
    for case in SPOKEN_CORPUS:
        started = time.perf_counter()
        spoken = await _spoken(case)
        elapsed_ms = (time.perf_counter() - started) * 1000
        missing = [fragment for fragment in case.must_keep if fragment not in spoken]
        leaked = [fragment for fragment in case.must_lose if fragment in spoken]
        rows.append(
            {
                "name": case.name,
                "category": case.category,
                "language": case.language,
                "authored": case.authored,
                "spoken": spoken,
                "missing_required": missing,
                "leaked_forbidden": leaked,
                "critical_error": bool(missing or leaked),
                "transform_ms": round(elapsed_ms, 3),
            }
        )
    failures = [row for row in rows if row["critical_error"]]
    by_category: dict[str, dict[str, int]] = {}
    for row in rows:
        bucket = by_category.setdefault(row["category"], {"cases": 0, "critical_errors": 0})
        bucket["cases"] += 1
        bucket["critical_errors"] += int(row["critical_error"])
    return {
        "cases": len(rows),
        "critical_errors": len(failures),
        "by_category": by_category,
        "transform_p95_ms": (
            sorted(row["transform_ms"] for row in rows)[math.ceil(len(rows) * 0.95) - 1]
            if rows
            else None
        ),
        "rows": rows,
    }


# --- Report -------------------------------------------------------------------


def _markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Voice-quality benchmark (offline)",
        "",
        f"Generated {report['generated_at']} · pipecat {report['pipecat_version']}",
        "",
        "Provider-free. Measures aggregation boundaries, leading-silence trimming",
        "and Hebrew semantic preservation. Does NOT measure recognition accuracy,",
        "endpoint delay or anything audible — see the module docstring.",
        "",
        "## Hebrew semantic-critical corpus",
        "",
        f"{report['corpus']['cases']} cases · "
        f"**{report['corpus']['critical_errors']} critical errors**",
        "",
        "| category | cases | critical errors |",
        "| --- | ---: | ---: |",
    ]
    for category, counts in sorted(report["corpus"]["by_category"].items()):
        lines.append(f"| {category} | {counts['cases']} | {counts['critical_errors']} |")
    for row in report["corpus"]["rows"]:
        if row["critical_error"]:
            lines += [
                "",
                f"- **{row['name']}**: missing {row['missing_required']}, "
                f"leaked {row['leaked_forbidden']}",
                f"  - authored: `{row['authored']}`",
                f"  - spoken:   `{row['spoken']}`",
            ]
    lines += [
        "",
        "## TTS text aggregation",
        "",
        "`chunks to first segment` is what the caller waits through before any",
        "audio can start. `split atoms` counts prices, times, phone numbers and",
        "product names cut across two synthesis streams.",
        "",
        "| arm | median chunks to first segment | segments | split atoms |",
        "| --- | ---: | ---: | ---: |",
    ]
    for arm, data in report["aggregation"].items():
        lines.append(
            f"| {arm} | {data['median_chunks_to_first_segment']} | "
            f"{data['total_segments']} | {data['total_split_atoms']} |"
        )
    lines += [
        "",
        "## Leading-silence trimming",
        "",
        "`headroom margin` is silence present minus audio dropped. Negative means",
        "the onset itself was clipped — a lost Hebrew initial consonant.",
        "",
        "| case | input ms | dropped ms | headroom margin ms |",
        "| --- | ---: | ---: | ---: |",
    ]
    for name, data in report["trim"].items():
        lines.append(
            f"| {name} | {data['input_ms']} | {data['dropped_ms']} | {data['headroom_margin_ms']} |"
        )
    return "\n".join(lines) + "\n"


async def build_report() -> dict[str, Any]:
    import importlib.metadata as metadata

    corpus, aggregation, trim = (
        await measure_corpus(),
        await measure_aggregation(),
        await measure_trim(),
    )
    return {
        "schema_version": "1.0",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "pipecat_version": metadata.version("pipecat-ai"),
        "sample_rate": SAMPLE_RATE,
        "provider_backed": False,
        "corpus": corpus,
        "aggregation": aggregation,
        "trim": trim,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ARTIFACTS)
    arguments = parser.parse_args()

    report = asyncio.run(build_report())
    arguments.output.mkdir(parents=True, exist_ok=True)
    (arguments.output / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (arguments.output / "report.md").write_text(_markdown(report), encoding="utf-8")
    print(f"wrote {arguments.output / 'report.json'}")
    print(f"wrote {arguments.output / 'report.md'}")
    print(
        f"corpus: {report['corpus']['cases']} cases, "
        f"{report['corpus']['critical_errors']} critical errors"
    )
    # Non-zero on a semantic regression so this is usable as a gate, not just a
    # report nobody reads.
    return 1 if report["corpus"]["critical_errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
