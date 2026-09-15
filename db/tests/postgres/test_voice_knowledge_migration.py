"""Final knowledge migration compatibility and rollback against an owned fixture."""

import os
from collections.abc import AsyncIterator
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import asyncpg
import pytest
import pytest_asyncio
from alembic.config import Config
from alembic.script import ScriptDirectory

from db.tests.postgres.conftest import run_alembic

pytestmark = pytest.mark.postgres


def canonical_head() -> str:
    config = Config(str(Path(__file__).resolve().parents[3] / "db/alembic/alembic.ini"))
    heads = ScriptDirectory.from_config(config).get_heads()
    assert len(heads) == 1
    return heads[0]


@pytest_asyncio.fixture
async def knowledge_database() -> AsyncIterator[str]:
    readiness_url = os.environ.get("READINESS_POSTGRES_URL")
    if readiness_url is None:
        pytest.skip("owned readiness migration proof requires explicit READINESS_POSTGRES_URL")
    target = urlsplit(readiness_url)
    if (
        target.hostname != "127.0.0.1"
        or target.port != 55439
        or target.username != "platform_migrator"
    ):
        pytest.fail("knowledge migration verification requires the owned readiness PostgreSQL")
    database_name = f"oron_voice_quality_{uuid4().hex}"
    control_url = urlunsplit(target._replace(path="/postgres"))
    database_url = urlunsplit(target._replace(path=f"/{database_name}"))
    control = await asyncpg.connect(control_url)
    try:
        await control.execute(f'CREATE DATABASE "{database_name}"')  # noqa: S608
        yield database_url
    finally:
        # This exact identifier was generated and created by this fixture; no
        # existing development or parent readiness database is eligible here.
        await control.execute(f'DROP DATABASE "{database_name}" WITH (FORCE)')  # noqa: S608
        await control.close()


async def test_upgrade_preserves_legacy_documents_and_unpublished_downgrade(
    knowledge_database: str,
) -> None:
    await run_alembic(knowledge_database, "upgrade", "bfb741c767fd")
    connection = await asyncpg.connect(knowledge_database)
    try:
        tenant_id = uuid4()
        await connection.execute(
            "INSERT INTO tenants(id,name,slug,status) VALUES($1,'Fictional legacy', $2,'active')",
            tenant_id,
            f"quality-{tenant_id}",
        )
        source_id = await connection.fetchval(
            "INSERT INTO agents.knowledge_sources(tenant_id,name,source_type) "
            "VALUES($1,'Fictional source','manual') RETURNING id",
            tenant_id,
        )
        original_id = await connection.fetchval(
            "INSERT INTO agents.knowledge_documents(tenant_id,source_id,title,content_checksum) "
            "VALUES($1,$2,'Fictional original','original') RETURNING id",
            tenant_id,
            source_id,
        )
        await run_alembic(knowledge_database, "upgrade", "head")
        original = await connection.fetchrow(
            "SELECT version,published_at,title FROM agents.knowledge_documents WHERE id=$1",
            original_id,
        )
        assert original is not None
        assert dict(original) == {
            "version": 1,
            "published_at": None,
            "title": "Fictional original",
        }
        second = await connection.fetchrow(
            "INSERT INTO agents.knowledge_documents(tenant_id,source_id,title,content_checksum) "
            "VALUES($1,$2,'Fictional second','second') RETURNING id,version,published_at",
            tenant_id,
            source_id,
        )
        assert second is not None
        assert second["version"] == 2
        assert second["published_at"] is None
        await connection.execute(
            "INSERT INTO agents.knowledge_chunks(tenant_id,document_id,ordinal,content) "
            "VALUES($1,$2,0,'fictional searchable content')",
            tenant_id,
            second["id"],
        )
        assert (
            await connection.fetchval(
                "SELECT count(*) FROM agents.knowledge_chunks "
                "WHERE search_vector @@ plainto_tsquery('simple','searchable')"
            )
            == 1
        )
        for role in ("platform_voice", "platform_messaging"):
            assert await connection.fetchval(
                "SELECT has_table_privilege($1,'agents.knowledge_documents','SELECT')", role
            )
            assert not await connection.fetchval(
                "SELECT has_table_privilege($1,'agents.knowledge_documents','UPDATE')", role
            )
        await run_alembic(knowledge_database, "downgrade", "bfb741c767fd")
        assert await connection.fetchval("SELECT count(*) FROM agents.knowledge_documents") == 2
        await run_alembic(knowledge_database, "upgrade", "head")
        assert (
            await connection.fetchval("SELECT version_num FROM alembic_version") == canonical_head()
        )
    finally:
        await connection.close()


