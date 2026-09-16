import json
from uuid import uuid4

import asyncpg
import pytest

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


async def _journey_fixture(connection: asyncpg.Connection, label: str) -> dict:
    tenant_id = uuid4()
    contact_id = uuid4()
    session_id = uuid4()
    flow_id = uuid4()
    await connection.execute(
        "INSERT INTO tenants(id,name,slug) VALUES($1,$2,$3)",
        tenant_id,
        f"{label} Property",
        f"voice-verify-{tenant_id}",
    )
    await connection.execute(
        "INSERT INTO crm.tenant_settings(tenant_id,display_name,locale,timezone,"
        "support_profile) VALUES($1,$2,'he','Asia/Jerusalem',$3::jsonb)",
        tenant_id,
        f"{label} Property",
        (
            '{"schemaVersion":"1.0","displayName":"'
            f'{label} Property","supportDisplayName":"{label} Property Support",'
            '"authorizedAffiliations":[],"terminology":[]}'
        ),
    )
    await connection.execute(
        "INSERT INTO crm.contacts(id,tenant_id,name) VALUES($1,$2,$3)",
        contact_id,
        tenant_id,
        f"{label} Customer",
    )
    await connection.execute(
        "INSERT INTO crm.contact_channel_identities"
        "(tenant_id,contact_id,channel,normalized_value,validation_status,is_primary) "
        "VALUES($1,$2,'whatsapp',$3,'valid',true)",
        tenant_id,
        contact_id,
        "+972501234567" if label == "A" else "+972509876543",
    )
    blind_index = f"{label.casefold()}-fictional-protected-blind-index"
    await connection.execute(
        "INSERT INTO crm.customer_profiles"
        "(tenant_id,contact_id,national_id_ciphertext,national_id_blind_index,"
        "national_id_hint) VALUES($1,$2,'v1:fictional',$3,'6789')",
        tenant_id,
        contact_id,
        blind_index,
    )
    channel_id = await connection.fetchval(
        "INSERT INTO messaging.channels"
        "(tenant_id,kind,provider,provider_account_id,status) "
        "VALUES($1,'whatsapp','meta',$2,'active') RETURNING id",
        tenant_id,
        f"voice-verify-{tenant_id}",
    )
    conversation_id = await connection.fetchval(
        "INSERT INTO messaging.conversations(tenant_id,channel_id,contact_id,"
        "last_message_preview) VALUES($1,$2,$3,$4) RETURNING id",
        tenant_id,
        channel_id,
        contact_id,
        f"{label} private issue preview",
    )
    await connection.execute(
        "INSERT INTO messaging.messages"
        "(tenant_id,conversation_id,direction,sender_type,content_type,content_text,"
        "provider,status) VALUES($1,$2,'inbound','contact','text',$3,'meta','received')",
        tenant_id,
        conversation_id,
        f"{label} private WhatsApp issue",
    )
    await connection.execute(
        "INSERT INTO public.sessions(session_id,tenant_id,contact_id,provider,direction,"
        "room,status,flow_id) VALUES($1,$2,$3,'livekit','outbound',$4,'started',$5)",
        session_id,
        tenant_id,
        contact_id,
        f"voice-verify-{session_id}",
        flow_id,
    )
    handoff_id = await connection.fetchval(
        "INSERT INTO automation.handoffs"
        "(tenant_id,contact_id,conversation_id,source_channel,reason_safe,idempotency_key) "
        "VALUES($1,$2,$3,'whatsapp','Secure voice continuation',$4) RETURNING id",
        tenant_id,
        contact_id,
        conversation_id,
        f"voice-verify-{session_id}",
    )
    return {
        "tenant": tenant_id,
        "contact": contact_id,
        "session": session_id,
        "conversation": conversation_id,
        "handoff": handoff_id,
        "name": f"{label.casefold()}customer",
        "phone": "+972501234567" if label == "A" else "+972509876543",
        "blind_index": blind_index,
    }


