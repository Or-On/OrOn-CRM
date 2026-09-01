"""Minimal compatibility surface for preserved historical Or-on revisions.

The historical migrations imported :class:`oron_db.DbRole` from an upstream
workspace package. Target migrations must execute without sibling repositories,
so this module preserves the exact role values needed by those revisions without
copying the Or-on runtime package or changing its SQL semantics.
"""

from enum import StrEnum


class DbRole(StrEnum):
    """Historical Or-on least-privilege database role names."""

    SESSIONS = "oron_sessions_app"
    TENANCY = "oron_tenancy_app"
