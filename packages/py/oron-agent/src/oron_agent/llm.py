"""Which LLM the agent runs.

Vertex Gemini by default. `openai-compat` points the OpenAI client at any
compatible endpoint — Cohere's `/compatibility/v1`, vLLM, OpenAI itself — so a
provider can be evaluated against a real call without a code change.
"""

from contextlib import suppress
from enum import StrEnum
from typing import Any

from google.genai.types import HttpOptions
from loguru import logger
from pipecat.adapters.services.gemini_adapter import GeminiLLMAdapter, GeminiLLMInvocationParams
from pipecat.adapters.services.open_ai_adapter import OpenAILLMAdapter
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.services.google.vertex.llm import GoogleVertexLLMService
from pipecat.services.llm_service import LLMService
from pipecat.services.openai.llm import OpenAILLMService

from oron_agent.provider_context import fold_instructions


class LlmPreflightError(RuntimeError):
    """The configured conversational model cannot accept a safe probe."""

    def __init__(self, public_reason: str) -> None:
        self.public_reason = public_reason
        super().__init__(public_reason)


def _provider_error_code(error: Exception) -> tuple[int | None, str | None]:
    status = getattr(error, "status_code", None)
    body = getattr(error, "body", None)
    code = body.get("code") if isinstance(body, dict) else None
    return status if isinstance(status, int) else None, code if isinstance(code, str) else None


def _safe_preflight_message(status: int | None, code: str | None) -> str:
    """Map provider failures without exposing prompts, endpoints, or credentials."""

    if status == 402 or code == "payment_required":
        return "LLM provider billing or quota is unavailable"
    if status in (401, 403):
        return "LLM provider credentials or model permission are invalid"
    if status == 404 or code == "model_not_found":
        return "configured LLM model is unavailable or not authorized"
    if status == 429:
        return "LLM provider is rate limited"
    if status is not None and status >= 500:
        return "LLM provider is temporarily unavailable"
    return "LLM provider preflight failed"


class LlmProvider(StrEnum):
    VERTEX = "vertex"
    OPENAI_COMPAT = "openai-compat"


class LlmReasoningEffort(StrEnum):
    """Portable reasoning levels accepted by supported compatible providers."""

    NONE = "none"
    MINIMAL = "minimal"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


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

    @staticmethod
    def _without_empty_tool_calls(messages: list[Any]) -> list[Any]:
        """Remove provider-generated placeholder tool calls with no identity.

        Google's OpenAI-compatible stream can emit an empty tool-call delta
        immediately before the real, named call. Pipecat 1.8.1 retains both as
        completed context entries. On the next node Gemini converts the empty
        pair to a native ``function_response`` whose name is empty and rejects
        the entire request with HTTP 400. The placeholder has no callable name,
        arguments or result, so it carries no conversational information.

        Copy only messages that need changing; the shared LLM context must stay
        untouched because the other processors still own it.
        """

        cleaned: list[Any] = []
        valid_call_ids: set[str] = set()
        for message in messages:
            if not isinstance(message, dict) or message.get("role") != "assistant":
                cleaned.append(message)
                continue
            tool_calls = message.get("tool_calls")
            if not isinstance(tool_calls, list):
                cleaned.append(message)
                continue
            valid_calls = [
                call
                for call in tool_calls
                if isinstance(call, dict)
                and isinstance(call.get("id"), str)
                and bool(call["id"].strip())
                and isinstance(call.get("function"), dict)
                and isinstance(call["function"].get("name"), str)
                and bool(call["function"]["name"].strip())
            ]
            valid_call_ids.update(call["id"] for call in valid_calls)
            if valid_calls:
                cleaned.append({**message, "tool_calls": valid_calls})
            elif message.get("content"):
                cleaned.append(
                    {key: value for key, value in message.items() if key != "tool_calls"}
                )

        # A placeholder tool result follows its placeholder assistant call.
        # Keep only results whose call survived the pass above. Ordinary
        # contexts without tool calls are returned byte-for-byte equivalent.
        return [
            message
            for message in cleaned
            if not (
                isinstance(message, dict)
                and message.get("role") == "tool"
                and message.get("tool_call_id") not in valid_call_ids
            )
        ]

    def build_chat_completion_params(self, params_from_context) -> dict:
        params = super().build_chat_completion_params(params_from_context)
        # Pipecat includes both names in the dict, with one set to a NotGiven
        # sentinel. Its out-of-band inference then sees the newer key merely
        # *present*, replaces it with an integer, and Google rejects the request
        # because the configured legacy max_tokens remains alongside it. Keep
        # exactly one real limit so preflight/warm-up and streamed calls agree.
        if isinstance(params.get("max_tokens"), int):
            params.pop("max_completion_tokens", None)
        elif isinstance(params.get("max_completion_tokens"), int):
            params.pop("max_tokens", None)
        messages = params.get("messages")
        if isinstance(messages, list):
            # The adapter has already placed the tenant role (the service
            # system_instruction) first. Every later instruction, including
            # Pipecat's `developer` tool notes, is folded behind it: this
            # endpoint otherwise keeps only the last one and drops the tenant
            # identity. An opener with no conversation yet gets an explicit
            # non-customer call-start event; see provider_context.
            instruction, conversation = fold_instructions(self._without_empty_tool_calls(messages))
            params["messages"] = (
                [{"role": "system", "content": instruction}, *conversation]
                if instruction
                else conversation
            )
        params["timeout"] = self._request_timeout_secs
        return params


