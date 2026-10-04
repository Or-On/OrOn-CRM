"""Apply revised migration grants only to this task's disposable database."""

import asyncio
import os
from urllib.parse import urlsplit

import asyncpg


async def main():
    url = os.environ["TEST_DATABASE_URL"].replace("postgresql+asyncpg://", "postgresql://")
    target = urlsplit(url)
    if target.hostname != "127.0.0.1" or target.port != 55480:
        raise RuntimeError("refusing non-task PostgreSQL server")
    if target.path not in {"/oron_task3_test", "/oron_ui_preview_7c8a460108b3437ea6e7f1a2ded00003"}:
        raise RuntimeError("refusing non-task test database")
    connection = await asyncpg.connect(url)
    try:
        async with connection.transaction():
            await connection.execute(
                "REVOKE EXECUTE ON FUNCTION ops.claim_jobs(text,text,integer,integer) "
                "FROM platform_messaging"
            )
            await connection.execute(
                "REVOKE EXECUTE ON FUNCTION ops.fail_job(uuid,text,text,integer) "
                "FROM platform_messaging"
            )
        print("Owned test database legacy messaging grants revoked")
    finally:
        await connection.close()


asyncio.run(main())
