"""Test doubles for the control plane.

Shipped in the package rather than a conftest because tests subclass
`FakeProvisioner`, and `--import-mode=importlib` makes conftest classes
unimportable.
"""

from oron_tenancy.reconcile import DispatchRuleSnapshot


class FakeProvisioner:
    """Stands in for LiveKit SIP admission, recording what it was asked to do."""

    def __init__(self):
        self.provisioned: list[str] = []
        self.deprovisioned: list[str] = []
        self.rules: dict[str, DispatchRuleSnapshot] = {}
        self._n = 0

    async def provision_did(self, e164: str) -> str:
        self.provisioned.append(e164)
        self._n += 1
        rule_id = f"SDR_{self._n}"
        self.rules[rule_id] = DispatchRuleSnapshot(
            id=rule_id, name=f"oron-did-{e164}", numbers=[e164]
        )
        return rule_id

    async def deprovision_did(self, dispatch_rule_id: str) -> None:
        self.deprovisioned.append(dispatch_rule_id)
        self.rules.pop(dispatch_rule_id, None)

    async def list_dispatch_rules(self, ids: list[str] | None = None) -> list:
        rules = list(self.rules.values())
        return [r for r in rules if r.id in ids] if ids is not None else rules

    async def ensure_inbound_trunk(self) -> None:
        # Startup convergence fails closed if this raises, so an app under test
        # boots only because the fake's trunk is always "there".
        return None
