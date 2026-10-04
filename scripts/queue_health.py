"""Read-only queue health snapshot; scheduling and alert delivery are operator-owned.

Uses an explicitly provisioned monitoring DSN, never the application or migration
credential as a fallback. Output contains counts/ages only, not job payloads or IDs.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

import asyncpg

QUERY = """
SELECT count(*) FILTER (WHERE status IN ('queued','retry') AND available_at<=clock_timestamp()) due,
       COALESCE(max(EXTRACT(EPOCH FROM clock_timestamp()-available_at))
         FILTER (WHERE status IN ('queued','retry') AND available_at<=clock_timestamp()),0)::float8
         oldest_due_seconds,
       count(*) FILTER (WHERE status='dead') dead,
       count(*) FILTER (WHERE status='running' AND
         COALESCE(lease_expires_at,locked_at+interval '5 minutes')<clock_timestamp())
         expired_running
FROM ops.jobs
"""


async def snapshot(connection: asyncpg.Connection) -> dict[str, int | float]:
    async with connection.transaction(readonly=True):
        await connection.execute("SET LOCAL statement_timeout='5s'")
        row = await connection.fetchrow(QUERY)
        if row is None:
            raise RuntimeError("queue snapshot unavailable")
        return {key: row[key] for key in ("due", "oldest_due_seconds", "dead", "expired_running")}


async def main() -> int:
    dsn = os.environ.get("QUEUE_MONITOR_DATABASE_URL")
    if not dsn:
        print('{"status":"blocked","reason":"monitoring_credential_missing"}')
        return 2
    connection = None
    try:
        connection = await asyncpg.connect(dsn, timeout=5)
        result = await snapshot(connection)
        print(json.dumps({"status": "observed", **result}, separators=(",", ":")))
        # The fixed two-minute customer reply gate is the document's acceptance
        # window, not a claim that queued age measures end-to-end reply latency.
        return int(
            result["oldest_due_seconds"] >= 120
            or result["dead"] > 0
            or result["expired_running"] > 0
        )
    except Exception as error:
        # Exception messages/DSNs may contain secrets and must never be emitted.
        print(json.dumps({"status": "unavailable", "error_type": type(error).__name__}))
        return 2
    finally:
        if connection is not None:
            await connection.close(timeout=5)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
