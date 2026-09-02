"""Durable simulator-only bridge to the retained PostgreSQL voice repository.

Claim, eligibility locks, session/events, audit/outbox and completion share one
transaction. No network provider or dispatcher can be selected by a job payload.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, ValidationError
from sqlalchemy import text

from control_api.auth import ServicePrincipal
from control_api.voice import PostgresVoiceRepository, SimulatedCallRequest
from control_api.voice_flow_adapter import adapt_retained_voice_flow


class VoiceSimulationPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["simulator"]
    contactId: UUID
    conversationId: UUID
    actorUserId: UUID
    flowId: UUID | None = None
    flowVersion: int | None = None


class IneligibleSimulation(ValueError):
    """Consent, membership or contact/conversation ownership no longer permits work."""


async def consume_voice_simulation(repository: PostgresVoiceRepository, worker_id: str) -> bool:
    async with repository.simulation_transaction() as database:
        job = (
            (
                await database.execute(
                    text("SELECT * FROM ops.claim_voice_simulation(:worker)"), {"worker": worker_id}
                )
            )
            .mappings()
            .first()
        )
        if job is None:
            return False
        tenant_id, job_id = job["tenant_id"], job["id"]
        await database.execute(
            text("SELECT set_config('app.current_tenant', :tenant, true)"),
            {"tenant": str(tenant_id)},
        )
        row = (
            (
                await database.execute(
                    text("SELECT payload, reference_id FROM ops.jobs WHERE id = :id FOR UPDATE"),
                    {"id": job_id},
                )
            )
            .mappings()
            .one()
        )
        permanent = False
        try:
            async with database.begin_nested():
                payload = VoiceSimulationPayload.model_validate(row["payload"])
                if payload.contactId != row["reference_id"]:
                    raise IneligibleSimulation
                await database.execute(
                    text("SELECT set_config('app.current_user', :actor, true)"),
                    {"actor": str(payload.actorUserId)},
                )
                eligible = await database.scalar(
                    text("SELECT platform.voice_simulation_eligible(:contact, :conversation)"),
                    {"contact": payload.contactId, "conversation": payload.conversationId},
                )
                if not eligible:
                    raise IneligibleSimulation
                retained_flow = None
                if payload.flowId is not None or payload.flowVersion is not None:
                    if payload.flowId is None or payload.flowVersion is None:
                        raise IneligibleSimulation
                    spec = await database.scalar(
                        text(
                            "SELECT spec FROM public.flows WHERE flow_id=:id AND version=:version"
                        ),
                        {"id": payload.flowId, "version": payload.flowVersion},
                    )
                    if spec is None:
                        raise IneligibleSimulation
                    retained_flow = adapt_retained_voice_flow(
                        payload.flowId, payload.flowVersion, spec
                    )
                principal = ServicePrincipal(
                    user_id=payload.actorUserId,
                    tenant_id=tenant_id,
                    role="agent",
                    session_id=job_id,
                    capability="voice:write",
                )
                await repository.simulate_call(
                    principal,
                    SimulatedCallRequest(
                        contact_id=payload.contactId,
                        idempotency_key=f"cross-channel:{job_id}",
                    ),
                    transaction=database,
                    retained_flow=retained_flow,
                )
        except ValidationError, IneligibleSimulation:
            permanent = True
            error_code = "voice_simulation_ineligible"
        except Exception:
            # Persist a fixed code, never exception strings, payloads or SQL parameters.
            error_code = "voice_simulation_retryable"
        else:
            await database.execute(
                text("""
                UPDATE ops.jobs SET status = 'succeeded', completed_at = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP, locked_by = NULL, locked_at = NULL,
                  last_error_safe = NULL WHERE id = :id AND locked_by = :worker
            """),
                {"id": job_id, "worker": worker_id},
            )
            return True
        await database.execute(
            text("""
            UPDATE ops.jobs SET status = CASE WHEN :permanent OR attempts >= max_attempts
                THEN 'dead' ELSE 'retry' END,
              available_at = CURRENT_TIMESTAMP + make_interval(secs =>
                LEAST(3600, power(2, LEAST(attempts, 10)) + random() * 5)),
              completed_at = CASE WHEN :permanent OR attempts >= max_attempts
                THEN CURRENT_TIMESTAMP ELSE NULL END,
              updated_at = CURRENT_TIMESTAMP, locked_at = NULL, locked_by = NULL,
              last_error_safe = :error WHERE id = :id AND locked_by = :worker
        """),
            {"id": job_id, "worker": worker_id, "permanent": permanent, "error": error_code},
        )
        return True


async def run_voice_simulations(
    repository: PostgresVoiceRepository, logger: logging.Logger
) -> None:
    worker_id = f"voice-simulator:{uuid4()}"
    while True:
        try:
            consumed = await consume_voice_simulation(repository, worker_id)
        except Exception:
            logger.warning("voice_simulation_poll_failed")
            consumed = False
        await asyncio.sleep(0.05 if consumed else 2)
