"""The shape of the account tables, and the one comparison that must never be used."""

import sqlalchemy as sa
from oron_tenancy.models import IdentityBinding, Membership, Role, User, UserStatus

TABLES = (User, Membership)


def test_role_rank_is_declaration_order():
    assert Role.OWNER.at_least(Role.ADMIN)
    assert Role.ADMIN.at_least(Role.AGENT)
    assert Role.OWNER.at_least(Role.VIEWER)


def test_viewer_does_not_pass_an_admin_gate():
    """Authorization uses declaration rank rather than lexical string order."""
    assert not Role.VIEWER.at_least(Role.AGENT)
    assert not Role.VIEWER.at_least(Role.ADMIN)
    assert not Role.VIEWER.at_least(Role.OWNER)
    assert not Role.ADMIN.at_least(Role.OWNER)


def test_tables_have_expected_columns():
    assert {
        "id",
        "email",
        "display_name",
        "is_superuser",
        "status",
        "created_at",
        "updated_at",
    } <= set(User.__table__.columns.keys())
    assert {"user_id", "tenant_id", "role"} <= set(Membership.__table__.columns.keys())
    assert {
        "id",
        "user_id",
        "provider",
        "provider_subject",
        "provider_email",
        "created_at",
    } <= set(IdentityBinding.__table__.columns.keys())


def test_membership_is_keyed_on_the_pair():
    assert {c.name for c in Membership.__table__.primary_key.columns} == {
        "user_id",
        "tenant_id",
    }


def test_identity_binding_is_provider_neutral_and_subject_unique():
    assert IdentityBinding.__table__.schema == "platform"
    assert {c.name for c in IdentityBinding.__table__.primary_key.columns} == {"id"}
    uniques = {
        tuple(column.name for column in constraint.columns)
        for constraint in IdentityBinding.__table__.constraints
        if isinstance(constraint, sa.UniqueConstraint)
    }
    assert ("provider", "provider_subject") in uniques


def test_user_has_no_password_column():
    """Canonical credential material is owned by ``platform.auth_credentials``."""
    assert not [column for column in User.__table__.columns if "password" in column.name]


def test_users_are_not_tenant_scoped():
    """A user exists across tenants — `memberships` is what scopes them. A
    tenant_id column here would also drag `users` into the RLS trust-base test's
    forced-RLS requirement, and it must be readable before a tenant is chosen."""
    assert "tenant_id" not in User.__table__.columns


def test_only_optional_profile_fields_are_nullable():
    """Profile images may be absent; identity and membership keys may not."""
    nullable = [
        f"{t.__tablename__}.{c.name}" for t in TABLES for c in t.__table__.columns if c.nullable
    ]
    assert nullable == [
        "users.display_name",
        "users.avatar_data",
        "users.avatar_content_type",
        "users.avatar_updated_at",
    ]


def test_profile_image_columns_match_the_existing_migration():
    columns = User.__table__.columns
    assert isinstance(columns["avatar_data"].type, sa.LargeBinary)
    assert isinstance(columns["avatar_content_type"].type, sa.Text)
    assert isinstance(columns["avatar_updated_at"].type, sa.DateTime)
    assert columns["avatar_updated_at"].type.timezone is True
    user = User(email="fictional@example.invalid")
    assert user.avatar_data is None
    assert user.avatar_content_type is None
    assert user.avatar_updated_at is None


def test_enums_are_stored_as_text():
    """Not a native Postgres ENUM: adding a role would then need ALTER TYPE in a
    migration rather than a line of Python, and the migration writes plain text."""
    assert isinstance(User.__table__.columns["status"].type, sa.String)
    assert isinstance(Membership.__table__.columns["role"].type, sa.String)


def test_user_status_values():
    assert {s.value for s in UserStatus} == {"active", "disabled"}
