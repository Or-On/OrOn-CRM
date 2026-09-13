from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from oron_agent.llm import (
    LlmPreflightError,
    LlmProvider,
    LlmReasoningEffort,
    verify_llm_access,
)


class ProviderFailure(RuntimeError):
    def __init__(self, *, status_code: int, code: str) -> None:
        self.status_code = status_code
        self.body = {"code": code, "message": "must never reach the operator"}


def _settings():
    secret = SimpleNamespace(get_secret_value=lambda: "fixture-secret")
    return SimpleNamespace(
        llm_provider=LlmProvider.OPENAI_COMPAT,
        google_cloud_project="",
        vertex_location="global",
        google_application_credentials=None,
        vertex_llm_model="unused",
        vertex_thinking_budget=0,
        llm_api_key=secret,
        llm_base_url="https://provider.invalid/v1",
        llm_model="fixture-model",
        llm_reasoning_effort=LlmReasoningEffort.NONE,
        llm_temperature=0.4,
        llm_max_tokens=256,
        llm_request_timeout_secs=1.0,
    )


async def test_preflight_uses_no_customer_data_and_cleans_up() -> None:
    llm = SimpleNamespace(run_inference=AsyncMock(return_value="OK"), cleanup=AsyncMock())

    with patch("oron_agent.llm.build_llm", return_value=llm):
        await verify_llm_access(_settings())

    context = llm.run_inference.await_args.args[0]
    assert context.messages == [{"role": "user", "content": "Reply OK."}]
    assert llm.run_inference.await_args.kwargs == {"max_tokens": 1}
    llm.cleanup.assert_awaited_once()


@pytest.mark.parametrize(
    ("status", "code", "expected"),
    [
        (402, "payment_required", "billing or quota"),
        (404, "model_not_found", "unavailable or not authorized"),
        (401, "invalid_api_key", "credentials or model permission"),
        (429, "rate_limit_exceeded", "rate limited"),
        (503, "server_error", "temporarily unavailable"),
    ],
)
async def test_preflight_maps_provider_failures_without_leaking_bodies(
    status: int, code: str, expected: str
) -> None:
    llm = SimpleNamespace(
        run_inference=AsyncMock(side_effect=ProviderFailure(status_code=status, code=code)),
        cleanup=AsyncMock(),
    )

    with (
        patch("oron_agent.llm.build_llm", return_value=llm),
        pytest.raises(LlmPreflightError, match=expected) as captured,
    ):
        await verify_llm_access(_settings())

    assert "must never reach" not in str(captured.value)
    llm.cleanup.assert_awaited_once()
