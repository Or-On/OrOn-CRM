"""Exact retained source reads and staged publication under the real voice role."""

import asyncio
import os
from urllib.parse import urlparse
from uuid import uuid4

import asyncpg
import pytest
from control_api.auth import ServicePrincipal
from control_api.voice import FlowDocumentRequest, PostgresVoiceRepository, SimulatedCallConflict
from sqlalchemy import text

URL = os.getenv("PUBLICATION_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="owned local publication PostgreSQL required")


class RoleRepository(PostgresVoiceRepository):
    async def _scope(self, database, principal):
        await database.execute(text("SET LOCAL ROLE platform_voice"))
        await super()._scope(database, principal)


async def test_exact_source_tenant_denial_server_allocation_and_identical_retry():
    assert URL
    parsed = urlparse(URL)
    assert parsed.hostname in {"localhost", "127.0.0.1"} and parsed.path.startswith("/oron_crm_")
    connection = await asyncpg.connect(URL)
    tenant, actor, flow = uuid4(), uuid4(), uuid4()
    await connection.execute(
        "INSERT INTO public.tenants(id,name,slug)VALUES($1,'Fictional source',$2)",
        tenant,
        f"source-{tenant}",
    )
    await connection.execute(
        "INSERT INTO public.users(id,email,display_name,status)VALUES($1,$2,'Fixture','active')",
        actor,
        f"{actor}@example.invalid",
    )
    await connection.execute(
        "INSERT INTO public.memberships(tenant_id,user_id,role)VALUES($1,$2,'owner')", tenant, actor
    )
    await connection.close()
    principal = ServicePrincipal(
        tenant_id=tenant, user_id=actor, role="owner", session_id=uuid4(), capability="voice:manage"
    )
    repo = RoleRepository(URL)
    source = {
        "flow": {"id": str(flow), "version": 1, "language": "he"},
        "steps": [
            {"id": "welcome", "use": "inform", "say": "שלום"},
            {"id": "end", "use": "announce", "say": "להתראות"},
        ],
    }
    try:
        command = FlowDocumentRequest(source=source, expected_base_version=0, request_id=uuid4())
        first, repeat = await asyncio.gather(
            repo.publish_flow(principal, command), repo.publish_flow(principal, command)
        )
        assert first == repeat
        assert first.publication.status == "published_pending_activation"
        loaded = await repo.get_flow_source(principal, flow, 1)
        assert loaded and loaded.source["steps"][0]["say"] == "שלום"
        assert loaded.editable and loaded.origin == "tenant"
        assert (
            await repo.get_flow_source(principal.model_copy(update={"tenant_id": uuid4()}), flow, 1)
            is None
        )
        assert await repo.get_flow_source(principal, flow, 9) is None
        changed = {
            **source,
            "flow": {**source["flow"], "version": 999},
            "steps": [
                {"id": "welcome", "use": "inform", "say": "שלום מחדש"},
                {"id": "end", "use": "announce", "say": "להתראות"},
            ],
        }
        second = await repo.publish_flow(
            principal,
            FlowDocumentRequest(
                source=changed,
                expected_base_version=1,
                expected_revision=loaded.revision,
                request_id=uuid4(),
            ),
        )
        assert second.flow.latest_version == 2
        assert (await repo.get_flow_source(principal, flow, 1)).revision == loaded.revision
        with pytest.raises(SimulatedCallConflict):
            await repo.publish_flow(
                principal,
                FlowDocumentRequest(
                    source=changed,
                    expected_base_version=1,
                    expected_revision=loaded.revision,
                    request_id=uuid4(),
                ),
            )
        with pytest.raises(SimulatedCallConflict):
            await repo.publish_flow(
                principal,
                FlowDocumentRequest(
                    source=changed, expected_base_version=0, request_id=command.request_id
                ),
            )
    finally:
        await repo.close()


async def test_real_admission_reads_following_inbound_and_pinned_outbound_in_warm_and_second_instances():
    import json
    from pathlib import Path
    from uuid import UUID

    from dispatcher_runtime.persistence import PostgresVoiceRuntime
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    path = os.getenv("PUBLICATION_CONTEXT_PATH")
    if not path:
        pytest.skip("TS publication fixture context required")
    context = json.loads(Path(path).read_text(encoding="utf-8"))
    assert URL
    engine = create_async_engine(
        URL.replace("postgresql://", "postgresql+asyncpg://"),
        connect_args={"server_settings": {"role": "platform_voice"}},
    )
    runtime = object.__new__(PostgresVoiceRuntime)
    runtime._sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    try:
        for _ in range(2):
            incoming = await runtime.get_voice_configuration(
                UUID(context["voice"]), tenant_id=UUID(context["tenant"]), trigger="voice.inbound"
            )
            outgoing = await runtime.get_voice_configuration(
                UUID(context["voice"]),
                tenant_id=UUID(context["tenant"]),
                trigger="voice.outbound_assignment",
            )
            assert incoming["agentVersionId"] == context["newAgent"]
            assert outgoing["agentVersionId"] == context["base"]
        second = object.__new__(PostgresVoiceRuntime)
        second._sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
        assert (
            await second.get_voice_configuration(
                UUID(context["voice"]), tenant_id=UUID(context["tenant"]), trigger="voice.inbound"
            )
        )["agentVersionId"] == context["newAgent"]
    finally:
        await engine.dispose()
