from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from livekit import api

from scripts.provision_voice_outbound import OutboundProvisionPlan, review_or_apply


def fixture():
    plan = OutboundProvisionPlan(
        tenant_id="633d9906-3866-4ddd-b85c-99c525bd3cb3",
        account_ref="test-carrier",
        from_number="+14155550101",
        twilio_trunk_id="TK" + "1" * 32,
        credential_list_id="CL" + "2" * 32,
        address="fictional-test.pstn.twilio.com",
        sip_username="fictional",
        livekit_trunk_name="fictional-test-outbound",
    )
    carrier = SimpleNamespace(
        inspect=AsyncMock(return_value={"domain": None, "credential_associated": False}),
        set_domain=AsyncMock(),
        associate_credentials=AsyncMock(),
    )
    sip = SimpleNamespace(
        list_outbound_trunk=AsyncMock(return_value=api.ListSIPOutboundTrunkResponse()),
        create_outbound_trunk=AsyncMock(
            return_value=api.SIPOutboundTrunkInfo(sip_trunk_id="ST_test")
        ),
    )
    return plan, carrier, sip


async def test_review_never_mutates_or_writes_receipt(tmp_path):
    plan, carrier, sip = fixture()
    receipt = tmp_path / "receipt.json"
    result = await review_or_apply(
        plan, carrier, sip, password="fixture", apply=False, receipt=receipt
    )
    assert len(result["changes"]) == 3
    assert result["dial_performed"] is False
    assert not receipt.exists()
    carrier.set_domain.assert_not_awaited()
    carrier.associate_credentials.assert_not_awaited()
    sip.create_outbound_trunk.assert_not_awaited()


async def test_apply_sets_explicit_sender_and_no_secret_in_receipt(tmp_path):
    plan, carrier, sip = fixture()
    receipt = tmp_path / "receipt.json"
    await review_or_apply(
        plan, carrier, sip, password="fixture-password", apply=True, receipt=receipt
    )
    request = sip.create_outbound_trunk.await_args.args[0]
    assert list(request.trunk.numbers) == [plan.from_number]
    assert request.trunk.auth_username == plan.sip_username
    assert request.trunk.auth_password == "fixture-password"
    assert "fixture-password" not in receipt.read_text()
    assert "ST_test" in receipt.read_text()


async def test_conflicting_existing_livekit_trunk_prevents_all_mutations(tmp_path):
    plan, carrier, sip = fixture()
    sip.list_outbound_trunk.return_value = api.ListSIPOutboundTrunkResponse(
        items=[api.SIPOutboundTrunkInfo(name=plan.livekit_trunk_name, address="foreign.invalid")]
    )
    with pytest.raises(ValueError, match="differs"):
        await review_or_apply(
            plan, carrier, sip, password="fixture", apply=True, receipt=tmp_path / "receipt.json"
        )
    carrier.set_domain.assert_not_awaited()
    carrier.associate_credentials.assert_not_awaited()
    sip.create_outbound_trunk.assert_not_awaited()


async def test_previously_applied_binding_is_reused_without_provider_mutation(tmp_path):
    plan, carrier, sip = fixture()
    carrier.inspect.return_value = {"domain": plan.address, "credential_associated": True}
    sip.list_outbound_trunk.return_value = api.ListSIPOutboundTrunkResponse(
        items=[
            api.SIPOutboundTrunkInfo(
                name=plan.livekit_trunk_name,
                address=plan.address,
                numbers=[plan.from_number],
                auth_username=plan.sip_username,
                sip_trunk_id="ST_existing",
            )
        ]
    )
    result = await review_or_apply(
        plan, carrier, sip, password="fixture", apply=True, receipt=tmp_path / "receipt.json"
    )
    assert result["changes"] == []
    assert result["trunk_id"] == "ST_existing"
    carrier.set_domain.assert_not_awaited()
    carrier.associate_credentials.assert_not_awaited()
    sip.create_outbound_trunk.assert_not_awaited()
