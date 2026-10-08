import os
from urllib.parse import urlsplit
from uuid import uuid4

import pytest
from control_api.auth import ServicePrincipal
from control_api.effective_prompt import PostgresEffectivePromptRepository
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.mark.skipif(
    not os.getenv("CRM_TEST_DATABASE_URL"), reason="owned local PostgreSQL required"
)
async def test_voice_inspector_reads_exact_version_with_runtime_role_and_tenant_isolation():
    url = os.environ["CRM_TEST_DATABASE_URL"]
    parsed = urlsplit(url)
    assert parsed.hostname in {"localhost", "127.0.0.1"} and parsed.path.startswith("/oron_")
    engine = create_async_engine(url.replace("postgresql://", "postgresql+asyncpg://", 1))
    tenant, other, actor, profile, version = (uuid4() for _ in range(5))
    try:
        async with engine.connect() as connection:
            transaction = await connection.begin()
            try:
                for identity in (tenant, other):
                    await connection.execute(
                        text("""
                        INSERT INTO tenants(id,name,slug,status)
                        VALUES(:id,'Fictional inspector',:slug,'active')
                    """),
                        {"id": identity, "slug": f"inspect-{identity}"},
                    )
                await connection.execute(
                    text("""
                    INSERT INTO users(id,email,display_name,status)
                    VALUES(:id,:email,'Fictional owner','active')
                """),
                    {"id": actor, "email": f"inspect-{actor}@example.invalid"},
                )
                await connection.execute(
                    text("""
                    INSERT INTO memberships(tenant_id,user_id,role) VALUES(:tenant,:actor,'owner')
                """),
                    {"tenant": tenant, "actor": actor},
                )
                await connection.execute(
                    text("""
                    INSERT INTO crm.tenant_settings(tenant_id,display_name)
                    VALUES(:tenant,'Fictional')
                """),
                    {"tenant": tenant},
                )
                await connection.execute(
                    text("""
                    INSERT INTO agents.agent_profiles(id,tenant_id,name)
                    VALUES(:profile,:tenant,'Fictional inspector')
                """),
                    {"profile": profile, "tenant": tenant},
                )
                await connection.execute(
                    text("""
                    INSERT INTO agents.agent_profile_versions
                        (id,tenant_id,agent_profile_id,version,system_prompt,locale,
                         channel_capabilities,validation_status)
                    VALUES(:version,:tenant,:profile,1,'Explain fictional services.','he',
                           ARRAY['voice'],'valid')
                """),
                    {"version": version, "tenant": tenant, "profile": profile},
                )
                await connection.execute(text("SET LOCAL ROLE platform_voice"))
                sessions = async_sessionmaker(connection, join_transaction_mode="create_savepoint")
                repository = PostgresEffectivePromptRepository(sessions)
                principal = ServicePrincipal(
                    user_id=actor,
                    tenant_id=tenant,
                    session_id=uuid4(),
                    role="owner",
                    capability="orchestration:read",
                )
                result = await repository.inspect(principal, profile, version, None, None, None)
                assert result is not None and "Explain fictional services." in result.text
                assert result.hash and result.compositionVersion == "effective-instructions.v1"
                principal.tenant_id = other
                assert (
                    await repository.inspect(principal, profile, version, None, None, None) is None
                )
            finally:
                await transaction.rollback()
    finally:
        await engine.dispose()
