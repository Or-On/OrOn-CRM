"""Actual PostgreSQL roles: only a bearer-authorized explicit submission opens a case."""

import asyncio
import hashlib
import json
import os
import subprocess
import sys
from uuid import uuid4

import asyncpg
import pytest

from db.tests.postgres.conftest import ROOT, run_alembic

POLICY = {
    "version": 1,
    "requiredIntakeFields": [
        "customerName",
        "customerPhone",
        "serviceLocation",
        "faultDescription",
    ],
    "photoPolicy": "requested",
    "selfAssignmentEnabled": True,
    "requiredReportFields": ["diagnosis"],
    "inquiry": {"openOnFirstContact": False},
    "whatsappFollowUp": {
        "enabled": True,
        "trigger": "intake_saved",
        "requestPhoto": True,
        "consent": "in_call_agreement",
        "mode": "form",
    },
}


async def role(pg, tenant, name):
    await pg.execute("RESET ROLE")
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(tenant))
    await pg.execute(f"SET LOCAL ROLE {name}")  # noqa: S608 -- test-owned role constant


async def fixture(pg, *, photo_required=False):
    await pg.execute("RESET ROLE")
    tenant, contact, session, intake = (uuid4() for _ in range(4))
    token = uuid4().hex + uuid4().hex
    digest = hashlib.sha256(token.encode()).hexdigest()
    await pg.execute(
        "INSERT INTO tenants(id,name,slug,status) VALUES($1,'Fictional service',$2,'active')",
        tenant,
        f"digital-{tenant}",
    )
    await pg.execute("SELECT set_config('app.current_tenant',$1,true)", str(tenant))
    policy = {**POLICY, "photoPolicy": "required" if photo_required else "requested"}
    for feature in ["field_service", "tickets", "whatsapp", "contacts", "voice"]:
        await pg.execute(
            """INSERT INTO platform.tenant_feature_entitlements(
          tenant_id,feature_key,available,enabled,source,configuration,granted_at)
          VALUES($1,$2,true,true,'provisioning',$3::jsonb,now()) ON CONFLICT(tenant_id,feature_key)
          DO UPDATE SET available=true,enabled=true,configuration=EXCLUDED.configuration""",
            tenant,
            feature,
            json.dumps({"workflow": policy} if feature == "field_service" else {}),
        )
    await pg.execute(
        "INSERT INTO service.tenant_configuration(tenant_id,enabled,whatsapp_intake_enabled) "
        "VALUES($1,true,false)",
        tenant,
    )
    await pg.execute(
        "INSERT INTO crm.contacts(id,tenant_id,name,whatsapp_consent) "
        "VALUES($1,$2,'+972502345678','granted')",
        contact,
        tenant,
    )
    await pg.execute(
        "INSERT INTO sessions(session_id,provider,direction,room,status,tenant_id,"
        "flow_id,contact_id,ended_at) "
        "VALUES($1,'livekit','inbound',$2,'ended',$3,$4,$5,now())",
        session,
        f"fictional-{session}",
        tenant,
        uuid4(),
        contact,
    )
    await pg.execute(
        """INSERT INTO service.intake_drafts(id,tenant_id,reporting_contact_id,
      customer_contact_id,customer_resolution_status,
      correlation_key,collected_fields,source_session_id,followup_status,workflow_policy)
      VALUES($1,$2,$3,$3,'reporting_contact',$4,$5::jsonb,$6,'requested',$7::jsonb)""",
        intake,
        tenant,
        contact,
        f"voice:{session}",
        json.dumps(
            {
                "customerName": "דנה",
                "customerPhone": "+972502345678",
                "faultDescription": "מסך לא נדלק",
            }
        ),
        session,
        json.dumps(policy),
    )
    await role(pg, tenant, "platform_messaging")
    assert (
        await pg.fetchval("SELECT service.issue_digital_intake_form($1,$2)", intake, digest)
        == tenant
    )
    await pg.execute("RESET ROLE")
    await pg.execute(
        "UPDATE service.intake_drafts SET followup_status='admitted' WHERE id=$1", intake
    )
    await role(pg, tenant, "platform_web")
    return tenant, intake, digest


async def submit(pg, digest, *, confirmed=True, photos=None):
    return json.loads(
        await pg.fetchval(
            "SELECT service.submit_digital_intake_form("
            "$1,'דנה','רחוב לדוגמה 12','מסך לא נדלק',$2,$3::jsonb)",
            digest,
            confirmed,
            json.dumps(photos or []),
        )
    )


