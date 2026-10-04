"""The canonical tenant admission marker stays internal to persistence."""

from oron_tenancy.models import Tenant, TenantCreate, TenantPublic


def test_tenant_slug_marker_is_stored_with_safe_default_and_not_public() -> None:
    tenant = Tenant(name="Fictional tenant", slug="fictional-model")
    assert tenant.slug_guarded is True
    assert "slug_guarded" in Tenant.__table__.columns
    assert "slug_guarded" not in tenant.model_dump()
    assert "slug_guarded" not in TenantCreate.model_fields
    assert "slug_guarded" not in TenantPublic.model_fields
    assert "slug_guarded" not in TenantCreate.model_json_schema()["properties"]
    assert "slug_guarded" not in TenantPublic.model_json_schema()["properties"]
