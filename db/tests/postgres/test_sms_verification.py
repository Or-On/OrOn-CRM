"""Real PostgreSQL tests of purpose, identity, expiry, quota and replay fences."""

import json
from uuid import uuid4

import asyncpg
import pytest

from db.tests.postgres.test_voice_handoff_verification import _journey_fixture

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]
DIGEST = "a" * 64
WRONG = "b" * 64


async def _staff(pg: asyncpg.Connection) -> tuple:
    user, tenant, session = uuid4(), uuid4(), uuid4()
    await pg.execute(
        "INSERT INTO tenants(id,name,slug) VALUES($1,'SMS Fixture',$2)", tenant, f"sms-{tenant}"
    )
    await pg.execute(
        "INSERT INTO users(id,email,status) VALUES($1,$2,'active')", user, f"{user}@example.invalid"
    )
    await pg.execute(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", tenant, user
    )
    await pg.execute(
        "INSERT INTO platform.auth_credentials(user_id,password_hash) "
        "VALUES($1,'fictional-password-hash')",
        user,
    )
    await pg.execute(
        "INSERT INTO platform.auth_sessions(id,user_id,active_tenant_id,token_hash,csrf_token_hash,"
        "idle_timeout_seconds,idle_expires_at,absolute_expires_at) VALUES($1,$2,$3,$4,$5,3600,"
        "clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day')",
        session,
        user,
        tenant,
        bytes(str(uuid4()), "ascii"),
        bytes(str(uuid4()), "ascii"),
    )
    return user, session


async def _start(pg, purpose, user, session=None, phone=None):
    challenge = uuid4()
    result = await pg.fetchval(
        "SELECT platform.auth_start_sms($1,$2,$3,$4,$5,$6)",
        challenge,
        purpose,
        user,
        session,
        phone,
        DIGEST,
    )
    await pg.execute("SELECT platform.auth_sms_delivery($1,true)", challenge)
    return challenge, result


async def _complete(pg, challenge, purpose, digest=DIGEST, user=None, session=None):
    return await pg.fetchval(
        "SELECT platform.auth_complete_sms($1,$2,$3,$4,$5,'sms-test')",
        challenge,
        purpose,
        digest,
        user,
        session,
    )


async def _age(pg, challenge):
    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE platform.sms_otp_challenges SET created_at=created_at-interval '61 seconds',"
        "expires_at=expires_at-interval '61 seconds' WHERE id=$1",
        challenge,
    )
    await pg.execute("SET LOCAL ROLE platform_web")


async def test_staff_enrollment_login_disable_and_replay(pg: asyncpg.Connection):
    user, session = await _staff(pg)
    await pg.execute("SET LOCAL ROLE platform_web")
    challenge, phone = await _start(pg, "staff_enrollment", user, session, "+12025550121")
    assert phone == "+12025550121"
    assert await pg.fetchval("SELECT platform.auth_sms_phone($1)", user) is None
    assert await _complete(pg, challenge, "staff_login") is None  # wrong purpose
    assert await _complete(pg, challenge, "staff_enrollment", user=uuid4(), session=session) is None
    assert await _complete(pg, challenge, "staff_enrollment", WRONG, user, session) is None
    assert (
        await _complete(pg, challenge, "staff_enrollment", user=user, session=session)
        == f"{user}@example.invalid"
    )
    assert await _complete(pg, challenge, "staff_enrollment", user=user, session=session) is None
    await _age(pg, challenge)
    login, _ = await _start(pg, "staff_login", user)
    assert await _complete(pg, login, "staff_login") == f"{user}@example.invalid"
    assert await _complete(pg, login, "staff_login") is None
    await _age(pg, login)
    disable, _ = await _start(pg, "staff_disable", user, session)
    assert await _complete(pg, disable, "staff_disable", user=user, session=session)
    assert await pg.fetchval("SELECT platform.auth_sms_phone($1)", user) is None


async def test_staff_expiry_attempts_password_change_and_table_privileges(pg: asyncpg.Connection):
    user, session = await _staff(pg)
    await pg.execute(
        "INSERT INTO platform.staff_sms_credentials(user_id,phone_e164) VALUES($1,'+12025550122')",
        user,
    )
    await pg.execute("SET LOCAL ROLE platform_web")
    challenge, _ = await _start(pg, "staff_login", user)
    for _ in range(5):
        assert await _complete(pg, challenge, "staff_login", WRONG) is None
    assert await _complete(pg, challenge, "staff_login") is None
    await _age(pg, challenge)
    expiry, _ = await _start(pg, "staff_login", user)
    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE platform.sms_otp_challenges SET created_at=created_at-interval '6 minutes',"
        "expires_at=expires_at-interval '6 minutes' WHERE id=$1",
        expiry,
    )
    await pg.execute("SET LOCAL ROLE platform_web")
    assert await _complete(pg, expiry, "staff_login") is None
    changed, _ = await _start(pg, "staff_login", user)
    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE platform.auth_credentials SET password_hash='changed-fictional-password' "
        "WHERE user_id=$1",
        user,
    )
    await pg.execute("SET LOCAL ROLE platform_web")
    assert await _complete(pg, changed, "staff_login") is None
    assert (
        await pg.fetchval(
            "SELECT has_table_privilege(current_user,'platform.sms_otp_challenges','SELECT')"
        )
        is False
    )
    assert (
        await pg.fetchval(
            "SELECT has_table_privilege(current_user,'platform.staff_sms_credentials','UPDATE')"
        )
        is False
    )
    assert (
        await pg.fetchval(
            "SELECT has_function_privilege(current_user,"
            "'platform.sms_reserve(uuid,text,uuid,uuid,uuid,uuid,uuid,text,text)','EXECUTE')"
        )
        is False
    )


