from uuid import uuid4

import asyncpg
import pytest

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.rls]

SWEEP = "platform.fail_stale_voice_sessions(integer)"


async def _session(
    connection: asyncpg.Connection, *, status: str, age_minutes: int
) -> tuple[object, object]:
    tenant_id = uuid4()
    session_id = uuid4()
    await connection.execute(
        "INSERT INTO tenants(id,name,slug) VALUES($1,$2,$3)",
        tenant_id,
        "Fictional Sweep Tenant",
        f"sweep-{tenant_id}",
    )
    await connection.execute(
        "INSERT INTO public.sessions(session_id,tenant_id,provider,direction,room,status,"
        "flow_id,created_at) VALUES($1,$2,'livekit','outbound',$3,$4,$5,"
        "CURRENT_TIMESTAMP - make_interval(mins => $6))",
        session_id,
        tenant_id,
        f"sweep-{session_id}",
        status,
        uuid4(),
        age_minutes,
    )
    return tenant_id, session_id


async def _status(connection: asyncpg.Connection, session_id: object) -> asyncpg.Record:
    return await connection.fetchrow(
        "SELECT status::text AS status, ended_at FROM public.sessions WHERE session_id=$1",
        session_id,
    )


async def test_voice_role_sweeps_only_stale_started_sessions_across_tenants(
    pg: asyncpg.Connection,
) -> None:
    _, stale = await _session(pg, status="started", age_minutes=180)
    _, live = await _session(pg, status="started", age_minutes=10)
    _, ended = await _session(pg, status="ended", age_minutes=180)

    await pg.execute("SET LOCAL ROLE platform_voice")
    # Without a tenant scope the runtime role sees nothing: the definer function
    # is the only path that reaches every tenant's stale rows.
    assert await pg.fetchval("SELECT count(*) FROM public.sessions") == 0
    failed = await pg.fetchval("SELECT platform.fail_stale_voice_sessions(120)")
    await pg.execute("RESET ROLE")

    assert failed >= 1
    stale_row = await _status(pg, stale)
    assert stale_row["status"] == "failed"
    assert stale_row["ended_at"] is not None
    assert (await _status(pg, live))["status"] == "started"
    ended_row = await _status(pg, ended)
    assert ended_row["status"] == "ended"


async def test_sweep_refuses_a_threshold_that_could_fail_live_calls(
    pg: asyncpg.Connection,
) -> None:
    for minutes in (None, 0, 59, 10081):
        async with pg.transaction():
            with pytest.raises(asyncpg.InvalidParameterValueError):
                await pg.fetchval("SELECT platform.fail_stale_voice_sessions($1)", minutes)


async def test_only_the_voice_role_may_run_the_sweep(pg: asyncpg.Connection) -> None:
    allowed = {
        role: await pg.fetchval("SELECT has_function_privilege($1, $2, 'EXECUTE')", role, SWEEP)
        for role in ("platform_voice", "platform_web", "platform_messaging")
    }
    assert allowed == {
        "platform_voice": True,
        "platform_web": False,
        "platform_messaging": False,
    }
    definition = await pg.fetchrow(
        "SELECT prosecdef, proconfig FROM pg_proc WHERE oid = $1::regprocedure", SWEEP
    )
    assert definition["prosecdef"]
    assert "search_path=pg_catalog" in definition["proconfig"]
