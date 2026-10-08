import pytest
from oron_common import CallUsage, PriceBook, price


def test_physical_attempt_cost_uses_its_model_and_reasoning_is_a_subset():
    usage = CallUsage()
    usage.enable_model_attempt_accounting()
    usage.record_model_attempt({"model": "gemini-3.5-flash-lite", "usage": None})
    usage.record_model_attempt(
        {
            "model": "gemini-3.1-flash-lite",
            "usage": {
                "prompt_tokens": 1000,
                "completion_tokens": 100,
                "prompt_tokens_details": {
                    "audio_tokens": 400,
                    "cached_tokens": 100,
                    "cached_audio_tokens": 40,
                },
                "completion_tokens_details": {"reasoning_tokens": 20},
            },
        }
    )
    cost = price(usage, PriceBook())
    assert cost.llm == pytest.approx(
        (540 * 0.25 + 60 * 0.025 + 360 * 0.5 + 40 * 0.05 + 100 * 1.5) / 1_000_000
    )
    assert cost.unpriced == ["gemini-3.5-flash-lite:usage_unknown"]
    assert usage.llm_completion_tokens == 100
    assert usage.llm_usage_by_model["gemini-3.1-flash-lite"]["reasoning"] == 20


def test_unknown_audio_cache_overlap_is_explicit_not_a_guessed_discount():
    usage = CallUsage()
    usage.record_model_attempt(
        {
            "model": "gemini-3.1-flash-lite",
            "usage": {
                "prompt_tokens": 1000,
                "completion_tokens": 100,
                "prompt_tokens_details": {"audio_tokens": 400, "cached_tokens": 100},
            },
        }
    )
    assert "gemini-3.1-flash-lite:audio_unpriced" in price(usage, PriceBook()).unpriced
