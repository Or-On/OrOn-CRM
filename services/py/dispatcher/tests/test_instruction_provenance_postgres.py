"""Physical attempt and admitted instruction provenance under the voice DB role."""

import json
import os
from urllib.parse import urlparse
from uuid import uuid4

import asyncpg
import pytest
from dispatcher_runtime.persistence import PostgresVoiceRuntime
from oron_common import CallContext, Direction
from oron_db import set_tenant
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

URL = os.getenv("PUBLICATION_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="owned local publication PostgreSQL required")


async def test_admitted_hash_is_immutable_and_every_fallback_attempt_is_attributed():
    assert URL
    parsed = urlparse(URL)
    assert parsed.hostname in {"127.0.0.1", "localhost"} and parsed.path.startswith("/oron_")
    tenant, other, session, flow, agent = (uuid4() for _ in range(5))
    seed = await asyncpg.connect(URL)
    try:
        for identifier in (tenant, other):
            await seed.execute(
                "INSERT INTO public.tenants(id,name,slug) VALUES($1,$2,$3)",
                identifier,
                "Fictional hash fixture",
                f"hash-{identifier}",
            )
        await seed.execute(
            "INSERT INTO public.sessions(session_id,tenant_id,provider,direction,"
            "room,status,flow_id) "
            "VALUES($1,$2,'livekit','inbound','fictional-hash-room','started',$3)",
            session,
            tenant,
            flow,
        )
    finally:
        await seed.close()
    engine = create_async_engine(
        URL.replace("postgresql://", "postgresql+asyncpg://"),
        connect_args={"server_settings": {"role": "platform_voice"}},
    )
    runtime = object.__new__(PostgresVoiceRuntime)
    runtime._sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    context = CallContext(
        call_id="fictional-hash",
        direction=Direction.INBOUND,
        flow_id=flow,
        tenant_id=tenant,
        session_id=session,
    )
    snapshot = {
        "staticEffectiveInstructionHash": "a" * 64,
        "compositionVersion": "effective-instructions.v1",
        "agentVersionId": str(agent),
        "retainedFlowId": str(flow),
        "retainedFlowVersion": 2,
        "locale": "he",
        "nodeInstructionHashes": {"welcome": "b" * 64},
    }
    try:
        await runtime.record_instruction_snapshot(context, snapshot)
        await runtime.record_instruction_snapshot(context, snapshot)
        with pytest.raises(ValueError, match="immutable"):
            await runtime.record_instruction_snapshot(context, {**snapshot, "locale": "en"})
        for model, status, digest in [
            ("gemini-3.5-flash-lite", "failed", "c"),
            ("gemini-3.1-flash-lite", "succeeded", "d"),
        ]:
            attempt = {
                "attemptId": str(uuid4()),
                "model": model,
                "status": status,
                "partial": False,
                "latencyMs": 5,
                "usage": None,
                "staticEffectiveInstructionHash": snapshot["staticEffectiveInstructionHash"],
                "runtimeInstructionHash": digest * 64,
                "compositionVersion": "effective-instructions.v1",
            }
            await runtime.record_model_attempt(context, attempt)
            await runtime.record_model_attempt(context, attempt)
        async with runtime._sessionmaker() as db, db.begin():
            await set_tenant(db, tenant)
            rows = (
                await db.execute(
                    text(
                        "SELECT event_type,payload FROM session_events "
                        "WHERE session_id=:session ORDER BY sequence"
                    ),
                    {"session": session},
                )
            ).all()
            assert len(rows) == 3
            assert rows[0].payload == snapshot
            assert [row.payload["runtimeInstructionHash"] for row in rows[1:]] == [
                "c" * 64,
                "d" * 64,
            ]
            assert all(row.payload["staticEffectiveInstructionHash"] == "a" * 64 for row in rows)
            assert "fictional-hash-room" not in json.dumps([row.payload for row in rows])
            await set_tenant(db, other)
            assert not (
                await db.execute(
                    text("SELECT 1 FROM session_events WHERE session_id=:id"), {"id": session}
                )
            ).all()
    finally:
        await engine.dispose()