@pytest.mark.asyncio
async def test_read_then_explicit_submission_is_atomic_and_idempotent(pg):
    tenant, intake, digest = await fixture(pg)
    initial = json.loads(await pg.fetchval("SELECT service.read_digital_intake_form($1)", digest))
    assert initial["businessName"] == "Fictional service"
    await role(pg, tenant, "platform_migrator")
    await pg.execute(
        "INSERT INTO crm.tenant_settings(tenant_id,business_name) VALUES($1,'Fictional Repairs')",
        tenant,
    )
    await role(pg, tenant, "platform_web")
    result = json.loads(await pg.fetchval("SELECT service.read_digital_intake_form($1)", digest))
    assert result["businessName"] == "Fictional Repairs"
    assert result["customerName"] == "דנה"
    assert result["faultDescription"] == "מסך לא נדלק"
    assert result["submitted"] is False
    async with pg.transaction():
        await pg.execute("RESET ROLE")
        assert (
            await pg.fetchval("SELECT count(*) FROM service.cases WHERE tenant_id=$1", tenant) == 0
        )
    await role(pg, tenant, "platform_web")
    receipt = await submit(pg, digest)
    assert receipt["created"] is True
    assert receipt["reference"].startswith("FS-")
    assert await submit(pg, digest) == {"reference": receipt["reference"], "created": False}
    await pg.execute("RESET ROLE")
    assert (
        await pg.fetchval("SELECT count(*) FROM service.cases WHERE intake_draft_id=$1", intake)
        == 1
    )
    assert (
        await pg.fetchval("SELECT status FROM service.cases WHERE intake_draft_id=$1", intake)
        == "awaiting_scheduling"
    )
    assert (
        await pg.fetchval("SELECT address FROM crm.service_locations WHERE tenant_id=$1", tenant)
        == "רחוב לדוגמה 12"
    )
    assert (
        await pg.fetchval("SELECT count(*) FROM service.case_calls WHERE tenant_id=$1", tenant) == 1
    )


@pytest.mark.asyncio
async def test_invalid_cross_tenant_expired_and_unconfirmed_links_do_not_open_cases(pg):
    tenant, intake, digest = await fixture(pg)
    assert await pg.fetchval("SELECT service.read_digital_intake_form($1)", "0" * 64) is None
    with pytest.raises(asyncpg.InvalidParameterValueError):
        async with pg.transaction():
            await submit(pg, digest, confirmed=False)
    # A second real tenant cannot redeem another tenant's token.
    other, _, _ = await fixture(pg)
    assert other != tenant
    assert await pg.fetchval("SELECT service.read_digital_intake_form($1)", digest) is None
    with pytest.raises(asyncpg.NoDataFoundError):
        async with pg.transaction():
            await submit(pg, digest)
    await role(pg, tenant, "platform_migrator")
    await pg.execute(
        "UPDATE service.digital_intake_forms SET expires_at=clock_timestamp()-interval '1 second' "
        "WHERE intake_id=$1",
        intake,
    )
    await role(pg, tenant, "platform_web")
    assert await pg.fetchval("SELECT service.read_digital_intake_form($1)", digest) is None
    with pytest.raises(asyncpg.NoDataFoundError):
        async with pg.transaction():
            await submit(pg, digest)


@pytest.mark.asyncio
async def test_worker_and_direct_case_paths_cannot_finalize_a_form(pg):
    tenant, intake, _ = await fixture(pg)
    await role(pg, tenant, "platform_messaging")
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.fetchval("SELECT service.open_form_intake_case($1)", intake)
    await pg.execute("RESET ROLE")
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO service.cases(tenant_id,reference,title,fault_description,"
                "intake_draft_id,source) "
                "VALUES($1,'FS-FORBIDDEN','Fictional','Fictional',$2,'voice')",
                tenant,
                intake,
            )
    assert (
        await pg.fetchval("SELECT count(*) FROM service.cases WHERE intake_draft_id=$1", intake)
        == 0
    )


