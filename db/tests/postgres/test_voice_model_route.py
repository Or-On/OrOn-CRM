"""Explicit voice routing: real session authority, encrypted binding and shared quota."""

import json
from uuid import uuid4

import asyncpg
import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from dispatcher_runtime.model_route import resolve_route

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]


async def test_voice_route_never_borrows_credentials_and_reserves_each_attempt(pg):
    tenant, other, profile, agent, configuration, credential, call = [uuid4() for _ in range(7)]
    for owner in (tenant, other):
        await pg.execute(
            "INSERT INTO tenants(id,name,slug) VALUES($1,'Synthetic model route',$2)",
            owner,
            str(owner),
        )
    key, nonce = b"f" * 32, b"n" * 12
    aad = json.dumps(
        ["oron.model.provider.v2", str(tenant), str(configuration), str(credential), "gemini"],
        separators=(",", ":"),
    ).encode()
    ciphertext = AESGCM(key).encrypt(nonce, b'{"apiKey":"synthetic-provider-token"}', aad)
    await pg.execute(
        "INSERT INTO "
        "platform.credential_records(id,tenant_id,kind,algorithm,key_version,ciphertext,nonce) "
        "VALUES($1,$2,'llm_api_key_v2','aes-256-gcm:model-provider:v2','fixture:v2',$3,$4)",
        credential,
        tenant,
        ciphertext,
        nonce,
    )
    await pg.execute(
        "INSERT INTO "
        "agents.model_configurations(id,tenant_id,name,provider,model,credential_id,settings,"
        "daily_request_limit,is_enabled) VALUES($1,$2,'Synthetic model','gemini',"
        "'gemini-3.5-flash-lite',$3,'{\"fallbackModel\":\"gemini-3.1-flash-lite\"}',2,true)",
        configuration,
        tenant,
        credential,
    )
    await pg.execute(
        "INSERT INTO agents.agent_profiles(id,tenant_id,name) VALUES($1,$2,'Synthetic model "
        "agent')",
        profile,
        tenant,
    )
    await pg.execute(
        "INSERT INTO "
        "agents.agent_profile_versions(id,tenant_id,agent_profile_id,version,system_prompt,"
        "model_configuration_id,channel_capabilities,validation_status,published_at) "
        "VALUES($1,$2,$3,1,'Synthetic',$4,ARRAY['voice'],'valid',now())",
        agent,
        tenant,
        profile,
        configuration,
    )
    await pg.execute(
        "INSERT INTO sessions(session_id,tenant_id,direction,room,flow_id,provider,status) "
        "VALUES($1,$2,'inbound',$3,$4,'livekit','started')",
        call,
        tenant,
        str(call),
        uuid4(),
    )
    await pg.execute(
        "INSERT INTO session_events(tenant_id,session_id,sequence,event_type,payload) "
        "VALUES($1,$2,0,'voice.agent.binding.v1',$3::jsonb)",
        tenant,
        call,
        json.dumps({"agent_version_id": str(agent)}),
    )
    await pg.execute(
        "INSERT INTO voice_session_controls(tenant_id,session_id) VALUES($1,$2)", tenant, call
    )
    await pg.execute("SET LOCAL ROLE platform_voice")
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(tenant))
    snapshot = await pg.fetchval("SELECT platform.voice_model_route($1,false,NULL)", call)
    assert snapshot is not None
    data = json.loads(snapshot)
    route = resolve_route(data, {"fixture:v2": key}, str(tenant))
    assert route["model"] == "gemini-3.5-flash-lite"
    assert route["apiKey"].get_secret_value() == "synthetic-provider-token"
    with pytest.raises(ValueError, match="unavailable"):
        resolve_route(data, {"fixture:v2": key}, str(other))
    for _ in range(2):
        assert (
            await pg.fetchval(
                "SELECT platform.voice_model_route($1,true,$2::jsonb)", call, snapshot
            )
            == snapshot
        )
    assert (
        await pg.fetchval("SELECT platform.voice_model_route($1,true,$2::jsonb)", call, snapshot)
        is None
    )
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(other))
    assert await pg.fetchval("SELECT platform.voice_model_route($1,false,NULL)", call) is None
    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE platform.credential_records SET nonce=$1 WHERE id=$2", b"r" * 12, credential
    )
    await pg.execute("SET LOCAL ROLE platform_voice")
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(tenant))
    assert (
        await pg.fetchval("SELECT platform.voice_model_route($1,true,$2::jsonb)", call, snapshot)
        is None
    )
    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE voice_session_controls SET desired_mode='paused' WHERE session_id=$1", call
    )
    await pg.execute("SET LOCAL ROLE platform_voice")
    assert await pg.fetchval("SELECT platform.voice_model_route($1,false,NULL)", call) is None
    await pg.execute("RESET ROLE")
    await pg.execute("SET LOCAL ROLE platform_web")
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.fetchval("SELECT platform.voice_model_route($1,false,NULL)", call)
