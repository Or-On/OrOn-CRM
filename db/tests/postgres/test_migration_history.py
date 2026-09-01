from __future__ import annotations

import base64
from uuid import UUID, uuid4

import asyncpg
import pytest

from db.alembic.oron_migration_compat import LocalFieldCipher, blind_index
from db.tests.postgres.conftest import run_alembic

pytestmark = [pytest.mark.postgres, pytest.mark.integration, pytest.mark.migration]

DEFAULT_TENANT_ID = UUID("00000000-0000-0000-0000-000000000001")
FIELD_CIPHER_TEST_KEY = bytes(range(32))
BLIND_INDEX_TEST_KEY = bytes(range(1, 33))


async def test_historical_nonempty_phone_backfill_preserves_oron_semantics(
    isolated_postgres_url: str,
) -> None:
    await run_alembic(isolated_postgres_url, "upgrade", "0003")
    cipher = LocalFieldCipher(FIELD_CIPHER_TEST_KEY)
    plaintext_id = uuid4()
    untouched_id = uuid4()
    encrypted_id = uuid4()
    encrypted_from = cipher.encrypt(DEFAULT_TENANT_ID, "+14155550200")
    encrypted_to = cipher.encrypt(DEFAULT_TENANT_ID, "+14155559998")

    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        await connection.executemany(
            "INSERT INTO sessions "
            "(session_id, tenant_id, provider, direction, room, status, from_number, "
            "to_number, created_at, updated_at) "
            "VALUES ($1, $2, 'livekit', 'inbound', $3, 'started', $4, $5, now(), now())",
            [
                (
                    plaintext_id,
                    DEFAULT_TENANT_ID,
                    "phase2b-plaintext",
                    "+1 (415) 555-0100",
                    "+14155559999",
                ),
                (untouched_id, DEFAULT_TENANT_ID, "phase2b-empty", None, ""),
                (
                    encrypted_id,
                    DEFAULT_TENANT_ID,
                    "phase2b-encrypted",
                    encrypted_from,
                    encrypted_to,
                ),
            ],
        )
    finally:
        await connection.close()

    await run_alembic(
        isolated_postgres_url,
        "upgrade",
        "0004",
        extra_env={
            "FIELD_CIPHER_BACKEND": "local",
            "FIELD_CIPHER_LOCAL_KEY": base64.b64encode(FIELD_CIPHER_TEST_KEY).decode("ascii"),
            "BLIND_INDEX_KEY": base64.b64encode(BLIND_INDEX_TEST_KEY).decode("ascii"),
        },
    )

    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        plaintext = await connection.fetchrow(
            "SELECT from_number, to_number, from_number_bidx FROM sessions WHERE session_id = $1",
            plaintext_id,
        )
        untouched = await connection.fetchrow(
            "SELECT from_number, to_number, from_number_bidx FROM sessions WHERE session_id = $1",
            untouched_id,
        )
        encrypted = await connection.fetchrow(
            "SELECT from_number, to_number, from_number_bidx FROM sessions WHERE session_id = $1",
            encrypted_id,
        )
    finally:
        await connection.close()

    assert plaintext is not None
    assert cipher.decrypt(DEFAULT_TENANT_ID, plaintext["from_number"]) == "+1 (415) 555-0100"
    assert cipher.decrypt(DEFAULT_TENANT_ID, plaintext["to_number"]) == "+14155559999"
    assert plaintext["from_number_bidx"] == blind_index("+1 (415) 555-0100", BLIND_INDEX_TEST_KEY)
    assert untouched is not None
    assert tuple(untouched.values()) == (None, "", None)
    assert encrypted is not None
    assert encrypted["from_number"] == encrypted_from
    assert encrypted["to_number"] == encrypted_to
    assert encrypted["from_number_bidx"] is None


async def test_supported_target_successor_downgrade_and_reupgrade(
    isolated_postgres_url: str,
) -> None:
    await run_alembic(isolated_postgres_url, "upgrade", "head")
    await run_alembic(isolated_postgres_url, "downgrade", "a41d2f6c2925")

    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        assert not await connection.fetchval(
            "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'crm')"
        )
        assert (
            await connection.fetchval("SELECT version_num FROM alembic_version") == "a41d2f6c2925"
        )
    finally:
        await connection.close()

    await run_alembic(isolated_postgres_url, "upgrade", "head")
    connection = await asyncpg.connect(isolated_postgres_url)
    try:
        assert (
            await connection.fetchval("SELECT version_num FROM alembic_version") == "3efa5431c380"
        )
        assert await connection.fetchval(
            "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'live')"
        )
    finally:
        await connection.close()
