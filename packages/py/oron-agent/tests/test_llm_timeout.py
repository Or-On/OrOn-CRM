"""A completion that never answers must not hold the call.

Measured live 2026-08-05 06:03 on session b728717f: Cerebras accepted a request
and sent no token. `OpenAILLMService.process_frame` awaits the completion inline,
so the whole pipeline stopped for 21.8s until teardown cancelled it — the caller
heard nothing and hung up.

Nothing bounded it. `create_client` builds `DefaultAsyncHttpxClient` with limits
and no timeout, so the OpenAI SDK's own 600s default applied. pipecat's
`retry_on_timeout` is off by default and is the wrong lever anyway: its retry is
issued *without* a timeout, and its `wait_for` wraps only the `create()` call,
not the iteration of the stream a token never arrives on.
"""

from __future__ import annotations

import asyncio
import time

import pytest
from oron_agent.config import Settings
from oron_agent.llm import LlmProvider, build_llm
from pipecat.processors.aggregators.llm_context import LLMContext


async def _server_that_accepts_and_never_answers(release: asyncio.Event):
    """Exactly the failure being fixed: TCP connects, HTTP never replies.

    A refused connection would prove nothing — that fails fast on its own. The
    handler waits on `release` rather than sleeping, so teardown does not have to
    outlast the stall it is simulating.
    """

    async def hold(reader, writer):
        await reader.read(65536)
        await release.wait()
        writer.close()

    server = await asyncio.start_server(hold, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1]


def _llm(timeout_secs: float, port: int):
    return build_llm(
        LlmProvider.OPENAI_COMPAT,
        project_id="p",
        location="global",
        credentials_path=None,
        vertex_model="unused",
        thinking_budget=0,
        api_key="test",
        base_url=f"http://127.0.0.1:{port}/v1",
        model="test-model",
        request_timeout_secs=timeout_secs,
    )


async def test_a_completion_that_never_answers_gives_up():
    """Break it on purpose: drop the timeout from build_chat_completion_params
    and this hangs for the SDK's 600s default instead of failing in ~1s."""
    release = asyncio.Event()
    server, port = await _server_that_accepts_and_never_answers(release)
    try:
        llm = _llm(1.0, port)
        context = LLMContext(messages=[{"role": "user", "content": "hello"}])

        began = time.monotonic()
        try:
            # Bounded so a regression fails the suite instead of hanging it —
            # far enough above the 1s under test to survive the SDK's retries.
            with pytest.raises(Exception):
                await asyncio.wait_for(llm.run_inference(context), timeout=30.0)
        except TimeoutError:
            pytest.fail(
                "the request is unbounded — this is the 21.8s of dead air on "
                "session b728717f, and without a timeout it runs to the SDK's 600s"
            )
        elapsed = time.monotonic() - began

        assert elapsed < 15.0, f"gave up only after {elapsed:.1f}s"
    finally:
        release.set()
        server.close()
        await server.wait_closed()


def test_the_timeout_reaches_the_request():
    """The knob must land on the call, not merely exist on Settings."""
    llm = _llm(3.25, 1)
    params = llm.build_chat_completion_params(
        {"model": "test-model", "messages": [], "stream": True}
    )
    assert params["timeout"] == 3.25


def test_the_shipped_default_is_far_above_a_healthy_turn():
    """~0.4s is the median time to first token; anything near that would abandon
    turns that were merely slow."""
    assert Settings.model_fields["llm_request_timeout_secs"].default == 5.0
