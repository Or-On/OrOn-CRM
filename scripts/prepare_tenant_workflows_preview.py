"""Switch only the owned fictional browser fixture's role for UI acceptance."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from uuid import UUID

import asyncpg

from scripts.preview_ui_fixtures import TENANT_ID, USER_ID, fixture_id, validate_fixture_database

ROOT = Path(__file__).resolve().parents[1]


async def main(role: str, port: int) -> None:
    fixture = json.loads((ROOT / ".artifacts/phase7-preview-login.json").read_text())
    if fixture["email"] != "demo@example.invalid":
        raise ValueError("Only the fictional preview account may be changed")
    database = fixture["database"]
    url = f"postgresql://platform_migrator@127.0.0.1:{port}/{database}"
    validate_fixture_database(url, database)
    connection = await asyncpg.connect(url, timeout=10)
    try:
        if await connection.fetchval("SELECT current_database()") != database:
            raise ValueError("The connected database is not the owned preview")
        async with connection.transaction():
            await connection.execute(
                "SELECT set_config('app.current_tenant', $1, true), "
                "set_config('app.current_user', $2, true), "
                "set_config('app.current_role', 'owner', true)",
                str(TENANT_ID),
                str(USER_ID),
            )
            await connection.execute(
                "UPDATE public.users SET is_superuser = $2 WHERE id = $1",
                USER_ID,
                role == "reviewer",
            )
            if role == "technician":
                await connection.execute(
                    "UPDATE public.memberships SET role = 'owner' "
                    "WHERE user_id = $1 AND tenant_id = $2",
                    fixture_id("member-1"),
                    TENANT_ID,
                )
            await connection.execute(
                "UPDATE public.memberships SET role = $3 WHERE user_id = $1 AND tenant_id = $2",
                USER_ID,
                TENANT_ID,
                "technician" if role == "technician" else "owner",
            )
            if role == "reviewer" and not await connection.fetchval(
                "SELECT available FROM platform.tenant_feature_entitlements "
                "WHERE tenant_id = $1 AND feature_key = 'field_service'",
                TENANT_ID,
            ):
                # Entitlement is separate from tenant package approval. A template
                # never grants a paid module; only this disposable reviewer does.
                await connection.execute(
                    "SELECT platform.set_tenant_feature_entitlement($1, true, 'fictional-preview')",
                    TENANT_ID,
                )
            if role == "technician":
                records = json.loads(
                    (ROOT / ".artifacts/tenant-workflow-preview/fixture.json").read_text()
                )
                if records["database"] != database:
                    raise ValueError("Technician fixture belongs to another database")
                await connection.execute(
                    "UPDATE service.technicians SET linked_user_id = $1, "
                    "identity_verification = 'verified' WHERE id = $2 AND tenant_id = $3",
                    USER_ID,
                    UUID(records["technicianId"]),
                    TENANT_ID,
                )
        print(f"Fictional preview role set to {role}; no real tenant data modified.")
    finally:
        await connection.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("role", choices=("owner", "reviewer", "technician"))
    parser.add_argument("--port", type=int, default=5456)
    args = parser.parse_args()
    asyncio.run(main(args.role, args.port))
