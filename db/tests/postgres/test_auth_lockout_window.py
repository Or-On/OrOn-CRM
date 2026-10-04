"""Real PostgreSQL lockout expiry and concurrent attacker regression."""

import asyncio
import os
from uuid import uuid4

import asyncpg
import pytest

pytestmark = pytest.mark.postgres


async def test_failures_do_not_extend_active_lock_and_expiry_starts_new_window() -> None:
    url = os.environ.get("TEST_DATABASE_URL")
    if url is None:
        pytest.skip("requires disposable PostgreSQL TEST_DATABASE_URL")
    connection = await asyncpg.connect(url)
    user = uuid4()
    try:
        await connection.execute(
            "INSERT INTO users(id,email,display_name,status) "
            "VALUES($1,$2,'Fictional lock QA','active')",
            user,
            f"lock-{user}@example.invalid",
        )
        await connection.execute(
            "INSERT INTO platform.auth_credentials(user_id,password_hash) VALUES($1,'test-only')",
            user,
        )

        async def fail() -> None:
            worker = await asyncpg.connect(url)
            try:
                await worker.execute("SET ROLE platform_web")
                await worker.execute("SELECT platform.auth_record_login_failure($1)", user)
            finally:
                await worker.close()

        for _ in range(5):
            await fail()
        initial = await connection.fetchrow(
            "SELECT failed_attempts,locked_until FROM platform.auth_credentials WHERE user_id=$1",
            user,
        )
        assert initial and initial["failed_attempts"] == 5 and initial["locked_until"]
        await asyncio.gather(*(fail() for _ in range(12)))
        after = await connection.fetchrow(
            "SELECT failed_attempts,locked_until FROM platform.auth_credentials WHERE user_id=$1",
            user,
        )
        assert after == initial
        await connection.execute(
            "UPDATE platform.auth_credentials SET locked_until=now()-interval '1 second' "
            "WHERE user_id=$1",
            user,
        )
        await fail()
        reset = await connection.fetchrow(
            "SELECT failed_attempts,locked_until FROM platform.auth_credentials WHERE user_id=$1",
            user,
        )
        assert reset and reset["failed_attempts"] == 1 and reset["locked_until"] is None
    finally:
        await connection.execute("DELETE FROM users WHERE id=$1", user)
        await connection.close()
