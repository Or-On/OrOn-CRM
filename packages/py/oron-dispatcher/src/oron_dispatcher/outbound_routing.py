"""Explicit tenant-owned carrier bindings; never inferred from a default trunk."""

from uuid import UUID

from oron_common import E164
from pydantic import BaseModel, ConfigDict, Field


class OutboundRoute(BaseModel):
    """Reviewed deployment binding to a trunk in the configured LiveKit project.

    Carrier credentials live in that trunk, not in client requests or prompts.
    The address pins its carrier account endpoint; the explicit sender must also
    be present in the provider's current allowed numbers at dial time.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)

    tenant_id: UUID
    account_ref: str = Field(min_length=1, max_length=120, pattern=r"^[a-zA-Z0-9_.:-]+$")
    trunk_id: str = Field(min_length=1, max_length=120, pattern=r"^[a-zA-Z0-9_-]+$")
    from_number: E164
    address: str = Field(min_length=1, max_length=253, pattern=r"^[a-zA-Z0-9.:-]+$")

    def evidence(self) -> dict[str, str]:
        """Safe references for the durable admission event, excluding phone/host."""
        return {"account_ref": self.account_ref, "trunk_id": self.trunk_id}


def validate_routes(routes: tuple[OutboundRoute, ...]) -> tuple[OutboundRoute, ...]:
    tenants = set()
    senders = set()
    accounts: dict[str, str] = {}
    trunks: dict[str, tuple[str, str]] = {}
    for route in routes:
        if route.tenant_id in tenants:
            raise ValueError("duplicate tenant outbound route")
        if route.from_number in senders:
            raise ValueError("outbound sender is assigned to multiple tenants")
        binding = (route.account_ref, route.address.casefold())
        if route.trunk_id in trunks and trunks[route.trunk_id] != binding:
            raise ValueError("outbound trunk has inconsistent account binding")
        if route.account_ref in accounts and accounts[route.account_ref] != binding[1]:
            raise ValueError("outbound account has inconsistent provider address")
        tenants.add(route.tenant_id)
        senders.add(route.from_number)
        accounts[route.account_ref] = binding[1]
        trunks[route.trunk_id] = binding
    return routes
