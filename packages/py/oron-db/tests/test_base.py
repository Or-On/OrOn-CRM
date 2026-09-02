from oron_db import TenantScoped, Timestamped
from sqlmodel import Field


class Scoped(TenantScoped, table=True):
    __tablename__ = "scoped_widgets"
    id: int | None = Field(default=None, primary_key=True)
    name: str


class Plain(Timestamped, table=True):
    __tablename__ = "plain_widgets"
    id: int | None = Field(default=None, primary_key=True)


def test_tenant_scoped_has_timestamps_and_tenant():
    cols = set(Scoped.__table__.columns.keys())
    assert {"created_at", "updated_at", "tenant_id", "id", "name"} <= cols
    assert Scoped.__table__.c.tenant_id.index is True


def test_timestamped_only_has_timestamps():
    cols = set(Plain.__table__.columns.keys())
    assert {"created_at", "updated_at", "id"} <= cols
    assert "tenant_id" not in cols


def test_updated_at_has_onupdate():
    assert Scoped.__table__.c.updated_at.onupdate is not None