@pytest.mark.asyncio
async def test_required_photos_and_private_case_attachments(pg):
    tenant, intake, digest = await fixture(pg, photo_required=True)
    with pytest.raises(asyncpg.InvalidParameterValueError):
        async with pg.transaction():
            await submit(pg, digest)
    photo = {
        "contentType": "image/png",
        "byteSize": 80,
        "checksum": "a" * 64,
        "storageBackend": "local",
        "storageKey": f"{tenant}/field-service/{intake}/customer_photo/2026/10/{uuid4()}.png",
    }
    receipt = await submit(pg, digest, photos=[photo])
    assert receipt["created"] is True
    await pg.execute("RESET ROLE")
    attachments = await pg.fetch(
        "SELECT a.source,a.category,o.status,o.owner_id=a.case_id AS bound "
        "FROM service.report_attachments a JOIN objects.object_metadata o "
        "ON o.tenant_id=a.tenant_id AND o.id=a.object_id WHERE a.tenant_id=$1",
        tenant,
    )
    assert len(attachments) == 1
    assert dict(attachments[0]) == {
        "source": "customer",
        "category": "customer_photo",
        "status": "available",
        "bound": True,
    }


@pytest.mark.asyncio
async def test_template_access_is_explicit_and_not_inherited_by_new_tenant(pg):
    tenant, _, _ = await fixture(pg)
    assert await pg.fetchval("SELECT platform.whatsapp_templates_enabled()") is False
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.execute(
                "INSERT INTO platform.whatsapp_template_policy VALUES($1,true)", tenant
            )
    await role(pg, tenant, "platform_migrator")
    await pg.execute("INSERT INTO platform.whatsapp_template_policy VALUES($1,true)", tenant)
    await role(pg, tenant, "platform_web")
    assert await pg.fetchval("SELECT platform.whatsapp_templates_enabled()") is True


@pytest.mark.asyncio
@pytest.mark.parametrize("disabled", ["tenant", "field_service", "tickets"])
async def test_existing_form_capability_cannot_read_or_submit_after_tenant_or_feature_revocation(
    pg, disabled
):
    tenant, intake, digest = await fixture(pg)
    await role(pg, tenant, "platform_migrator")
    if disabled == "tenant":
        await pg.execute("UPDATE public.tenants SET status='suspended' WHERE id=$1", tenant)
    elif disabled == "field_service":
        await pg.execute(
            "UPDATE service.tenant_configuration SET enabled=false WHERE tenant_id=$1", tenant
        )
    else:
        await pg.execute(
            "UPDATE platform.tenant_feature_entitlements SET enabled=false "
            "WHERE tenant_id=$1 AND feature_key=$2",
            tenant,
            disabled,
        )
    await role(pg, tenant, "platform_messaging")
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with pg.transaction():
            await pg.fetchval("SELECT service.issue_digital_intake_form($1,$2)", intake, "b" * 64)
    await role(pg, tenant, "platform_web")
    assert await pg.fetchval("SELECT service.read_digital_intake_form($1)", digest) is None
    with pytest.raises(asyncpg.NoDataFoundError):
        async with pg.transaction():
            await submit(pg, digest)
    await pg.execute("RESET ROLE")
    assert (
        await pg.fetchval("SELECT count(*) FROM service.cases WHERE intake_draft_id=$1", intake)
        == 0
    )


