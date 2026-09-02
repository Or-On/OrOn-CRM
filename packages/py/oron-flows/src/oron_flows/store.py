"""FlowStore — pluggable flow-definition backend, mirroring oron-agent's
ArtifactStore seam (a Protocol + backends + a build_* DI factory).

`publish` expands a Composition and stores the built FlowSpec **pinned to a
component-library version**; `load` returns that frozen spec. So a fix to a shared
component reaches a tenant only when their flow is deliberately republished —
with a reviewable diff — never mid-call.

JSON, not YAML: this is the shape the `flows` table's JSONB columns hold.
"""

import json
import uuid
from enum import StrEnum
from pathlib import Path
from typing import Protocol

from pydantic import BaseModel

from oron_flows.components import SPEC_VERSION
from oron_flows.compose import Composition, expand
from oron_flows.graph import FlowSpec

# The catalog this build ships, owned by no tenant and runnable by all. A real
# tenant id is a UUID, so this can never collide with one.
GLOBAL_TENANT = "_global"


class PublishedFlow(BaseModel):
    """What a store holds for one version: the short authored source, the built
    graph, and the component-library version that built it."""

    source: Composition
    spec: FlowSpec
    components_version: str


class FlowListing(BaseModel):
    """One flow as a picker row. `latest_version` is what a call would run, so
    the list and the answer path agree on which version "current" means."""

    flow_id: uuid.UUID
    name: str
    language: str
    latest_version: int
    packaged: bool
    """Belongs to the catalog this build ships, so it cannot be published over —
    the editor offers to duplicate it instead of saving."""


class FlowStore(Protocol):
    """Where flow definitions live. tenant_id is a required first parameter on
    every method — no unscoped query path."""

    async def load(self, tenant_id: str, flow_id: uuid.UUID, version: int) -> FlowSpec: ...

    async def load_latest(self, tenant_id: str, flow_id: uuid.UUID) -> FlowSpec:
        """The highest published version. What a call actually runs: a DID binds
        a flow_id and never a version, so resolving "current" must not cost a
        list-then-load round trip on the answer path."""
        ...

    async def publish(self, tenant_id: str, composition: Composition) -> int:
        """Expand, freeze and store. The version is the composition's own;
        backends MUST NOT auto-allocate or mutate an existing version."""
        ...

    async def list_versions(self, tenant_id: str, flow_id: uuid.UUID) -> list[int]: ...

    async def list_flows(self, tenant_id: str) -> list[FlowListing]:
        """Every flow this tenant may open, newest version each."""
        ...

    async def load_source(
        self, tenant_id: str, flow_id: uuid.UUID, version: int | None = None
    ) -> Composition:
        """The authored composition, for an editor to reopen. `None` means latest.

        Deliberately not derived from the stored spec: expansion is one-way, and
        the source is the only thing a human wrote.
        """
        ...


class FileFlowStore:
    """Dev/test backend: one flow, one JSON file. tenant_id/flow_id/version are
    accepted for Protocol conformance but do not select the file, which is what
    lets the bot and its tests run with no DB."""

    def __init__(self, path: str | Path):
        self._path = Path(path)

    def _read(self) -> PublishedFlow:
        return PublishedFlow(**json.loads(self._path.read_text(encoding="utf-8")))

    async def load(self, tenant_id: str, flow_id: uuid.UUID, version: int) -> FlowSpec:
        return self._read().spec

    async def load_latest(self, tenant_id: str, flow_id: uuid.UUID) -> FlowSpec:
        return self._read().spec

    async def publish(self, tenant_id: str, composition: Composition) -> int:
        published = PublishedFlow(
            source=composition, spec=expand(composition), components_version=SPEC_VERSION
        )
        self._path.write_text(
            json.dumps(published.model_dump(mode="json"), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return composition.flow.version

    async def list_versions(self, tenant_id: str, flow_id: uuid.UUID) -> list[int]:
        return [self._read().source.flow.version]

    async def list_flows(self, tenant_id: str) -> list[FlowListing]:
        flow = self._read().source.flow
        return [
            FlowListing(
                flow_id=flow.id,
                name=flow.name or str(flow.id),
                language=flow.language,
                latest_version=flow.version,
                packaged=False,
            )
        ]

    async def load_source(
        self, tenant_id: str, flow_id: uuid.UUID, version: int | None = None
    ) -> Composition:
        return self._read().source


class FlowStoreBackend(StrEnum):
    FILE = "file"
    POSTGRES = "postgres"


def build_flow_store(backend: FlowStoreBackend, *, file_path: str) -> FlowStore:
    """Construct the configured store. Called once at the edge and injected —
    nothing downstream reads settings for itself.

    POSTGRES is deliberately absent: it needs a sessionmaker, and this package
    stays free of oron-db so the flow authoring tools can import it without a
    database. `oron_tenancy.flow_store.PostgresFlowStore` builds that one.
    """
    if backend is FlowStoreBackend.FILE:
        return FileFlowStore(file_path)
    raise ValueError(f"{backend!r} is not built here — see PostgresFlowStore in oron-tenancy")
