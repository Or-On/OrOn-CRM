from enum import StrEnum


class DbRole(StrEnum):
    """The least-privilege login roles the runtime connects as.

    Two, not one: the sessions plane holds call data under RLS and the control
    plane holds the credential tables, and neither is granted the other's. One
    definition, shared by the migration that grants them, the deploy docs, and
    the tests that prove the split.
    """

    SESSIONS = "oron_sessions_app"
    TENANCY = "oron_tenancy_app"
