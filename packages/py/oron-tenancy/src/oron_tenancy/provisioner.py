from typing import Protocol

from livekit import api
from loguru import logger

from oron_tenancy.reconcile import DispatchRuleSnapshot


class SipProvisioner(Protocol):
    """Provisions the SIP admission for a tenant's DID.

    A per-DID rule means LiveKit creates a room only for numbers a tenant owns;
    an unregistered DID matches nothing, so no room, webhook or bot is made.
    """

    async def provision_did(self, e164: str) -> str:
        """Create the dispatch rule for `e164`; return its id (stored on the row)."""
        ...

    async def deprovision_did(self, dispatch_rule_id: str) -> None:
        """Remove a previously created rule (rollback / de-registration)."""
        ...

    async def list_dispatch_rules(self, ids: list[str] | None = None) -> list[DispatchRuleSnapshot]:
        """Dispatch rules on the server, all of them or just `ids`."""
        ...

    async def ensure_inbound_trunk(self) -> None:
        """Ensure the named inbound trunk exists, creating it if the server has none.

        Raises if it cannot be guaranteed, so a caller that must fail closed can.
        """
        ...


class LiveKitSipProvisioner:
    """Backs SIP admission with LiveKit per-DID dispatch rules.

    One shared inbound trunk accepts SIP; a dispatch rule scoped to a single
    `numbers=[did]` routes that DID's calls to per-call rooms. No rule ⇒
    LiveKit rejects the call.

    `numbers` is the *called* number filter (the DID being dialled) — not
    `inbound_numbers`, which filters on the *caller's* number.
    """

    def __init__(
        self,
        *,
        url: str,
        api_key: str,
        api_secret: str,
        inbound_trunk_name: str = "oron-inbound",
        inbound_trunk_allowed_addresses: list[str] | None = None,
        allow_any_address: bool = False,
        room_prefix: str = "call-",
        api_factory=api.LiveKitAPI,
    ):
        self._url = url
        self._api_key = api_key
        self._api_secret = api_secret
        # By name, never a stored id: LiveKit reassigns ids, so a cached one drifts.
        self._trunk_name = inbound_trunk_name
        # No default: an unset ACL must fail, not silently admit the internet.
        self._trunk_allowed_addresses = inbound_trunk_allowed_addresses or []
        self._allow_any_address = allow_any_address
        self._room_prefix = room_prefix
        self._api_factory = api_factory

    async def _resolve_trunk_id(self, lkapi) -> str | None:
        """The current id of our named trunk, or None if it is not on the server."""
        resp = await lkapi.sip.list_sip_inbound_trunk(api.ListSIPInboundTrunkRequest())
        for trunk in resp.items:
            if trunk.name == self._trunk_name:
                return trunk.sip_trunk_id
        return None

    async def provision_did(self, e164: str) -> str:
        lkapi = self._api_factory(self._url, self._api_key, self._api_secret)
        try:
            trunk_id = await self._resolve_trunk_id(lkapi)
            if trunk_id is None:
                raise RuntimeError(
                    f"SIP inbound trunk {self._trunk_name!r} does not exist; "
                    "cannot provision a dispatch rule that references it"
                )
            info = await lkapi.sip.create_sip_dispatch_rule(
                api.CreateSIPDispatchRuleRequest(
                    # Not the top-level fields — LiveKit silently drops those.
                    dispatch_rule=api.SIPDispatchRuleInfo(
                        name=f"oron-did-{e164}",
                        trunk_ids=[trunk_id],
                        # numbers = called DID; inbound_numbers would filter the caller.
                        numbers=[e164],
                        rule=api.SIPDispatchRule(
                            dispatch_rule_individual=api.SIPDispatchRuleIndividual(
                                room_prefix=self._room_prefix
                            )
                        ),
                    )
                )
            )
        finally:
            await lkapi.aclose()
        logger.info(f"Provisioned SIP dispatch rule {info.sip_dispatch_rule_id}")
        return info.sip_dispatch_rule_id

    async def deprovision_did(self, dispatch_rule_id: str) -> None:
        lkapi = self._api_factory(self._url, self._api_key, self._api_secret)
        try:
            await lkapi.sip.delete_sip_dispatch_rule(
                api.DeleteSIPDispatchRuleRequest(sip_dispatch_rule_id=dispatch_rule_id)
            )
        finally:
            await lkapi.aclose()
        logger.info(f"Deprovisioned dispatch rule {dispatch_rule_id}")

    async def list_dispatch_rules(self, ids: list[str] | None = None) -> list[DispatchRuleSnapshot]:
        lkapi = self._api_factory(self._url, self._api_key, self._api_secret)
        try:
            resp = await lkapi.sip.list_sip_dispatch_rule(
                api.ListSIPDispatchRuleRequest(dispatch_rule_ids=ids or [])
            )
        finally:
            await lkapi.aclose()
        return [
            DispatchRuleSnapshot(
                id=info.sip_dispatch_rule_id, name=info.name, numbers=list(info.numbers)
            )
            for info in resp.items
        ]

    def _check_admission_acl(self) -> None:
        """The trunk ACL is the only thing deciding who may send us SIP. Refuse to
        create one that admits everyone — the firewall in front of it belongs to a
        different system and does not travel with this code."""
        if not self._trunk_allowed_addresses:
            raise RuntimeError(
                f"Refusing to create SIP inbound trunk {self._trunk_name!r} with no "
                "allowed_addresses — LiveKit reads an empty ACL as 'admit everyone'. "
                "Set INBOUND_TRUNK_ALLOWED_ADDRESSES to the carrier's signaling IPs."
            )
        if "0.0.0.0/0" not in self._trunk_allowed_addresses:
            return
        if not self._allow_any_address:
            raise RuntimeError(
                f"Refusing to create SIP inbound trunk {self._trunk_name!r} with "
                "allowed_addresses 0.0.0.0/0 — anyone who knows this host could dial a "
                "tenant's DID and spend the account's LLM/TTS budget. Restrict it to the "
                "carrier's signaling IPs, or set SIP_ALLOW_ANY_ADDRESS=true for dev."
            )
        logger.warning(
            f"SIP inbound trunk {self._trunk_name!r} is being created open to the "
            "internet (0.0.0.0/0) because SIP_ALLOW_ANY_ADDRESS is set. Never leave "
            "this in front of a real DID."
        )

    async def ensure_inbound_trunk(self) -> None:
        lkapi = self._api_factory(self._url, self._api_key, self._api_secret)
        try:
            resp = await lkapi.sip.list_sip_inbound_trunk(api.ListSIPInboundTrunkRequest())
            trunks = list(resp.items)
            if any(t.name == self._trunk_name for t in trunks):
                return  # our trunk is there; nothing to do

            if trunks:
                # Foreign trunks exist: adopting or duplicating is worse than stopping.
                raise RuntimeError(
                    f"SIP inbound trunk {self._trunk_name!r} is not present, but "
                    f"{len(trunks)} other inbound trunk(s) are — refusing to guess "
                    "which is ours. Recreate the trunk explicitly or remove the strays."
                )

            self._check_admission_acl()
            created = await lkapi.sip.create_sip_inbound_trunk(
                api.CreateSIPInboundTrunkRequest(
                    trunk=api.SIPInboundTrunkInfo(
                        name=self._trunk_name,
                        allowed_addresses=self._trunk_allowed_addresses,
                    )
                )
            )
            logger.warning(
                f"SIP inbound trunk {self._trunk_name!r} was absent; created it as "
                f"{created.sip_trunk_id}"
            )
        finally:
            await lkapi.aclose()
