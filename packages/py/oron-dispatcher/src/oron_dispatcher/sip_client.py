"""Lowest-boundary LiveKit SIP adapter and real-provider safety gate."""

from __future__ import annotations

from collections.abc import Callable
from uuid import UUID

from livekit import api

from oron_dispatcher.outbound_routing import OutboundRoute, validate_routes


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
        routes: tuple[OutboundRoute, ...] = (),
        enabled: bool,
        api_factory: Callable[..., api.LiveKitAPI] = api.LiveKitAPI,
    ) -> None:
        self._url = url
        self._api_key = api_key
        self._api_secret = api_secret
        self._routes = {route.tenant_id: route for route in validate_routes(routes)}
        self._enabled = enabled
        self._api_factory = api_factory

    @property
    def configured(self) -> bool:
        return bool(self._routes)

    def authorize(self, *, tenant_id: UUID, explicit_approval: bool) -> OutboundRoute:
        """Fail before lifecycle work; ``dial`` repeats this at the provider edge."""

        require_real_telephony(enabled=self._enabled, explicit_approval=explicit_approval)
        route = self._routes.get(tenant_id)
        if route is None:
            raise RealTelephonyDenied("tenant outbound SIP trunk and sender are not configured")
        return route

    async def dial(
        self,
        *,
        room: str,
        phone_number: str,
        identity: str,
        tenant_id: UUID,
        route: OutboundRoute,
        explicit_approval: bool,
    ) -> None:
        current = self.authorize(tenant_id=tenant_id, explicit_approval=explicit_approval)
        if route != current:
            raise RealTelephonyDenied("outbound SIP route does not match the tenant binding")
        livekit = self._api_factory(self._url, self._api_key, self._api_secret)
        try:
            try:
                inventory = await livekit.sip.list_outbound_trunk(
                    api.ListSIPOutboundTrunkRequest(trunk_ids=[route.trunk_id])
                )
            except Exception:
                raise RealTelephonyDenied(
                    "outbound SIP provider binding could not be verified"
                ) from None
            matches = [t for t in inventory.items if t.sip_trunk_id == route.trunk_id]
            if (
                len(matches) != 1
                or route.from_number not in matches[0].numbers
                or matches[0].address.casefold() != route.address.casefold()
            ):
                raise RealTelephonyDenied("outbound SIP provider trunk or sender binding mismatch")
            await livekit.sip.create_sip_participant(
                api.CreateSIPParticipantRequest(
                    sip_trunk_id=route.trunk_id,
                    sip_number=route.from_number,
                    sip_call_to=phone_number,
                    room_name=room,
                    participant_identity=identity,
                    wait_until_answered=False,
                )
            )
        finally:
            await livekit.aclose()
