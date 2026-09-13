"""Narrow persistence contract used by an in-process dispatcher/agent runtime."""

from __future__ import annotations

from typing import Protocol
from uuid import UUID

from oron_common import CallContext, CallUsage
from oron_flows import FlowSpec
from oron_sessions import SessionStatus


class RuntimeSessions(Protocol):
    async def create(self, ctx: CallContext, *, room: str) -> UUID | None: ...

    async def checkpoint_usage(
        self,
        session_id: UUID,
        *,
        tenant_id: UUID,
        usage: CallUsage,
    ) -> bool: ...

    async def finalize(
        self,
        session_id: UUID,
        *,
        status: SessionStatus,
        answered: bool | None = None,
        outcome: str | None = None,
        recording_uri: str | None = None,
        transcript_uri: str | None = None,
        tenant_id: UUID | None = None,
        usage: CallUsage | None = None,
    ) -> bool: ...

    async def get_flow(self, flow_id: UUID, *, tenant_id: UUID) -> FlowSpec | None: ...

    async def aclose(self) -> None: ...
