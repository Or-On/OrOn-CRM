"""Fictional Voice records only inside the disposable UI preview database."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import asyncpg

from scripts.preview_ui_fixtures import (
    TENANT_ID,
    USER_ID,
    fixture_id,
    validate_fixture_database,
)


async def seed_preview_voice(url: str, database: str) -> dict[str, str]:
    validate_fixture_database(url, database)
    connection = await asyncpg.connect(url, timeout=10)
    try:
        if await connection.fetchval("SELECT current_database()") != database:
            raise ValueError("Connected database is not the owned UI preview")
        async with connection.transaction():
            await connection.execute(
                "SELECT set_config('app.current_tenant', $1, true), "
                "set_config('app.current_user', $2, true), "
                "set_config('app.current_role', 'owner', true)",
                str(TENANT_ID),
                str(USER_ID),
            )
            now = datetime.now(UTC).replace(second=0, microsecond=0)
            voice_flow = fixture_id("voice-flow")
            source = {"flow": {"name": "Fictional service follow-up", "language": "he"}}
            spec = {
                "id": str(voice_flow),
                "version": 1,
                "entry": "start",
                "language": "he",
                "nodes": [{"name": "start", "task_messages": [], "functions": []}],
            }
            await connection.execute(
                "INSERT INTO public.flows (flow_id, version, tenant_id, source, spec, "
                "components_version) VALUES ($1, 1, $2, $3::jsonb, $4::jsonb, '4.0.0') "
                "ON CONFLICT DO NOTHING",
                voice_flow,
                TENANT_ID,
                json.dumps(source),
                json.dumps(spec),
            )
            campaign = fixture_id("voice-campaign")
            await connection.execute(
                "INSERT INTO platform.campaigns (id, tenant_id, name, status, channel, "
                "created_by_user_id, voice_flow_id, max_concurrent, max_attempts, timezone, "
                "weekday_hours) VALUES ($1,$2,'Fictional voice follow-up','draft','voice',"
                "$3,$4,1,2,'Asia/Jerusalem','{}'::jsonb) ON CONFLICT DO NOTHING",
                campaign,
                TENANT_ID,
                USER_ID,
                voice_flow,
            )
            for index in range(8):
                session = fixture_id(f"voice-session-{index}")
                failed = index in {2, 6}
                started = now - timedelta(hours=index, minutes=8)
                seconds = 0 if failed else 45 + index * 17
                await connection.execute(
                    "INSERT INTO public.sessions (session_id, tenant_id, provider, direction, "
                    "room, flow_id, status, answered, outcome, created_at, ended_at, "
                    "contact_id, platform_campaign_id, initiated_by_user_id, call_seconds, "
                    "carrier, llm_model, tts_model) VALUES ($1,$2,'simulator','outbound',$3,$4,"
                    "$5::sessionstatus,$6,$7,$8,$9,$10,$11,$12,$13,'','simulator','simulator') "
                    "ON CONFLICT DO NOTHING",
                    session,
                    TENANT_ID,
                    f"fictional-preview:{session}",
                    voice_flow,
                    "failed" if failed else "ended",
                    not failed,
                    "simulator_failure" if failed else "simulator_completed",
                    started,
                    started + timedelta(seconds=seconds + 6),
                    fixture_id(f"contact-{index % 6}"),
                    campaign,
                    USER_ID,
                    float(seconds),
                )
                events = [
                    ("voice.call.started.v1", {"mode": "simulator"}),
                    ("voice.call.failed.v1", {"reason": "fictional_preview_failure"})
                    if failed
                    else (
                        "voice.call.transcript.updated.v1",
                        {
                            "text": (
                                "Fictional preview conversation. The customer requested a "
                                "follow-up about their service appointment. "
                                "No real call was placed."
                            ),
                            "speaker": "simulator",
                        },
                    ),
                    ("voice.call.ended.v1", {"answered": not failed}),
                ]
                for sequence, (event_type, payload) in enumerate(events, start=1):
                    await connection.execute(
                        "INSERT INTO public.session_events (id, tenant_id, session_id, sequence, "
                        "event_type, version, provider, payload, occurred_at) "
                        "VALUES ($1,$2,$3,$4,$5,1,'simulator',$6::jsonb,$7) ON CONFLICT DO NOTHING",
                        fixture_id(f"voice-event-{index}-{sequence}"),
                        TENANT_ID,
                        session,
                        sequence,
                        event_type,
                        json.dumps(payload),
                        started + timedelta(seconds=sequence),
                    )
            await connection.execute(
                "INSERT INTO public.phone_numbers (id, e164, tenant_id, flow_id, dispatch_rule_id) "
                "VALUES ($1,'+15550100101',$2,$3,'simulator:fictional-preview') "
                "ON CONFLICT DO NOTHING",
                fixture_id("voice-number"),
                TENANT_ID,
                voice_flow,
            )
        return {"call": str(fixture_id("voice-session-0")), "voiceFlow": str(voice_flow)}
    finally:
        await connection.close()