async def test_downgrade_refuses_to_discard_published_provenance(
    knowledge_database: str,
) -> None:
    import subprocess

    await run_alembic(knowledge_database, "upgrade", "head")
    connection = await asyncpg.connect(knowledge_database)
    try:
        tenant_id = uuid4()
        await connection.execute(
            "INSERT INTO tenants(id,name,slug,status) VALUES($1,'Fictional published',$2,'active')",
            tenant_id,
            f"published-{tenant_id}",
        )
        source_id = await connection.fetchval(
            "INSERT INTO agents.knowledge_sources(tenant_id,name,source_type,status) "
            "VALUES($1,'Fictional source','approved_manual','published') RETURNING id",
            tenant_id,
        )
        document_id = await connection.fetchval(
            "INSERT INTO agents.knowledge_documents"
            "(tenant_id,source_id,title,content_checksum,published_at) "
            "VALUES($1,$2,'Fictional publication','published',clock_timestamp()) RETURNING id",
            tenant_id,
            source_id,
        )
        with pytest.raises(subprocess.CalledProcessError) as error:
            await run_alembic(knowledge_database, "downgrade", "bfb741c767fd")
        assert "published knowledge provenance requires backup and forward recovery" in (
            error.value.stderr
        )
        assert (
            await connection.fetchval("SELECT version_num FROM alembic_version") == canonical_head()
        )
        assert await connection.fetchval(
            "SELECT published_at IS NOT NULL FROM agents.knowledge_documents WHERE id=$1",
            document_id,
        )
    finally:
        await connection.close()


async def test_voice_active_tenant_check_has_no_arbitrary_scope_or_table_grant(
    knowledge_database: str,
) -> None:
    await run_alembic(knowledge_database, "upgrade", "head")
    connection = await asyncpg.connect(knowledge_database)
    try:
        tenant_id = uuid4()
        other_tenant_id = uuid4()
        for identity, status in ((tenant_id, "active"), (other_tenant_id, "deleted")):
            await connection.execute(
                "INSERT INTO tenants(id,name,slug,status) VALUES($1,'Fictional scope',$2,$3)",
                identity,
                f"scope-{identity}",
                status,
            )
        assert not await connection.fetchval(
            "SELECT has_table_privilege('platform_voice','public.tenants','SELECT')"
        )
        assert not await connection.fetchval(
            "SELECT has_function_privilege('platform_messaging',"
            "'platform.current_tenant_active()','EXECUTE')"
        )
        assert (
            await connection.fetchval(
                "SELECT to_regprocedure('platform.current_tenant_active(uuid)')"
            )
            is None
        )
        await connection.execute("SET ROLE platform_voice")
        assert not await connection.fetchval("SELECT platform.current_tenant_active()")
        await connection.execute("SELECT set_config('app.current_tenant',$1,false)", str(tenant_id))
        assert await connection.fetchval("SELECT platform.current_tenant_active()")
        await connection.execute(
            "SELECT set_config('app.current_tenant',$1,false)", str(other_tenant_id)
        )
        assert not await connection.fetchval("SELECT platform.current_tenant_active()")
        await connection.execute("SELECT set_config('app.current_tenant',$1,false)", str(uuid4()))
        assert not await connection.fetchval("SELECT platform.current_tenant_active()")
        await connection.execute("RESET ROLE")
        await connection.execute("UPDATE tenants SET status='deleted' WHERE id=$1", tenant_id)
        await connection.execute("SET ROLE platform_voice")
        await connection.execute("SELECT set_config('app.current_tenant',$1,false)", str(tenant_id))
        assert not await connection.fetchval("SELECT platform.current_tenant_active()")
    finally:
        await connection.close()