async def test_staff_resend_invalidates_old_code_and_shared_destination_quota(
    pg: asyncpg.Connection,
):
    user, session = await _staff(pg)
    await pg.execute("SET LOCAL ROLE platform_web")
    first, _ = await _start(pg, "staff_enrollment", user, session, "+12025550123")
    savepoint = pg.transaction()
    await savepoint.start()
    with pytest.raises(asyncpg.RaiseError, match="rate limited"):
        await _start(pg, "staff_enrollment", user, session, "+12025550123")
    await savepoint.rollback()
    await _age(pg, first)
    second, _ = await _start(pg, "staff_enrollment", user, session, "+12025550123")
    assert await _complete(pg, first, "staff_enrollment", user=user, session=session) is None
    assert await _complete(pg, second, "staff_enrollment", user=user, session=session)


async def _voice(pg):
    fixture = await _journey_fixture(pg, "A")
    await pg.execute(
        "UPDATE crm.tenant_settings SET identity_verification_policy="
        "jsonb_set(identity_verification_policy,'{smsOtp}','true') WHERE tenant_id=$1",
        fixture["tenant"],
    )
    identity = await pg.fetchval(
        "SELECT id FROM crm.contact_channel_identities WHERE tenant_id=$1 AND contact_id=$2",
        fixture["tenant"],
        fixture["contact"],
    )
    await pg.execute(
        "INSERT INTO public.session_events(tenant_id,session_id,sequence,event_type,payload) "
        "VALUES($1,$2,0,'voice.agent.binding.v1',$3::jsonb)",
        fixture["tenant"],
        fixture["session"],
        json.dumps({"caller_identity_id": str(identity)}),
    )
    await pg.execute("SET LOCAL ROLE platform_voice")
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(fixture["tenant"]))
    return fixture


async def test_customer_sms_adds_to_handoff_factors_and_never_unlocks_by_caller_id(
    pg: asyncpg.Connection,
):
    fixture = await _voice(pg)
    await pg.fetchval(
        "SELECT platform.initialize_voice_identity_verification($1,$2)",
        fixture["session"],
        fixture["handoff"],
    )
    requirements = json.loads(
        await pg.fetchval("SELECT platform.prepare_voice_sms_verification($1)", fixture["session"])
    )
    assert requirements["factors"] == ["fullName", "phone", "nationalId", "smsOtp"]
    savepoint = pg.transaction()
    await savepoint.start()
    with pytest.raises(asyncpg.InsufficientPrivilegeError, match="SMS verification required"):
        await pg.fetchval(
            "SELECT platform.verify_voice_caller_identity($1,$2,$3,$4,NULL)",
            fixture["session"],
            fixture["name"],
            fixture["phone"],
            fixture["blind_index"],
        )
    await savepoint.rollback()
    challenge = uuid4()
    assert (
        await pg.fetchval(
            "SELECT platform.voice_start_sms($1,$2,$3)", challenge, fixture["session"], DIGEST
        )
        == fixture["phone"]
    )
    await pg.execute(
        "SELECT platform.voice_sms_delivery($1,$2,true)", challenge, fixture["session"]
    )
    wrong = json.loads(
        await pg.fetchval(
            "SELECT platform.voice_complete_sms($1,$2,$3)", challenge, fixture["session"], WRONG
        )
    )
    assert not wrong["verified"] and wrong["state"] == "collecting_identity"
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(uuid4()))
    assert await pg.fetchval("SELECT platform.voice_sms_challenge($1)", fixture["session"]) is None
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(fixture["tenant"]))
    verified = json.loads(
        await pg.fetchval(
            "SELECT platform.voice_complete_sms($1,$2,$3)", challenge, fixture["session"], DIGEST
        )
    )
    assert verified["verified"] and verified["state"] != "context_unlocked"
    final = json.loads(
        await pg.fetchval(
            "SELECT platform.verify_voice_caller_identity($1,$2,$3,$4,NULL)",
            fixture["session"],
            fixture["name"],
            fixture["phone"],
            fixture["blind_index"],
        )
    )
    assert final["verified"] and final["state"] == "context_unlocked"


