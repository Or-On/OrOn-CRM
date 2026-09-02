"""Read-only verification for the local Redis-backed LiveKit SIP control plane."""

from __future__ import annotations

import argparse
import asyncio
import os
from dataclasses import dataclass


class VoiceProfileVerificationError(RuntimeError):
    """The local voice control plane is unavailable or unsafe to probe."""


@dataclass(frozen=True)
class VoiceProfileState:
    inbound_trunks: int
    outbound_trunks: int
    dispatch_rules: int


def validate_local_credentials(api_key: str, api_secret: str) -> None:
    """Require non-placeholder local credentials without exposing their values."""
    if not api_key.strip():
        raise VoiceProfileVerificationError("LIVEKIT_API_KEY is required for the voice profile")
    if ":" in api_key or any(character.isspace() for character in api_key):
        raise VoiceProfileVerificationError("LIVEKIT_API_KEY contains an unsupported character")
    if (api_key, api_secret) == ("devkey", "secret"):
        raise VoiceProfileVerificationError("the upstream placeholder LiveKit key pair is refused")
    if len(api_secret) < 32:
        raise VoiceProfileVerificationError(
            "LIVEKIT_API_SECRET must contain at least 32 characters"
        )


async def inspect_control_plane(*, url: str, api_key: str, api_secret: str) -> VoiceProfileState:
    """List SIP resources through LiveKit without creating or changing any state."""
    validate_local_credentials(api_key, api_secret)
    try:
        from livekit import api
    except ModuleNotFoundError as error:
        raise VoiceProfileVerificationError(
            "voice dependencies are missing; run `make voice-bootstrap`"
        ) from error

    client = api.LiveKitAPI(url, api_key, api_secret)
    try:
        inbound = await client.sip.list_inbound_trunk(api.ListSIPInboundTrunkRequest())
        outbound = await client.sip.list_outbound_trunk(api.ListSIPOutboundTrunkRequest())
        rules = await client.sip.list_dispatch_rule(api.ListSIPDispatchRuleRequest())
    except Exception as error:
        raise VoiceProfileVerificationError(
            "LiveKit SIP read-only control-plane probe failed"
        ) from error
    finally:
        await client.aclose()

    return VoiceProfileState(
        inbound_trunks=len(inbound.items),
        outbound_trunks=len(outbound.items),
        dispatch_rules=len(rules.items),
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    return parser


def main() -> None:
    arguments = _parser().parse_args()
    api_key = os.environ.get("LIVEKIT_API_KEY", "")
    api_secret = os.environ.get("LIVEKIT_API_SECRET", "")
    state = asyncio.run(
        inspect_control_plane(
            url=arguments.url,
            api_key=api_key,
            api_secret=api_secret,
        )
    )
    print(
        "LiveKit SIP control plane ready (read-only): "
        f"inbound_trunks={state.inbound_trunks}, "
        f"outbound_trunks={state.outbound_trunks}, "
        f"dispatch_rules={state.dispatch_rules}"
    )


if __name__ == "__main__":
    main()