def photo_for(tenant, intake):
    return {
        "contentType": "image/png",
        "byteSize": 80,
        "checksum": "a" * 64,
        "storageBackend": "local",
        "storageKey": f"{tenant}/field-service/{intake}/customer_photo/2026/10/{uuid4()}.png",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "key", ["contentType", "byteSize", "checksum", "storageBackend", "storageKey"]
)
@pytest.mark.parametrize("invalid", ["missing", "null", "object"])
async def test_photo_metadata_requires_nonnull_scalar_values_before_case_creation(pg, key, invalid):
    tenant, intake, digest = await fixture(pg)
    photo = photo_for(tenant, intake)
    if invalid == "missing":
        del photo[key]
    else:
        photo[key] = None if invalid == "null" else {"unexpected": True}
    with pytest.raises(asyncpg.InvalidParameterValueError):
        async with pg.transaction():
            await submit(pg, digest, photos=[photo])
    form = json.loads(await pg.fetchval("SELECT service.read_digital_intake_form($1)", digest))
    assert form["submitted"] is False
    await pg.execute("RESET ROLE")
    assert (
        await pg.fetchval("SELECT count(*) FROM service.cases WHERE intake_draft_id=$1", intake)
        == 0
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "invalid",
    [
        "foreign_tenant",
        "foreign_intake",
        "parent_path",
        "backslash",
        "non_image",
        "zero",
        "fractional",
        "numeric_string",
        "oversize",
        "bad_checksum",
        "duplicate_key",
        "total_size",
    ],
)
async def test_photos_are_bounded_and_confined_to_the_same_tenant_intake(pg, invalid):
    tenant, intake, digest = await fixture(pg)
    photo = photo_for(tenant, intake)
    if invalid == "foreign_tenant":
        photo["storageKey"] = photo["storageKey"].replace(str(tenant), str(uuid4()))
    elif invalid == "foreign_intake":
        photo["storageKey"] = photo["storageKey"].replace(str(intake), str(uuid4()))
    elif invalid == "parent_path":
        photo["storageKey"] += "/../../foreign.png"
    elif invalid == "backslash":
        photo["storageKey"] += "\\..\\foreign.png"
    elif invalid == "non_image":
        photo["contentType"] = "text/html"
    elif invalid == "zero":
        photo["byteSize"] = 0
    elif invalid == "fractional":
        photo["byteSize"] = 1.5
    elif invalid == "numeric_string":
        photo["byteSize"] = "80"
    elif invalid == "oversize":
        photo["byteSize"] = 12582913
    elif invalid == "bad_checksum":
        photo["checksum"] = "invalid"
    photos = [photo]
    if invalid == "duplicate_key":
        photos.append(dict(photo))
    elif invalid == "total_size":
        photos = [
            {**photo, "byteSize": 12 * 1024 * 1024},
            {**photo_for(tenant, intake), "byteSize": 12 * 1024 * 1024},
        ]
    with pytest.raises(asyncpg.InvalidParameterValueError):
        async with pg.transaction():
            await submit(pg, digest, photos=photos)
    form = json.loads(await pg.fetchval("SELECT service.read_digital_intake_form($1)", digest))
    assert form["submitted"] is False


@pytest.mark.asyncio
async def test_photo_metadata_insert_failure_rolls_back_case_submission_and_token_state(pg):
    tenant, intake, digest = await fixture(pg)
    photo = photo_for(tenant, intake)
    await role(pg, tenant, "platform_migrator")
    await pg.execute(
        "INSERT INTO objects.object_metadata(tenant_id,owner_type,category,content_type,"
        "byte_size,checksum,storage_backend,storage_key,status) "
        "VALUES($1,'fixture','customer_photo','image/png',80,$2,'local',$3,'available')",
        tenant,
        photo["checksum"],
        photo["storageKey"],
    )
    await role(pg, tenant, "platform_web")
    with pytest.raises(asyncpg.UniqueViolationError):
        async with pg.transaction():
            await submit(pg, digest, photos=[photo])
    form = json.loads(await pg.fetchval("SELECT service.read_digital_intake_form($1)", digest))
    assert form["submitted"] is False and form["reference"] is None
    await pg.execute("RESET ROLE")
    assert (
        await pg.fetchval("SELECT count(*) FROM service.cases WHERE intake_draft_id=$1", intake)
        == 0
    )
    assert await pg.fetchval("SELECT count(*) FROM support.tickets WHERE tenant_id=$1", tenant) == 0
    assert (
        await pg.fetchval(
            "SELECT count(*) FROM service.report_attachments WHERE tenant_id=$1", tenant
        )
        == 0
    )
    assert (
        await pg.fetchval("SELECT count(*) FROM objects.object_metadata WHERE tenant_id=$1", tenant)
        == 1
    )
    await role(pg, tenant, "platform_web")
    assert (await submit(pg, digest, photos=[photo_for(tenant, intake)]))["created"] is True


