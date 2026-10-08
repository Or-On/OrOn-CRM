"""Synthetic PostgreSQL acceptance for intake visibility and closed-form fencing."""

import json
from uuid import uuid4

import asyncpg
import pytest

from db.tests.postgres.test_digital_service_form import fixture, role


@pytest.mark.asyncio
async def test_open_observation_does_not_submit_and_is_tenant_bound(pg):
    tenant, intake, digest = await fixture(pg, legacy=False)
    await pg.execute("SELECT service.mark_digital_form_opened($1)", digest)
    await pg.execute("RESET ROLE")
    opened = await pg.fetchval(
        "SELECT first_opened_at FROM service.digital_intake_forms WHERE intake_id=$1", intake
    )
    assert opened is not None
    assert (
        await pg.fetchval("SELECT count(*) FROM service.cases WHERE intake_draft_id=$1", intake)
        == 0
    )
    other, _, _ = await fixture(pg, legacy=False)
    await pg.execute("SELECT service.mark_digital_form_opened($1)", digest)
    assert await pg.fetchval("SELECT service.read_digital_intake_form($1)", digest) is None
    await role(pg, tenant, "platform_web")
    await pg.execute("SELECT service.mark_digital_form_opened($1)", digest)
    await pg.execute("RESET ROLE")
    assert (
        await pg.fetchval(
            "SELECT first_opened_at FROM service.digital_intake_forms WHERE intake_id=$1", intake
        )
        == opened
    )
    assert tenant != other


@pytest.mark.asyncio
async def test_staff_close_is_role_tenant_and_operation_bound(pg):
    tenant, intake, digest = await fixture(pg, legacy=False)
    await pg.execute("RESET ROLE")
    actor = uuid4()
    await pg.execute(
        "INSERT INTO public.users(id,email,status) VALUES($1,$2,'active')",
        actor,
        f"{actor}@example.invalid",
    )
    await pg.execute(
        "INSERT INTO public.memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",
        tenant,
        actor,
    )
    await pg.execute("SELECT set_config('app.current_user',$1,true)", str(actor))
    await role(pg, tenant, "platform_web")
    operation = uuid4()
    await pg.execute("SELECT service.act_on_incomplete_intake($1,'close',$2)", intake, operation)
    await pg.execute("SELECT service.act_on_incomplete_intake($1,'close',$2)", intake, operation)
    assert await pg.fetchval("SELECT service.read_digital_intake_form($1)", digest) is None
    with pytest.raises(asyncpg.InvalidParameterValueError):
        async with pg.transaction():
            await pg.execute(
                "SELECT service.act_on_incomplete_intake($1,'retry',$2)", intake, operation
            )
    await pg.execute("RESET ROLE")
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM service.intake_staff_actions WHERE intake_id=$1", intake
        )
        == 1
    )
    assert (
        await pg.fetchval("SELECT count(*) FROM service.cases WHERE intake_draft_id=$1", intake)
        == 0
    )
    other, _, _ = await fixture(pg, legacy=False)
    await pg.execute("SELECT set_config('app.current_user',$1,true)", str(actor))
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.execute(
                "SELECT service.act_on_incomplete_intake($1,'close',$2)", intake, uuid4()
            )
    assert tenant != other


@pytest.mark.asyncio
async def test_message_brand_snapshot_is_frozen_but_revocation_is_live(pg):
    tenant, intake, digest = await fixture(pg, legacy=False)
    await role(pg, tenant, "platform_messaging")
    before = json.loads(await pg.fetchval("SELECT service.digital_form_brand_snapshot($1)", digest))
    await pg.execute("RESET ROLE")
    await pg.execute("UPDATE public.tenants SET name='Changed fictional brand' WHERE id=$1", tenant)
    await role(pg, tenant, "platform_messaging")
    assert (
        json.loads(await pg.fetchval("SELECT service.digital_form_brand_snapshot($1)", digest))
        == before
    )
    await pg.execute("RESET ROLE")
    await pg.execute("UPDATE service.intake_drafts SET status='expired' WHERE id=$1", intake)
    await role(pg, tenant, "platform_web")
    assert await pg.fetchval("SELECT service.read_digital_intake_form($1)", digest) is None


@pytest.mark.asyncio
async def test_reissued_token_does_not_inherit_the_previous_open_observation(pg):
    tenant, intake, digest = await fixture(pg, legacy=False)
    await pg.execute("SELECT service.mark_digital_form_opened($1)", digest)
    await pg.execute("RESET ROLE")
    assert await pg.fetchval(
        "SELECT first_opened_at FROM service.digital_intake_forms WHERE intake_id=$1", intake
    )
    # Expire the old link; the staff lifecycle must restore eligibility before issuing.
    await pg.execute(
        "UPDATE service.digital_intake_forms SET expires_at=now()-interval '1 second' "
        "WHERE intake_id=$1",
        intake,
    )
    await pg.execute(
        "UPDATE service.intake_drafts SET followup_status='requested' WHERE id=$1", intake
    )
    new_hash = uuid4().hex + uuid4().hex
    await role(pg, tenant, "platform_messaging")
    await pg.execute("SELECT service.issue_digital_intake_form($1,$2)", intake, new_hash)
    await role(pg, tenant, "platform_web")
    assert await pg.fetchval("SELECT service.read_digital_intake_form($1)", digest) is None
    assert await pg.fetchval("SELECT service.read_digital_intake_form($1)", new_hash) is not None
    await pg.execute("RESET ROLE")
    assert (
        await pg.fetchval(
            "SELECT first_opened_at FROM service.digital_intake_forms WHERE intake_id=$1", intake
        )
        is None
    )
