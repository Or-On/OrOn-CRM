"""Lowest-boundary LiveKit SIP adapter and real-provider safety gate."""

from __future__ import annotations

from collections.abc import Callable

from livekit import api


class RealTelephonyDenied(RuntimeError):
    """A safe denial containing no provider credentials or phone number."""


def require_real_telephony(*, enabled: bool, explicit_approval: bool) -> None:
    if not enabled:
        raise RealTelephonyDenied("real telephony is disabled")
    if not explicit_approval:
        raise RealTelephonyDenied("real telephony requires explicit per-action approval")


class SipClient:
    """Place an outbound SIP leg only after both real-action gates pass."""

    def __init__(
        self,
        *,
        url: str,
        api_key: str,
        api_secret: str,
        trunk_id: str | None,
        enabled: bool,
        api_factory: Callable[..., api.LiveKitAPI] = api.LiveKitAPI,
    ) -> None:
        self._url = url
        self._api_key = api_key
        self._api_secret = api_secret
        self._trunk_id = trunk_id
        self._enabled = enabled
        self._api_factory = api_factory

    @property
    def configured(self) -> bool:
        return bool(self._trunk_id)

    def authorize(self, *, explicit_approval: bool) -> None:
        """Fail before lifecycle work; ``dial`` repeats this at the provider edge."""

        require_real_telephony(enabled=self._enabled, explicit_approval=explicit_approval)
        if not self._trunk_id:
            raise RealTelephonyDenied("outbound SIP trunk is not configured")

    async def dial(
        self,
        *,
        room: str,
        phone_number: str,
        identity: str,
        explicit_approval: bool,
    ) -> None:
        self.authorize(explicit_approval=explicit_approval)
        livekit = self._api_factory(self._url, self._api_key, self._api_secret)
        try:
            await livekit.sip.create_sip_participant(
                api.CreateSIPParticipantRequest(
                    sip_trunk_id=self._trunk_id,
                    sip_call_to=phone_number,
                    room_name=room,
                    participant_identity=identity,
                    wait_until_answered=False,
                )
            )
        finally:
            await livekit.aclose()
