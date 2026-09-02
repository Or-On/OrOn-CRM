"""Diff LiveKit's SIP dispatch rules against the registered phone numbers.

Dispatch rules are server-side state in LiveKit, and the control plane's record of
them is just a `dispatch_rule_id` column. The two drift apart in both directions:
a rule can outlive the row that created it (a rollback whose teardown failed, or a
create whose response was lost, so we never learned the id), and a row can outlive
its rule (deleted by hand). A rule created before per-DID admission existed — one
with no `numbers` filter — drifts in a third, quieter way: it matches every called
number, so admission-time rejection silently does nothing while it exists.

None of that fails loudly at runtime, which is why it needs to be asked for. The
core here is pure so the diff is testable without LiveKit or a database.
"""

from enum import StrEnum

from pydantic import BaseModel, computed_field


class RuleIssue(StrEnum):
    catch_all = "catch_all"
    orphaned = "orphaned"
    missing = "missing"
    mismatched = "mismatched"


class DispatchRuleSnapshot(BaseModel):
    """A dispatch rule as LiveKit reports it, reduced to what reconciliation needs."""

    id: str
    name: str
    numbers: list[str]


class RegisteredNumber(BaseModel):
    """A `phone_numbers` row, reduced likewise."""

    e164: str
    dispatch_rule_id: str


class Finding(BaseModel):
    issue: RuleIssue
    dispatch_rule_id: str
    detail: str
    # Set when the finding is about a specific DID. A catch-all or a stray rule is
    # not: that is the whole problem with it.
    e164: str | None = None


class ReconciliationReport(BaseModel):
    findings: list[Finding]

    @computed_field
    @property
    def ok(self) -> bool:
        """Serialized too: a caller polling this should not have to know that an
        empty `findings` is the healthy shape."""
        return not self.findings


def reconcile(
    *, rules: list[DispatchRuleSnapshot], registered: list[RegisteredNumber]
) -> ReconciliationReport:
    """Diff live dispatch rules against registered numbers."""
    findings: list[Finding] = []
    claimed = {n.dispatch_rule_id: n for n in registered}
    by_id = {r.id: r for r in rules}

    for rule in rules:
        if not rule.numbers:
            findings.append(
                Finding(
                    issue=RuleIssue.catch_all,
                    dispatch_rule_id=rule.id,
                    detail=(
                        f"rule {rule.name!r} has no `numbers` filter, so it admits calls to "
                        "every number and per-DID rejection cannot take effect while it exists"
                    ),
                )
            )
        elif rule.id not in claimed:
            findings.append(
                Finding(
                    issue=RuleIssue.orphaned,
                    dispatch_rule_id=rule.id,
                    detail=(
                        f"rule {rule.name!r} admits {', '.join(rule.numbers)} but no registered "
                        "number claims it"
                    ),
                )
            )

    for number in registered:
        rule = by_id.get(number.dispatch_rule_id)
        if rule is None:
            findings.append(
                Finding(
                    issue=RuleIssue.missing,
                    dispatch_rule_id=number.dispatch_rule_id,
                    e164=number.e164,
                    detail=(
                        f"{number.e164} is registered but its rule no longer exists in LiveKit, "
                        "so calls to it are rejected"
                    ),
                )
            )
        elif number.e164 not in rule.numbers:
            findings.append(
                Finding(
                    issue=RuleIssue.mismatched,
                    dispatch_rule_id=rule.id,
                    e164=number.e164,
                    detail=(
                        f"{number.e164} is registered to rule {rule.name!r}, which admits "
                        f"{', '.join(rule.numbers) or 'nothing'} instead"
                    ),
                )
            )

    return ReconciliationReport(findings=findings)