@pytest.mark.asyncio
async def test_two_actual_connections_serialize_duplicate_submission_into_one_case(
    isolated_postgres_url,
):
    await run_alembic(isolated_postgres_url, "upgrade", "head")
    postgres_url = isolated_postgres_url
    seed = await asyncpg.connect(postgres_url)
    tenant = None
    first_written, release_first, second_started = asyncio.Event(), asyncio.Event(), asyncio.Event()
    tasks = []
    try:
        async with seed.transaction():
            tenant, intake, digest = await fixture(seed)

        async def caller(first):
            connection = await asyncpg.connect(postgres_url)
            try:
                async with connection.transaction():
                    await role(connection, tenant, "platform_web")
                    if not first:
                        second_started.set()
                    receipt = await submit(connection, digest)
                    if first:
                        first_written.set()
                        await asyncio.wait_for(release_first.wait(), timeout=5)
                    return receipt
            finally:
                await connection.close()

        first = asyncio.create_task(caller(True))
        tasks.append(first)
        await asyncio.wait_for(first_written.wait(), timeout=5)
        second = asyncio.create_task(caller(False))
        tasks.append(second)
        await asyncio.wait_for(second_started.wait(), timeout=5)
        await asyncio.sleep(0.05)
        assert not second.done(), "Second submit must wait for the first transaction's row lock"
        release_first.set()
        results = await asyncio.wait_for(asyncio.gather(*tasks), timeout=10)
        assert [row["created"] for row in results] == [True, False]
        assert results[0]["reference"] == results[1]["reference"]
        async with seed.transaction():
            await role(seed, tenant, "platform_migrator")
            assert (
                await seed.fetchval(
                    "SELECT count(*) FROM service.cases WHERE intake_draft_id=$1", intake
                )
                == 1
            )
            assert (
                await seed.fetchval(
                    "SELECT count(*) FROM service.case_calls WHERE tenant_id=$1", tenant
                )
                == 1
            )
            assert (
                await seed.fetchval(
                    "SELECT count(*) FROM support.tickets WHERE tenant_id=$1", tenant
                )
                == 1
            )
    finally:
        release_first.set()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await seed.close()


@pytest.mark.asyncio
async def test_offline_upgrade_and_refused_downgrade_preserve_submission_guard(
    isolated_postgres_url,
):
    await run_alembic(isolated_postgres_url, "upgrade", "d8b2f6a4c917")
    environment = dict(os.environ, DATABASE_URL=isolated_postgres_url)
    rendered = await asyncio.to_thread(
        subprocess.run,  # noqa: S603 -- fixed local Alembic command, disposable database
        [
            sys.executable,
            "-m",
            "alembic",
            "-c",
            str(ROOT / "db" / "alembic" / "alembic.ini"),
            "upgrade",
            "d8b2f6a4c917:e9c5b8d2a401",
            "--sql",
        ],
        cwd=ROOT,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        await connection.execute(rendered.stdout)
        assert (
            await connection.fetchval("SELECT version_num FROM alembic_version") == "e9c5b8d2a401"
        )
        with pytest.raises(subprocess.CalledProcessError) as refused:
            await run_alembic(isolated_postgres_url, "downgrade", "d8b2f6a4c917")
        assert "Digital service submission is forward-only" in refused.value.stderr
        assert (
            await connection.fetchval("SELECT version_num FROM alembic_version") == "e9c5b8d2a401"
        )
        async with connection.transaction():
            _, _, digest = await fixture(connection)
            with pytest.raises(asyncpg.InvalidParameterValueError):
                async with connection.transaction():
                    await submit(connection, digest, confirmed=False)
            assert (await submit(connection, digest))["created"] is True
    finally:
        await connection.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("address_length", [160, 161, 500])
async def test_full_form_address_survives_bounded_location_name_without_prefix_collision(
    pg, address_length
):
    tenant, intake, digest = await fixture(pg)
    address = "א" * (address_length - 1) + "ב"
    await role(pg, tenant, "platform_migrator")
    existing_address = address[:-1] + "ג"
    await pg.execute(
        "INSERT INTO crm.service_locations(tenant_id,customer_contact_id,name,address) "
        "SELECT tenant_id,customer_contact_id,$2,$3 FROM service.intake_drafts WHERE id=$1",
        intake,
        address[:160],
        existing_address,
    )
    await role(pg, tenant, "platform_web")
    receipt = json.loads(
        await pg.fetchval(
            "SELECT service.submit_digital_intake_form($1,'דנה',$2,'מסך לא נדלק',true,'[]')",
            digest,
            address,
        )
    )
    assert receipt["created"] is True
    await role(pg, tenant, "platform_migrator")
    location = await pg.fetchrow(
        "SELECT location.name,location.address FROM service.cases service_case "
        "JOIN crm.service_locations location ON location.tenant_id=service_case.tenant_id "
        "AND location.id=service_case.service_location_id WHERE service_case.intake_draft_id=$1",
        intake,
    )
    assert dict(location) == {"name": address[:160], "address": address}
    assert (
        await pg.fetchval("SELECT count(*) FROM crm.service_locations WHERE tenant_id=$1", tenant)
        == 2
    )
