"""backfill caller-number field encryption: add from_number_bidx, encrypt existing rows

Revision ID: 0003
Revises: 0002
Create Date: 2026-07-22
"""

import base64

import sqlalchemy as sa

from alembic import context, op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

_SELECT_ROWS_NEEDING_BACKFILL = sa.text(
    "SELECT session_id, tenant_id, from_number, to_number, from_number_bidx "
    "FROM sessions "
    "WHERE (from_number IS NOT NULL AND from_number != '' AND from_number NOT LIKE 'v1:%') "
    "OR (to_number IS NOT NULL AND to_number != '' AND to_number NOT LIKE 'v1:%')"
)

_UPDATE_ROW = sa.text(
    "UPDATE sessions SET from_number = :from_ct, to_number = :to_ct, "
    "from_number_bidx = :bidx WHERE session_id = :id"
)


def _needs_encryption(value: str | None) -> bool:
    # Skip None/empty (never call encrypt/blind_index on them — same rule as
    # the write path in crud.create_session) and skip anything already
    # ciphertext (idempotency: a re-run must never double-encrypt).
    return bool(value) and not value.startswith("v1:")


def _backfill_rows(conn, rows, cipher, blind_key) -> None:
    """Encrypt whatever each row still needs, updating only what changed.

    Each row may need only `from_number`, only `to_number`, both, or (having
    been selected for one column) already hold ciphertext + a real bidx for
    the other — a mixed row's already-set `from_number_bidx` must never be
    clobbered back to NULL just because this run only touched `to_number`.
    """
    from oron_sessions.crypto import blind_index

    for row in rows:
        from_ct = (
            cipher.encrypt(row.tenant_id, row.from_number)
            if _needs_encryption(row.from_number)
            else row.from_number
        )
        to_ct = (
            cipher.encrypt(row.tenant_id, row.to_number)
            if _needs_encryption(row.to_number)
            else row.to_number
        )
        bidx = (
            blind_index(row.from_number, blind_key)
            if _needs_encryption(row.from_number)
            else row.from_number_bidx
        )
        conn.execute(
            _UPDATE_ROW,
            {"from_ct": from_ct, "to_ct": to_ct, "bidx": bidx, "id": row.session_id},
        )


def upgrade() -> None:
    op.add_column("sessions", sa.Column("from_number_bidx", sa.String(), nullable=True))
    op.create_index("ix_sessions_from_number_bidx", "sessions", ["from_number_bidx"])

    # Encrypt any plaintext from_number/to_number left from before this
    # migration (design D3: backfill, don't leave history in plaintext). Runs
    # once, as the owner role — the app role (oron_app) never needs superuser
    # rights for this. Idempotent: a row already holding "v1:..." ciphertext is
    # skipped, so a re-run (e.g. after a partial failure) only touches what's
    # still plaintext.
    #
    # The schema change above always applies, even on an empty table (or a
    # backend/key that isn't configured for a no-op backfill) — the cipher is
    # only built below, guarded on there being rows to encrypt.
    #
    # The locked source migration predates target-wide deterministic offline
    # SQL generation. Alembic's offline connection cannot return rows, so emit
    # the schema portion above and defer this data backfill to live execution.
    # Online behavior and ordering remain identical to the source revision.
    if context.is_offline_mode():
        return

    conn = op.get_bind()
    rows = conn.execute(_SELECT_ROWS_NEEDING_BACKFILL).fetchall()
    if not rows:
        return

    from oron_sessions.config import load_settings
    from oron_sessions.crypto import build_field_cipher

    settings = load_settings()
    local_key = (
        base64.b64decode(settings.field_cipher_local_key)
        if settings.field_cipher_local_key
        else None
    )
    cipher = build_field_cipher(
        settings.field_cipher_backend,
        local_key=local_key,
        kms_key_name=settings.kms_key_name,
        kms_wrapped_dek=(
            base64.b64decode(settings.kms_wrapped_dek) if settings.kms_wrapped_dek else None
        ),
    )
    blind_key = base64.b64decode(settings.blind_index_key) if settings.blind_index_key else None
    if blind_key is None:
        raise RuntimeError(
            "BLIND_INDEX_KEY (or SECRET__BLIND_INDEX_KEY) must be set before running this "
            "migration — without it, backfilled rows would get no from_number_bidx."
        )

    _backfill_rows(conn, rows, cipher, blind_key)


def downgrade() -> None:
    op.drop_index("ix_sessions_from_number_bidx", "sessions")
    op.drop_column("sessions", "from_number_bidx")
    # Ciphertext is not reversed on downgrade — the plaintext numbers this
    # migration encrypted are gone from the row for good. A genuine rollback
    # that needs plaintext back has to restore from a pre-migration backup.
