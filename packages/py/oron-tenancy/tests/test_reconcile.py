"""The reconciler's core is pure: it diffs a snapshot of LiveKit's dispatch rules
against the registered numbers, so every case below is exercised without a live
LiveKit or a database."""

from oron_tenancy.reconcile import (
    DispatchRuleSnapshot,
    RegisteredNumber,
    RuleIssue,
    reconcile,
)

DID = "+14155550100"


def _rule(id="SDR_1", numbers=(DID,), name="oron-did-+14155550100"):
    return DispatchRuleSnapshot(id=id, name=name, numbers=list(numbers))


def test_a_consistent_deployment_has_no_findings():
    report = reconcile(
        rules=[_rule()],
        registered=[RegisteredNumber(e164=DID, dispatch_rule_id="SDR_1")],
    )
    assert report.findings == []
    assert report.ok


def test_a_rule_without_a_numbers_filter_is_reported_as_a_catch_all():
    """The one that makes admission-time rejection a silent no-op: a rule with no
    `numbers` matches every called number, so unregistered DIDs are still admitted."""
    report = reconcile(
        rules=[_rule(id="SDR_catchall", numbers=(), name="oron-dispatch")],
        registered=[],
    )
    assert [f.issue for f in report.findings] == [RuleIssue.catch_all]
    assert report.findings[0].dispatch_rule_id == "SDR_catchall"
    assert not report.ok


def test_a_rule_no_registered_number_claims_is_reported_as_orphaned():
    """What a failed rollback (or a lost create response) leaves behind."""
    report = reconcile(rules=[_rule(id="SDR_orphan")], registered=[])
    assert [f.issue for f in report.findings] == [RuleIssue.orphaned]
    assert report.findings[0].dispatch_rule_id == "SDR_orphan"


def test_a_registered_number_whose_rule_is_gone_is_reported_as_missing():
    """The dangerous direction: the row says the DID is live, but LiveKit has no
    rule for it, so every call to that number is rejected."""
    report = reconcile(
        rules=[],
        registered=[RegisteredNumber(e164=DID, dispatch_rule_id="SDR_deleted")],
    )
    assert [f.issue for f in report.findings] == [RuleIssue.missing]
    assert report.findings[0].e164 == DID
    assert report.findings[0].dispatch_rule_id == "SDR_deleted"


def test_a_rule_that_does_not_cover_its_own_did_is_reported_as_mismatched():
    """The rule exists and is claimed, but was edited to filter a different DID."""
    report = reconcile(
        rules=[_rule(numbers=("+14155550199",))],
        registered=[RegisteredNumber(e164=DID, dispatch_rule_id="SDR_1")],
    )
    assert [f.issue for f in report.findings] == [RuleIssue.mismatched]
    assert report.findings[0].e164 == DID


def test_a_catch_all_is_reported_as_a_catch_all_rather_than_an_orphan():
    """A catch-all is necessarily unclaimed too, but reporting it as a stray rule
    would bury the fact that it defeats admission control for every DID."""
    report = reconcile(rules=[_rule(id="SDR_catchall", numbers=())], registered=[])
    assert [f.issue for f in report.findings] == [RuleIssue.catch_all]
