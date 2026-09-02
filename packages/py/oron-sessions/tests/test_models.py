import uuid

from oron_common import CallUsage
from oron_common.context import Direction
from oron_db import TenantScoped
from oron_sessions.models import Session, SessionBase, SessionCreate, SessionPublic


def test_session_public_now_carries_the_caller_numbers():
    """Design D4 said the API never decrypts, and this asserted it. Relaxed
    deliberately: the console has to name who was called and let an owner ring
    back, so SessionPublic carries the plaintext while the column stays
    ciphertext. The narrower guarantee is asserted in test_api.py."""
    assert "from_number" in SessionPublic.model_fields
    assert "to_number" in SessionPublic.model_fields


def test_session_create_still_carries_plaintext_caller_numbers():
    assert "from_number" in SessionCreate.model_fields
    assert "to_number" in SessionCreate.model_fields


def test_session_table_carries_caller_numbers_and_blind_index():
    assert "from_number" in Session.model_fields
    assert "to_number" in Session.model_fields
    assert "from_number_bidx" in Session.model_fields


def test_session_carries_usage_counts_not_computed_cost():
    """Rates change; usage does not. Storing a computed cost would freeze the
    rate that was current at write time and need a backfill to correct."""
    cols = set(Session.__table__.columns.keys())
    assert {
        "llm_prompt_tokens",
        "llm_completion_tokens",
        "tts_characters",
        "tts_audio_seconds",
    } <= cols
    assert not any(c.startswith("cost") for c in cols)


def test_usage_is_declared_once_by_callusage_and_only_where_it_belongs():
    """A session is created before it has consumed anything, so SessionCreate must
    not offer usage; the row and the public response both carry it, from the one
    CallUsage declaration rather than from restated twins."""
    usage = set(CallUsage.model_fields)
    assert usage.isdisjoint(SessionCreate.model_fields)
    assert usage <= set(Session.__table__.columns.keys())
    assert usage <= set(SessionPublic.model_fields)


def test_usage_defaults_to_zero_so_old_rows_are_not_null():
    s = Session(direction=Direction.INBOUND, room="r", tenant_id=uuid.uuid4())
    assert s.llm_prompt_tokens == 0
    assert s.tts_audio_seconds == 0.0


def test_the_session_bases_do_not_shadow_each_other():
    """Session is built by multiple inheritance, which makes a duplicate field
    name SILENT: one base wins by MRO and that column quietly means the wrong
    thing. Nothing else in the stack catches it — not pydantic, not ruff, not
    Alembic, whose autogenerate sees only the resolved column."""
    bases = [SessionBase, TenantScoped, CallUsage]
    declared = [name for base in bases for name in base.model_fields]

    assert len(declared) == len(set(declared))
