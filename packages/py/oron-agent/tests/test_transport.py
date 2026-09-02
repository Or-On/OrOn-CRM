import uuid

import pytest
from oron_agent.audio import AudioInFilter, build_audio_in_filter
from oron_agent.transport import build_transport_params
from oron_common import CallContext

TENANT_ID = uuid.UUID("00000000-0000-0000-0000-0000000000aa")

FLOW_ID = uuid.uuid4()


def _ctx() -> CallContext:
    return CallContext(
        call_id="c1", provider="livekit", direction="inbound", flow_id=FLOW_ID, tenant_id=TENANT_ID
    )


def test_returns_livekit_factory():
    ctx = CallContext(
        call_id="c1", provider="livekit", direction="inbound", flow_id=FLOW_ID, tenant_id=TENANT_ID
    )
    params = build_transport_params(ctx)
    assert set(params.keys()) == {"livekit"}
    built = params["livekit"]()
    assert built.audio_in_enabled is True
    assert built.audio_out_enabled is True


def test_unknown_provider_raises():
    ctx = CallContext.model_construct(
        provider="daily", call_id="c", direction="inbound", session_id="s"
    )
    with pytest.raises(ValueError):
        build_transport_params(ctx)


def test_registry_is_injectable():
    # DI: a caller-supplied registry is honored instead of the default.
    sentinel = object()
    ctx = CallContext(
        call_id="c1", provider="livekit", direction="inbound", flow_id=FLOW_ID, tenant_id=TENANT_ID
    )
    params = build_transport_params(ctx, registry={"livekit": lambda: sentinel})
    assert params["livekit"]() is sentinel


async def test_filter_reaches_the_transport_params():
    f = await build_audio_in_filter(AudioInFilter.RNNOISE)
    built = build_transport_params(_ctx(), audio_in_filter=f)["livekit"]()
    assert built.audio_in_filter is f
    await f.stop()


def test_no_filter_by_default():
    """Callers that pass nothing get today's behaviour — an unfiltered path."""
    built = build_transport_params(_ctx())["livekit"]()
    assert built.audio_in_filter is None
