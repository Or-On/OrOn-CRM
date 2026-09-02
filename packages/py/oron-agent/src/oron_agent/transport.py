from collections.abc import Callable

# Pinned (Pipecat 1.5.0): LiveKitParams lives in .transport, NOT the package top level.
from oron_common import CallContext
from pipecat.audio.filters.base_audio_filter import BaseAudioFilter
from pipecat.transports.livekit.transport import LiveKitParams

ParamsFactory = Callable[[], LiveKitParams]
TransportRegistry = dict[str, ParamsFactory]


def _livekit_params(audio_in_filter: BaseAudioFilter | None = None) -> LiveKitParams:
    return LiveKitParams(
        audio_in_enabled=True, audio_out_enabled=True, audio_in_filter=audio_in_filter
    )


def default_registry(audio_in_filter: BaseAudioFilter | None = None) -> TransportRegistry:
    """The default provider→params-factory registry. Returned fresh so callers
    can extend it without mutating shared state. The filter is INJECTED."""
    return {"livekit": lambda: _livekit_params(audio_in_filter)}


def build_transport_params(
    ctx: CallContext,
    registry: TransportRegistry | None = None,
    audio_in_filter: BaseAudioFilter | None = None,
) -> dict[str, ParamsFactory]:
    """Resolve the params factory for ``ctx.provider``. The registry is INJECTED
    (dependency injection) — defaults to ``default_registry()`` but tests/callers
    may pass their own. No module-level mutable global."""
    registry = registry if registry is not None else default_registry(audio_in_filter)
    if ctx.provider not in registry:
        raise ValueError(
            f"Unknown transport provider '{ctx.provider}'. Registered: {sorted(registry)}"
        )
    return {ctx.provider: registry[ctx.provider]}