async def test_verification_locks_context_and_denies_cross_tenant_ids(
    pg: asyncpg.Connection,
) -> None:
    tenant_a = await _journey_fixture(pg, "A")
    tenant_b = await _journey_fixture(pg, "B")
    await pg.execute("SET LOCAL ROLE platform_voice")

    async def set_tenant(tenant_id) -> None:
        await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(tenant_id))

    async def initialize(fixture: dict) -> dict:
        return json.loads(
            await pg.fetchval(
                "SELECT platform.initialize_voice_identity_verification($1,$2)",
                fixture["session"],
                fixture["handoff"],
            )
        )

    async def verify(fixture: dict) -> dict:
        return json.loads(
            await pg.fetchval(
                "SELECT platform.verify_voice_caller_identity($1,$2,$3,$4,NULL)",
                fixture["session"],
                fixture["name"],
                fixture["phone"],
                fixture["blind_index"],
            )
        )

    await set_tenant(tenant_a["tenant"])
    profile = json.loads(
        await pg.fetchval("SELECT platform.current_voice_tenant_support_profile()")
    )
    assert profile["tenantName"] == "A Property"
    assert profile["supportProfile"]["supportDisplayName"] == "A Property Support"
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await pg.fetchval("SELECT count(*) FROM automation.voice_identity_verifications")
    receipt = await initialize(tenant_a)
    assert receipt["state"] == "identity_required"
    assert receipt["factors"] == ["fullName", "phone", "nationalId"]
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await pg.fetchval("SELECT platform.verified_voice_handoff_context($1)", tenant_a["session"])
    wrong = json.loads(
        await pg.fetchval(
            "SELECT platform.verify_voice_caller_identity($1,$2,$3,$4,NULL)",
            tenant_a["session"],
            tenant_a["name"],
            tenant_a["phone"],
            "wrong-blind-index",
        )
    )
    assert wrong == {
        "state": "collecting_identity",
        "verified": False,
        "remainingAttempts": 2,
    }
    unlocked = await verify(tenant_a)
    assert unlocked["verified"] is True
    context_a = json.loads(
        await pg.fetchval("SELECT platform.verified_voice_handoff_context($1)", tenant_a["session"])
    )
    assert context_a["sourceConversation"]["id"] == str(tenant_a["conversation"])
    assert "A private WhatsApp issue" in str(context_a)
    assert "B private WhatsApp issue" not in str(context_a)

    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE public.sessions SET status='ended',ended_at=clock_timestamp(),"
        "outcome='resolved' WHERE tenant_id=$1 AND session_id=$2",
        tenant_a["tenant"],
        tenant_a["session"],
    )
    await pg.execute("SET LOCAL ROLE platform_voice")
    await set_tenant(tenant_a["tenant"])
    assert await pg.fetchval("SELECT platform.write_voice_session_outcome($1)", tenant_a["session"])
    await pg.execute("RESET ROLE")
    outcome = await pg.fetchval(
        "SELECT outcome_detail FROM public.sessions WHERE tenant_id=$1 AND session_id=$2",
        tenant_a["tenant"],
        tenant_a["session"],
    )
    assert json.loads(outcome)["handoffId"] == str(tenant_a["handoff"])
    assert (
        await pg.fetchval(
            "SELECT status FROM automation.handoffs WHERE tenant_id=$1 AND id=$2",
            tenant_a["tenant"],
            tenant_a["handoff"],
        )
        == "resolved"
    )
    await pg.execute("SET LOCAL ROLE platform_voice")

    await set_tenant(tenant_b["tenant"])
    await initialize(tenant_b)
    await verify(tenant_b)
    await set_tenant(tenant_a["tenant"])
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await pg.fetchval("SELECT platform.verified_voice_handoff_context($1)", tenant_b["session"])
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await pg.fetchval(
            "SELECT platform.initialize_voice_identity_verification($1,$2)",
            tenant_a["session"],
            tenant_b["handoff"],
        )
