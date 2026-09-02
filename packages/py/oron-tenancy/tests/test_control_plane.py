from oron_tenancy.models import (
    ApiKey,
    PhoneNumber,
    Tenant,
    TenantCreate,
)


def test_tables_have_timestamps_and_expected_columns():
    assert {"id", "name", "slug", "status", "created_at", "updated_at"} <= set(
        Tenant.__table__.columns.keys()
    )
    assert {"id", "e164", "tenant_id", "dispatch_rule_id"} <= set(
        PhoneNumber.__table__.columns.keys()
    )
    assert {"id", "hashed_key", "tenant_id", "kind", "status"} <= set(
        ApiKey.__table__.columns.keys()
    )


def test_tenant_create_is_input_only():
    tc = TenantCreate(name="Acme", slug="acme")
    assert tc.model_dump().keys() == {"name", "slug"}
