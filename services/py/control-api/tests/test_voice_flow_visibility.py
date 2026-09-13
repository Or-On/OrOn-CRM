"""Control-plane flow selection is tenant-owned and has no NULL fallback."""

import uuid

from control_api.voice import _tenant_flow_owner_clause
from sqlalchemy.dialects import postgresql


def test_control_api_flow_predicate_excludes_null_tenant_rows() -> None:
    tenant_id = uuid.uuid4()
    compiled = _tenant_flow_owner_clause(tenant_id).compile(dialect=postgresql.dialect())

    assert "IS NULL" not in str(compiled)
    assert tenant_id in compiled.params.values()
