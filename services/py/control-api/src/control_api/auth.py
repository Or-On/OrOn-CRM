"""Backward-compatible import surface for canonical service authentication."""

from or_on_platform.service_auth import (
    InvalidServiceAssertion,
    ServicePrincipal,
)
from or_on_platform.service_auth import (
    ServiceAssertionVerifier as _ServiceAssertionVerifier,
)


class ServiceAssertionVerifier(_ServiceAssertionVerifier):
    """Control API verifier with its stable audience default."""

    def __init__(self, secret: str, *, audience: str = "control-api") -> None:
        super().__init__(secret, audience=audience)


__all__ = ["InvalidServiceAssertion", "ServiceAssertionVerifier", "ServicePrincipal"]
