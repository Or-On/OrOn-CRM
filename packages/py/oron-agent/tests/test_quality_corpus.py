"""Fixture-driven production renderer regression; never a claimed acoustic score."""

import json
from pathlib import Path

import pytest
from oron_agent.grounding import render_reply

CORPUS = json.loads(
    (Path(__file__).parent / "fixtures/voice-quality-v1.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", CORPUS["cases"], ids=lambda case: case["id"])
def test_curated_adversarial_boundaries(case):
    reply = render_reply(case["modelOutput"], [], "he")
    assert reply.decision == case["expectedDecision"]
    assert case["audioReference"] is None
    # No receipt can be manufactured from a transcript, including a summary.
    if case["category"] in {"claim", "injection", "summary-claim"}:
        assert reply.evidence == {}


def test_corpus_covers_all_fourteen_release_families_without_audio_claims():
    assert len({case["scenario"] for case in CORPUS["cases"]}) == 14
    assert {case["partition"] for case in CORPUS["cases"]} == {"development", "reserved-regression"}
    assert all(case["providerValidation"] == "PENDING" for case in CORPUS["cases"])
