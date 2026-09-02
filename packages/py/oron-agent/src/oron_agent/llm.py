"""Which LLM the agent runs.

Vertex Gemini by default. `openai-compat` points the OpenAI client at any
compatible endpoint — Cohere's `/compatibility/v1`, vLLM, OpenAI itself — so a
provider can be evaluated against a real call without a code change.
"""

from enum import StrEnum
from typing import Any

from loguru import logger
from pipecat.adapters.services.gemini_adapter import GeminiLLMAdapter
from pipecat.adapters.services.open_ai_adapter import OpenAILLMAdapter
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.services.google.vertex.llm import GoogleVertexLLMService
from pipecat.services.llm_service import LLMService
from pipecat.services.openai.llm import OpenAILLMService


class LlmProvider(StrEnum):
    VERTEX = "vertex"
    OPENAI_COMPAT = "openai-compat"


class _BoundedOpenAILLMService(OpenAILLMService):
    """An OpenAI-compatible service whose completions cannot hang forever.

    `create_client` hardcodes `DefaultAsyncHttpxClient` and ignores kwargs, so
    the only reachable seam is the per-request timeout — which the SDK applies
    to the read gap between stream chunks too, and so bounds the case that
    actually bit: a request accepted with no token ever sent.
    """

    def __init__(self, *args, request_timeout_secs: float, **kwargs):
        super().__init__(*args, **kwargs)
        self._request_timeout_secs = request_timeout_secs

    def build_chat_completion_params(self, params_from_context) -> dict:
        params = super().build_chat_completion_params(params_from_context)
        params["timeout"] = self._request_timeout_secs
        return params


def build_llm(
    provider: LlmProvider,
    *,
    project_id: str,
    location: str,
    credentials_path: str | None,
    vertex_model: str,
    thinking_budget: int,
    api_key: str,
    base_url: str,
    model: str,
    request_timeout_secs: float = 5.0,
) -> LLMService[GeminiLLMAdapter] | LLMService[OpenAILLMAdapter]:
    if provider is LlmProvider.OPENAI_COMPAT:
        return _BoundedOpenAILLMService(
            api_key=api_key,
            base_url=base_url,
            settings=OpenAILLMService.Settings(model=model),
            request_timeout_secs=request_timeout_secs,
        )
    return GoogleVertexLLMService(
        project_id=project_id,
        location=location,
        credentials_path=credentials_path,
        settings=GoogleVertexLLMService.Settings(
            model=vertex_model,
            # Thinking off by default — see config.vertex_thinking_budget.
            thinking=GoogleVertexLLMService.ThinkingConfig(thinking_budget=thinking_budget),
        ),
    )


async def warm_prompt_cache(llm: LLMService[Any], context: LLMContext) -> None:
    """Prefill the provider's prompt cache before the caller's first turn.

    Every call's first request reads `cached=0` and takes 3.8-4.0s to first
    token, against 312-607ms once warm — paid at the moment a caller decides
    whether to stay on the line.

    `run_inference` is pipecat's own out-of-band seam and builds its params
    through the same adapter as a real turn, so the prefix — tools included —
    matches byte for byte. A hand-rolled request that omitted the tools block
    would warm a prefix nothing else ever sends.

    Never raises: a call must not fail because an optimisation did.
    """
    try:
        await llm.run_inference(context, max_tokens=1)
    except Exception:
        logger.warning("prompt-cache warm-up failed; the first turn pays the cold cost")