async def test_customer_normal_call_sms_and_stale_binding(pg: asyncpg.Connection):
    fixture = await _voice(pg)
    requirements = json.loads(
        await pg.fetchval("SELECT platform.prepare_voice_sms_verification($1)", fixture["session"])
    )
    assert requirements["required"] and requirements["factors"] == ["smsOtp"]
    challenge = uuid4()
    await pg.fetchval(
        "SELECT platform.voice_start_sms($1,$2,$3)", challenge, fixture["session"], DIGEST
    )
    await pg.execute(
        "SELECT platform.voice_sms_delivery($1,$2,true)", challenge, fixture["session"]
    )
    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE crm.contact_channel_identities SET validation_status='revoked' "
        "WHERE tenant_id=$1 AND contact_id=$2",
        fixture["tenant"],
        fixture["contact"],
    )
    await pg.execute("SET LOCAL ROLE platform_voice")
    result = json.loads(
        await pg.fetchval(
            "SELECT platform.voice_complete_sms($1,$2,$3)", challenge, fixture["session"], DIGEST
        )
    )
    assert not result["verified"]
    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE crm.contact_channel_identities SET validation_status='valid' "
        "WHERE tenant_id=$1 AND contact_id=$2",
        fixture["tenant"],
        fixture["contact"],
    )
    await pg.execute("SET LOCAL ROLE platform_voice")
    result = json.loads(
        await pg.fetchval(
            "SELECT platform.voice_complete_sms($1,$2,$3)", challenge, fixture["session"], DIGEST
        )
    )
    assert result["verified"] and result["state"] == "context_unlocked"
    assert await pg.fetchval("SELECT platform.voice_sms_challenge($1)", fixture["session"]) is None


async def test_new_caller_sms_proves_transport_number_and_ended_call_rejects(pg):
    fixture = await _voice(pg)
    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE crm.contact_channel_identities SET validation_status='unverified' "
        "WHERE tenant_id=$1 AND contact_id=$2",
        fixture["tenant"],
        fixture["contact"],
    )
    await pg.execute("SET LOCAL ROLE platform_voice")
    await pg.fetchval("SELECT platform.prepare_voice_sms_verification($1)", fixture["session"])
    challenge = uuid4()
    assert (
        await pg.fetchval(
            "SELECT platform.voice_start_sms($1,$2,$3)", challenge, fixture["session"], DIGEST
        )
        == fixture["phone"]
    )
    await pg.execute(
        "SELECT platform.voice_sms_delivery($1,$2,true)", challenge, fixture["session"]
    )
    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE public.sessions SET ended_at=clock_timestamp() "
        "WHERE tenant_id=$1 AND session_id=$2",
        fixture["tenant"],
        fixture["session"],
    )
    await pg.execute("SET LOCAL ROLE platform_voice")
    savepoint = pg.transaction()
    await savepoint.start()
    with pytest.raises(asyncpg.InsufficientPrivilegeError, match="SMS verification unavailable"):
        await pg.fetchval(
            "SELECT platform.voice_complete_sms($1,$2,$3)", challenge, fixture["session"], DIGEST
        )
    await savepoint.rollback()
    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE public.sessions SET ended_at=NULL WHERE tenant_id=$1 AND session_id=$2",
        fixture["tenant"],
        fixture["session"],
    )
    await pg.execute("SET LOCAL ROLE platform_voice")
    result = json.loads(
        await pg.fetchval(
            "SELECT platform.voice_complete_sms($1,$2,$3)", challenge, fixture["session"], DIGEST
        )
    )
    assert result["verified"] and result["state"] == "context_unlocked"


@pytest.mark.parametrize(
    "on_failure,expected", [("human_handoff", "escalated"), ("end_call", "failed")]
)
async def test_sms_unavailable_keeps_gate_terminal_even_if_a_valid_code_arrives(
    pg, on_failure, expected
):
    fixture = await _voice(pg)
    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE crm.tenant_settings SET identity_verification_policy="
        "jsonb_set(identity_verification_policy,'{onFailure}',to_jsonb($2::text)) "
        "WHERE tenant_id=$1",
        fixture["tenant"],
        on_failure,
    )
    await pg.execute("SET LOCAL ROLE platform_voice")
    await pg.fetchval(
        "SELECT platform.initialize_voice_identity_verification($1,$2)",
        fixture["session"],
        fixture["handoff"],
    )
    await pg.fetchval("SELECT platform.prepare_voice_sms_verification($1)", fixture["session"])
    challenge = uuid4()
    await pg.fetchval(
        "SELECT platform.voice_start_sms($1,$2,$3)", challenge, fixture["session"], DIGEST
    )
    await pg.execute(
        "SELECT platform.voice_sms_delivery($1,$2,true)", challenge, fixture["session"]
    )
    await pg.execute("SELECT platform.voice_sms_unavailable($1)", fixture["session"])
    result = json.loads(
        await pg.fetchval(
            "SELECT platform.voice_complete_sms($1,$2,$3)", challenge, fixture["session"], DIGEST
        )
    )
    assert not result["verified"] and result["state"] == expected
    assert result["required"]
    if expected == "escalated":
        await pg.execute("RESET ROLE")
        assert (
            await pg.fetchval(
                "SELECT status FROM automation.handoffs WHERE tenant_id=$1 AND id=$2",
                fixture["tenant"],
                fixture["handoff"],
            )
            == "pending"
        )
