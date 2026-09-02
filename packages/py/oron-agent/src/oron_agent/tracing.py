"""OpenTelemetry tracing for the agent, exported to a self-hosted Phoenix.

Two layers, and both are needed:

`PipelineWorker(enable_tracing=…)` builds the turn tracker, the latency tracker
and the trace observer, ends the conversation span at shutdown, and propagates
the flag through `StartFrame` so every LLM, TTS and STT service emits a span at
all. That is what produces the shape of a trace.

`PipecatInstrumentor` translates those spans into OpenInference conventions, and
without it Phoenix prices every call at $0. Pipecat writes OpenTelemetry GenAI
attributes (`gen_ai.usage.input_tokens`); Phoenix's cost engine reads
OpenInference ones (`llm.token_count.prompt`). Measured on real calls: the tokens
were on the span the whole time — 926 in, 15 out — while Phoenix reported
`tokenCountPrompt=0` and no cost, because it was reading a key nothing wrote.
Pricing the model changes nothing on its own; this is the missing half.

It must run before the pipeline is built: it patches pipecat's own classes, and
anything constructed first keeps the unpatched methods.

A trace is a call and a span is a turn, so a timing arrives already attached to
the text that produced it, which no log line joined by wall clock can do. The
span store is deliberately NOT the session row: the row holds what a call
consumed — `tenant_id`, `flow_id`, cost — under RLS, and that is what the console
renders; traces answer why a particular call was slow.
"""

from loguru import logger
from openinference.instrumentation.pipecat import PipecatInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from oron_common import CallContext
from pipecat.utils.tracing.setup import setup_tracing


def conversation_span_attributes(ctx: CallContext) -> dict[str, str]:
    """The tags every span in one call's trace carries.

    `direction` is here because a browser rehearsal and a voter's call are
    otherwise indistinguishable in Phoenix, which silently mixes test traffic
    into the campaign's numbers — `Direction` exists for that reason and was
    simply never exported. `call_id` joins a trace to the SIP signalling without
    matching on wall clock.

    **No phone number, deliberately.** Phoenix runs unauthenticated with the
    firewall as its only control, and these spans already hold the caller's
    speech. The number lives encrypted on the session row behind RLS; identity
    stays reachable from `conversation.id`, which IS the session_id.
    """
    return {
        "tenant_id": str(ctx.tenant_id),
        "flow_id": str(ctx.flow_id),
        "direction": ctx.direction,
        "call_id": ctx.call_id,
    }


def setup_process_tracing(*, service_name: str, endpoint: str) -> None:
    """Install the exporter and the instrumentor for THIS PROCESS, before the
    pipeline is built. Call once at startup.

    Not per call: the agent runs as an asyncio task inside the dispatcher, so a
    per-call setup would re-register a global provider for every caller — and
    re-instrumenting patched classes on every caller besides.

    The gRPC exporter connects lazily and retries in the background, so a
    Phoenix that is down costs dropped spans, never a failed call.
    """
    ok = setup_tracing(
        service_name=service_name,
        exporter=OTLPSpanExporter(endpoint=endpoint, insecure=True),
    )
    if not ok:
        logger.info(f"tracing FAILED to initialise -> {endpoint}")
        return

    # The provider setup_tracing just registered — passed explicitly rather than
    # left to the instrumentor's own lookup, so the two cannot disagree about
    # where spans go.
    PipecatInstrumentor().instrument(tracer_provider=trace.get_tracer_provider())
    logger.info(f"tracing on (openinference) -> {endpoint}")