class _SingleInstructionGeminiAdapter(GeminiLLMAdapter):
    """Send every context instruction inside Gemini's one system instruction.

    The stock adapter discards an initial context system message whenever the
    service has a system_instruction (the FlowManager role), and turns later
    system messages into ``user`` turns. The first dropped the node task; the
    second made the evidence policy look like the caller's latest turn.
    """

    def get_llm_invocation_params(
        self, context: LLMContext, *, system_instruction: str | None = None
    ) -> GeminiLLMInvocationParams:
        instruction, conversation = fold_instructions(
            self.get_messages(context), system_instruction
        )
        folded = LLMContext(
            messages=conversation, tools=context.tools, tool_choice=context.tool_choice
        )
        return super().get_llm_invocation_params(folded, system_instruction=instruction)


class _SingleInstructionVertexLLMService(GoogleVertexLLMService):
    adapter_class = _SingleInstructionGeminiAdapter


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
    reasoning_effort: LlmReasoningEffort | None = None,
    temperature: float = 0.4,
    max_tokens: int = 256,
    request_timeout_secs: float = 5.0,
) -> LLMService[GeminiLLMAdapter] | LLMService[OpenAILLMAdapter]:
    if provider is LlmProvider.OPENAI_COMPAT:
        extra: dict[str, Any] = {}
        if reasoning_effort is not None:
            extra["reasoning_effort"] = reasoning_effort.value
        return _BoundedOpenAILLMService(
            api_key=api_key,
            base_url=base_url,
            settings=OpenAILLMService.Settings(
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                extra=extra,
            ),
            request_timeout_secs=request_timeout_secs,
        )
    return _SingleInstructionVertexLLMService(
        project_id=project_id,
        location=location,
        credentials_path=credentials_path,
        http_options=HttpOptions(timeout=max(1, round(request_timeout_secs * 1000))),
        settings=GoogleVertexLLMService.Settings(
            model=vertex_model,
            max_tokens=max_tokens,
            temperature=temperature,
            # Thinking off by default — see config.vertex_thinking_budget.
            thinking=GoogleVertexLLMService.ThinkingConfig(thinking_budget=thinking_budget),
        ),
    )


async def verify_llm_access(settings: Any) -> None:
    """Prove the selected model can answer before a paid telephone leg starts.

    The probe contains no customer data and asks for a single token. It runs
    once per dispatcher process (the launcher owns that cache), rather than on
    every call. Catalog/list-model responses are insufficient: providers can
    list models that the current account cannot infer with.
    """

    llm = build_llm(
        settings.llm_provider,
        project_id=settings.google_cloud_project,
        location=settings.vertex_location,
        credentials_path=settings.google_application_credentials,
        vertex_model=settings.vertex_llm_model,
        thinking_budget=settings.vertex_thinking_budget,
        api_key=settings.llm_api_key.get_secret_value(),
        base_url=settings.llm_base_url,
        model=settings.llm_model,
        reasoning_effort=settings.llm_reasoning_effort,
        temperature=settings.llm_temperature,
        max_tokens=settings.llm_max_tokens,
        request_timeout_secs=settings.llm_request_timeout_secs,
    )
    try:
        await llm.run_inference(
            LLMContext(messages=[{"role": "user", "content": "Reply OK."}]),
            max_tokens=1,
        )
    except Exception as error:
        status, code = _provider_error_code(error)
        logger.error("LLM preflight failed (status={}, code={})", status, code or "unknown")
        raise LlmPreflightError(_safe_preflight_message(status, code)) from None
    finally:
        with suppress(Exception):
            await llm.cleanup()


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
