"""Actual canonical SMS/voice/signed-destination bridge; all sources/control reviews synthetic."""

import json
from uuid import uuid4

import pytest

from db.tests.postgres.test_voice_handoff_verification import _journey_fixture

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]
DIGEST = "a" * 64


async def role(pg, name):
    await pg.execute("RESET ROLE")
    if name:
        await pg.execute("SET LOCAL ROLE " + name)  # noqa: S608 -- fixed test role names


async def _fixture(pg, mode):
    f = await _journey_fixture(pg, "A")
    tenant, contact, voice = f["tenant"], f["contact"], f["session"]
    actor, profile, agent, definition, flow = uuid4(), uuid4(), uuid4(), uuid4(), uuid4()
    await pg.execute(
        "SELECT set_config('app.current_tenant',$1,true),set_config('app.current_user',$2,true)",
        str(tenant),
        str(actor),
    )
    await pg.execute(
        "INSERT INTO public.users(id,email,status) VALUES($1,$2,'active')",
        actor,
        str(actor) + "@example.invalid",
    )
    await pg.execute(
        "INSERT INTO public.memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",
        tenant,
        actor,
    )
    await pg.execute(
        "UPDATE crm.contacts SET voice_consent='granted',whatsapp_consent='granted' WHERE id=$1",
        contact,
    )
    await pg.execute(
        "UPDATE crm.tenant_settings SET identity_verification_policy=jsonb_set(identit"
        "y_verification_policy,'{smsOtp}','true') WHERE tenant_id=$1",
        tenant,
    )
    await pg.execute(
        "INSERT INTO platform.tenant_remediation_flags(tenant_id,flag_key,enabled) "
        "VALUES($1,'session_memory',true),($1,'verified_voice_memory_bridge',$2)",
        tenant,
        mode != "flag_off",
    )
    await pg.execute(
        "INSERT INTO agents.agent_profiles(id,tenant_id,name) VALUES($1,$2,'Synthetic "
        "bridge Agent')",
        profile,
        tenant,
    )
    await pg.execute(
        """INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,version,
    system_prompt,locale,channel_capabilities,tool_permissions,validation_status,published_at)
    VALUES($1,$2,$3,1,'Synthetic business Agent','he',ARRAY['voice','whatsapp'],'[]','valid',
    clock_timestamp())""",
        agent,
        tenant,
        profile,
    )
    compiled = await pg.fetchval("SELECT flow_id FROM public.sessions WHERE session_id=$1", voice)
    await pg.execute(
        "INSERT INTO "
        "automation.flow_definitions(id,tenant_id,name,channel_capabilities) "
        "VALUES($1,$2,'Synthetic approved combined flow',ARRAY['voice','whatsapp'])",
        definition,
        tenant,
    )
    nodes = {
        "nodes": [
            {
                "id": "voice",
                "type": "voice.call",
                "configuration": {
                    "flowId": str(compiled),
                    "flowVersion": 1,
                    "agentVersionId": str(agent),
                },
            }
        ]
    }
    await pg.execute(
        """INSERT INTO automation.flow_versions(id,tenant_id,flow_definition_id,version,
    schema_version,definition,agent_profile_version_id,validation_status,published_at)
    VALUES($1,$2,$3,1,'1.0',$4::jsonb,$5,'valid',clock_timestamp())""",
        flow,
        tenant,
        definition,
        json.dumps(nodes),
        agent,
    )
    await pg.execute(
        """INSERT INTO automation.tenant_processes(tenant_id,name,enabled,trigger_key,
    channel,agent_profile_version_id,flow_version_id)
    VALUES($1,'Synthetic reviewed bridge',true,'whatsapp.message','whatsapp',$2,$3)""",
        tenant,
        agent,
        flow,
    )
    await pg.execute(
        """INSERT INTO platform.tenant_configuration_releases(tenant_id,version,status,
    configuration,approved_at) VALUES($1,2,'published','{}',clock_timestamp())""",
        tenant,
    )
    identity = await pg.fetchval(
        "SELECT id FROM crm.contact_channel_identities WHERE tenant_id=$1 AND contact_id=$2",
        tenant,
        contact,
    )
    await pg.execute(
        """INSERT INTO public.session_events(tenant_id,session_id,sequence,event_type,payload)
    VALUES($1,$2,0,'voice.agent.binding.v1',$3::jsonb)""",
        tenant,
        voice,
        json.dumps({"agent_version_id": str(agent), "caller_identity_id": str(identity)}),
    )
    if mode != "missing_flow":
        await pg.execute(
            """INSERT INTO public.session_events(tenant_id,session_id,sequence,event_type,payload)
        VALUES($1,$2,1,'voice.flow.binding.v1',$3::jsonb)""",
            tenant,
            voice,
            json.dumps(
                {
                    "agent_version_id": str(agent),
                    "compiled_flow_id": str(compiled),
                    "compiled_flow_version": 1,
                }
            ),
        )
    await role(pg, "platform_voice")
    await pg.fetchval(
        "SELECT platform.initialize_voice_identity_verification($1,$2)", voice, f["handoff"]
    )
    await pg.fetchval("SELECT platform.prepare_voice_sms_verification($1)", voice)

    async def capture():
        for ordinal in range(1, 11):
            await pg.fetchval(
                "SELECT platform.append_voice_memory_turn($1,$2,$3)",
                voice,
                ordinal,
                f"Synthetic verified caller assertion {ordinal}",
            )

    if mode in ("missing_sms", "late_sms"):
        await capture()
    if mode != "missing_sms":
        challenge = uuid4()
        assert (
            await pg.fetchval("SELECT platform.voice_start_sms($1,$2,$3)", challenge, voice, DIGEST)
            == f["phone"]
        )
        await pg.execute("SELECT platform.voice_sms_delivery($1,$2,true)", challenge, voice)
        receipt = json.loads(
            await pg.fetchval(
                "SELECT platform.voice_complete_sms($1,$2,$3)", challenge, voice, DIGEST
            )
        )
        assert receipt["verified"]
        receipt = json.loads(
            await pg.fetchval(
                "SELECT platform.verify_voice_caller_identity($1,$2,$3,$4,NULL)",
                voice,
                f["name"],
                f["phone"],
                f["blind_index"],
            )
        )
        assert receipt["state"] == "context_unlocked"
    if mode not in ("missing_sms", "late_sms"):
        await capture()
    await role(pg, None)
    await pg.execute(
        "UPDATE public.sessions SET ended_at=clock_timestamp() WHERE session_id=$1", voice
    )
    await role(pg, "platform_voice")
    await pg.execute("SELECT platform.finish_voice_memory($1)", voice)
    await role(pg, "platform_messaging")
    job = await pg.fetchrow(
        "SELECT id,claim_token FROM ops.claim_memory_summary('synthetic-bridge')"
    )
    work = json.loads(
        await pg.fetchval(
            "SELECT platform.load_memory_summary_job($1,'synthetic-bridge',$2)",
            job["id"],
            job["claim_token"],
        )
    )
    assert len(work["turns"]) == 10
    request = await pg.fetchval(
        "SELECT platform.persist_memory_summary_job($1,'synthetic-bridge',$2,$3)",
        job["id"],
        job["claim_token"],
        "Synthetic voice customer assertion summary",
    )
    await role(pg, None)
    conversation = f["conversation"]
    await pg.execute(
        """UPDATE messaging.conversations SET ownership_mode='ai',ai_agent_profile_version_id=$2,
    ai_enabled_by_user_id=$3,ai_enabled_at=clock_timestamp() WHERE id=$1""",
        conversation,
        agent,
        actor,
    )
    trigger = uuid4()
    provider_message = str(uuid4())
    await pg.execute(
        """INSERT INTO messaging.messages(id,tenant_id,conversation_id,direction,sender_type,
    content_type,content_text,provider,provider_message_id,status,created_at)
    VALUES($1,$2,$3,'inbound','contact','text','Synthetic signed current message','meta',$4,
    'received',clock_timestamp())""",
        trigger,
        tenant,
        conversation,
        provider_message,
    )
    await pg.execute(
        "INSERT INTO messaging.inbound_message_origins(tenant_id,message_id,contact_id"
        "entity_id,sender_address) VALUES($1,$2,$3,$4)",
        tenant,
        trigger,
        identity,
        f["phone"],
    )
    account = await pg.fetchval(
        "SELECT provider_account_id FROM messaging.channels WHERE id=(SELECT "
        "channel_id FROM messaging.conversations WHERE id=$1)",
        conversation,
    )
    payload = {
        "providerAccountId": account,
        "providerEventId": provider_message,
        "providerMessageId": provider_message,
        "from": f["phone"],
        "text": "Synthetic signed current message",
        "contentType": "text",
    }
    await pg.fetchval(
        "SELECT ops.accept_whatsapp_inbound($1,$2,'whatsapp.message.text',$3::jsonb)",
        account,
        provider_message,
        json.dumps(payload),
    )
    event = await pg.fetchval(
        "SELECT id FROM ops.inbound_events WHERE provider_account_id=$1 AND "
        "payload->>'providerMessageId'=$2",
        account,
        provider_message,
    )
    if mode != "missing_signature":
        await role(pg, "platform_whatsapp_verifier")
        await pg.execute(
            "SELECT agents.attest_whatsapp_signature($1,$2,$3::jsonb)",
            event,
            DIGEST,
            json.dumps(payload),
        )
    await role(pg, "platform_messaging")
    memory = await pg.fetchval(
        "SELECT id FROM agents.resolve_messaging_memory_session($1,$2,12)", conversation, agent
    )
    await role(pg, None)
    # These controller inputs only exercise mechanics in an owned rollback test.
    # They must never be reported as fifty real human-reviewed conversations.
    reviews = [request]
    for _ in range(49):
        dummy = uuid4()
        reviews.append(dummy)
        await pg.execute(
            """INSERT INTO agents.memory_summary_requests(id,tenant_id,channel,session_id,
        agent_version_id,conversation_id,actor_id,watermark,source_ids,state,summary_text)
        VALUES($1,$2,'whatsapp',$3,$4,$5,$6,$7,$8::uuid[],'complete',
    'Clearly synthetic gate control')""",
            dummy,
            tenant,
            memory,
            agent,
            conversation,
            actor,
            uuid4(),
            [trigger],
        )
    for reviewed in reviews:
        await role(pg, "platform_memory_review_controller")
        await pg.execute("SELECT agents.attest_real_memory_source($1,$2)", reviewed, DIGEST)
        await role(pg, "platform_web")
        await pg.execute("SELECT agents.review_memory_summary($1,true)", reviewed)
    await pg.execute("SELECT agents.activate_reviewed_memory()")
    await role(pg, None)
    if mode == "revoked_identity":
        await pg.execute(
            "UPDATE crm.contact_channel_identities SET validation_status='revoked' WHERE id=$1",
            identity,
        )
    if mode == "revoked_agent":
        await pg.execute(
            "UPDATE agents.agent_profiles SET archived_at=clock_timestamp() WHERE id=$1", profile
        )
    if mode == "revoked_review":
        await pg.execute(
            "UPDATE agents.memory_human_reviews SET approved=false WHERE request_id=$1", request
        )
    if mode == "epoch":
        await pg.execute(
            "UPDATE messaging.conversations SET ownership_mode='human' WHERE id=$1", conversation
        )
        await pg.execute(
            """UPDATE messaging.conversations SET ownership_mode='ai',
        ai_agent_profile_version_id=$2,ai_enabled_by_user_id=$3,ai_enabled_at=clock_timestamp()
        WHERE id=$1""",
            conversation,
            agent,
            actor,
        )
        changed = await pg.fetchval(
            """SELECT conversation.ownership_epoch<>memory.ownership_epoch
        FROM messaging.conversations conversation JOIN agents.messaging_memory_sessions memory
        ON memory.conversation_id=conversation.id WHERE memory.id=$1""",
            memory,
        )
        assert changed
    if mode == "session_flag_off":
        await pg.execute(
            "UPDATE platform.tenant_remediation_flags SET enabled=false "
            "WHERE tenant_id=$1 AND flag_key='session_memory'",
            tenant,
        )
    if mode == "revoked_otp":
        await pg.execute(
            "UPDATE platform.sms_otp_challenges SET state='superseded' WHERE voice_session_id=$1",
            voice,
        )
    await role(pg, "platform_messaging")
    if mode == "foreign_tenant":
        await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(uuid4()))
    rows = await pg.fetch(
        "SELECT * FROM agents.read_verified_voice_memory($1,$2,$3)", memory, agent, trigger
    )
    return rows, f, request


@pytest.mark.parametrize(
    "mode",
    [
        "positive",
        "missing_sms",
        "late_sms",
        "missing_signature",
        "missing_flow",
        "flag_off",
        "revoked_identity",
        "revoked_agent",
        "revoked_review",
        "epoch",
        "session_flag_off",
        "revoked_otp",
        "foreign_tenant",
    ],
)
async def test_verified_bridge_only_exact_current_destination_and_pre_capture_sms(pg, mode):
    rows, fixture, request = await _fixture(pg, mode)
    if mode == "positive":
        assert len(rows) == 1
        assert rows[0]["id"] == request and rows[0]["source_session_id"] == fixture["session"]
        assert rows[0]["text"] == "Synthetic voice customer assertion summary"
    else:
        assert rows == []
