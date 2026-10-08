"""Actual messaging-role inference projection cannot borrow routes or skip quotas."""

# ruff: noqa: E501 -- reviewed static SQL fixture
import json
from uuid import uuid4

import asyncpg
import pytest

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


async def test_field_intake_route_lease_binding_quota_rotation_and_tenant(pg):
    (
        tenant,
        other,
        actor,
        profile,
        agent,
        config,
        cred,
        contact,
        channel,
        chat,
        message,
        job,
        claim,
    ) = [uuid4() for _ in range(13)]
    for owner in (tenant, other):
        await pg.execute(
            "INSERT INTO tenants(id,name,slug) VALUES($1,'Synthetic intake',$2)", owner, str(owner)
        )
    await pg.execute(
        "INSERT INTO users(id,email,status) VALUES($1,$2,'active')",
        actor,
        str(actor) + "@example.invalid",
    )
    await pg.execute(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')", tenant, actor
    )
    await pg.execute(
        "SELECT set_config('app.current_tenant',$1,true),set_config('app.current_user',$2,true),set_config('app.current_role','owner',true)",
        str(tenant),
        str(actor),
    )
    await pg.execute(
        "INSERT INTO platform.tenant_feature_entitlements(tenant_id,feature_key,available,enabled,granted_at) VALUES($1,'field_service',true,true,now()) ON CONFLICT(tenant_id,feature_key) DO UPDATE SET available=true,enabled=true",
        tenant,
    )
    await pg.execute(
        "INSERT INTO service.tenant_configuration(tenant_id,enabled,whatsapp_intake_enabled) VALUES($1,true,true)",
        tenant,
    )
    await pg.execute(
        "INSERT INTO platform.credential_records(id,tenant_id,kind,algorithm,key_version,ciphertext,nonce) VALUES($1,$2,'llm_api_key_v2','aes-256-gcm:model-provider:v2','fixture:v2',$3,$4)",
        cred,
        tenant,
        b"c" * 32,
        b"n" * 12,
    )
    await pg.execute(
        "INSERT INTO agents.model_configurations(id,tenant_id,name,provider,model,credential_id,settings,daily_request_limit,is_enabled) VALUES($1,$2,'Synthetic','gemini','gemini-3.5-flash-lite',$3,$4::jsonb,2,true)",
        config,
        tenant,
        cred,
        json.dumps({"fallbackModel": "gemini-3.1-flash-lite"}),
    )
    await pg.execute(
        "INSERT INTO agents.agent_profiles(id,tenant_id,name) VALUES($1,$2,'Synthetic')",
        profile,
        tenant,
    )
    await pg.execute(
        "INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,version,system_prompt,model_configuration_id,channel_capabilities,tool_permissions,validation_status,published_at) VALUES($1,$2,$3,1,'Synthetic',$4,ARRAY['whatsapp'],'[\"service.intake\"]','valid',now())",
        agent,
        tenant,
        profile,
        config,
    )
    await pg.execute(
        "INSERT INTO crm.contacts(id,tenant_id,name,whatsapp_consent) VALUES($1,$2,'Synthetic','granted')",
        contact,
        tenant,
    )
    await pg.execute(
        "INSERT INTO messaging.channels(id,tenant_id,kind,provider,provider_account_id,status) VALUES($1,$2,'whatsapp','simulator',$3,'active')",
        channel,
        tenant,
        str(channel),
    )
    await pg.execute(
        "INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,ownership_mode,ai_agent_profile_version_id,ai_enabled_by_user_id,ai_enabled_at) VALUES($1,$2,$3,$4,'ai',$5,$6,now())",
        chat,
        tenant,
        channel,
        contact,
        agent,
        actor,
    )
    await pg.execute(
        "INSERT INTO messaging.messages(id,tenant_id,conversation_id,direction,sender_type,content_type,provider,provider_message_id,status,content_text) VALUES($1,$2,$3,'inbound','contact','text','simulator',$4,'received','Synthetic')",
        message,
        tenant,
        chat,
        str(message),
    )
    await pg.execute(
        "INSERT INTO ops.jobs(id,tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key,status,locked_by,claim_token,locked_at,lease_expires_at) VALUES($1,$2,'messaging','field_service.intake.extract','message',$3,$4::jsonb,$5,'running','fixture',$6,now(),now()+interval '10 minutes')",
        job,
        tenant,
        message,
        json.dumps(
            {
                "conversationId": str(chat),
                "contactId": str(contact),
                "triggerMessageId": str(message),
            }
        ),
        str(job),
        claim,
    )
    await pg.execute("SET LOCAL ROLE platform_messaging")
    query = "SELECT platform.field_intake_model_route($1,'fixture',$2,$3,$4::jsonb)"
    snapshot = await pg.fetchval(query, job, claim, False, None)
    assert snapshot is not None
    assert json.loads(snapshot)["configuration"]["id"] == str(config)
    for _ in range(2):
        assert await pg.fetchval(query, job, claim, True, snapshot) == snapshot
    assert await pg.fetchval(query, job, claim, True, snapshot) is None
    assert await pg.fetchval(query, job, uuid4(), False, None) is None
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(other))
    assert await pg.fetchval(query, job, claim, False, None) is None
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(tenant))
    await pg.execute("RESET ROLE")
    await pg.execute("UPDATE platform.credential_records SET nonce=$1 WHERE id=$2", b"r" * 12, cred)
    await pg.execute("SET LOCAL ROLE platform_messaging")
    assert await pg.fetchval(query, job, claim, True, snapshot) is None
    assert await pg.fetchval(query, job, claim, False, None) != snapshot
    await pg.execute("RESET ROLE")
    await pg.execute("UPDATE messaging.conversations SET ownership_mode='human' WHERE id=$1", chat)
    await pg.execute("SET LOCAL ROLE platform_messaging")
    assert await pg.fetchval(query, job, claim, False, None) is None
    await pg.execute("RESET ROLE")
    await pg.execute("SET LOCAL ROLE platform_web")
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.fetchval(query, job, claim, False, None)
