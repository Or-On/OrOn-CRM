"""Safety properties for the retired demo-data cleanup command."""

import inspect
from uuid import UUID

import pytest

from scripts.clean_development_demo_data import (
    DEMO_VOICE_FLOW,
    DEMO_VOICE_FLOW_SOURCE_FINGERPRINT,
    DEMO_VOICE_FLOW_SPEC_FINGERPRINT,
    DEMO_VOICE_FLOW_VERSION,
    DEVELOPMENT_DATABASE_NAME,
    PRIMARY_PRODUCT_IDENTITY,
    PRIMARY_SEED_IDENTITY,
    TEST_TENANT_TABLES,
    _discover_primary_voice_artifacts,
    _discover_simulator_dependents,
    _discover_test_tenants,
    _exact_rows_target,
    _merge_fixture_rows,
    _primary_workspace_normalization,
    _reference_probe,
    _validated_key_rows,
    cleanup_targets,
    guarded_database_url,
    known_fixture_rows,
    parse_args,
    refuse_fixture_references,
    refuse_unknown_demo_data,
)


def test_cleanup_is_a_dry_run_unless_apply_is_explicit() -> None:
    assert parse_args([]).apply is False
    assert parse_args(["--apply"]).apply is True


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "[::1]"])
def test_cleanup_accepts_only_the_exact_local_development_database(host: str) -> None:
    value = f"postgresql://fixture:secret@{host}:5433/{DEVELOPMENT_DATABASE_NAME}"
    assert guarded_database_url(value).startswith("postgresql+asyncpg://")


@pytest.mark.parametrize(
    "value",
    [
        None,
        "sqlite:///or_on_platform_dev",
        "postgresql://database.example.com/or_on_platform_dev",
        "postgresql://localhost/postgres",
        "postgresql://localhost/or_on_platform_dev_backup",
    ],
)
def test_cleanup_refuses_unowned_database_destinations(value: str | None) -> None:
    with pytest.raises(RuntimeError):
        guarded_database_url(value)


def test_deletion_plan_names_every_row_by_deterministic_fixture_identity() -> None:
    targets = cleanup_targets()
    labels = {target.label for target in targets}
    assert {
        "demo_channel",
        "demo_contact",
        "demo_pipeline",
        "demo_tags",
        "secondary_demo_auth_audit",
        "secondary_demo_tenant",
    } <= labels
    rendered = "\n".join(target.delete_sql.lower() for target in targets)
    assert "provider = 'simulator'" not in rendered
    assert (
        "delete from messaging.channels where tenant_id = :tenant_id and id = :record_id"
        in rendered
    )
    assert all(" where " in target.delete_sql.lower() for target in targets)


def test_dynamic_targets_bind_each_exact_key_without_broad_provider_deletion() -> None:
    rows = (
        {
            "tenant_id": UUID("10000000-0000-4000-8000-000000000001"),
            "id": UUID("50000000-0000-4000-8000-000000000010"),
        },
        {
            "tenant_id": UUID("10000000-0000-4000-8000-000000000001"),
            "id": UUID("50000000-0000-4000-8000-000000000011"),
        },
    )
    target = _exact_rows_target("safe_rows", "messaging.messages", rows)

    assert '"tenant_id" = :row_0_0' in target.delete_sql
    assert '"id" = :row_1_1' in target.delete_sql
    assert "provider" not in target.delete_sql
    assert set(target.parameters.values()) == {row["tenant_id"] for row in rows} | {
        row["id"] for row in rows
    }


def test_fixture_maps_merge_dynamic_children_without_duplicates() -> None:
    row = {
        "tenant_id": UUID("10000000-0000-4000-8000-000000000001"),
        "id": UUID("50000000-0000-4000-8000-000000000010"),
    }
    merged = _merge_fixture_rows(
        {("messaging", "messages"): (row,)},
        {("messaging", "messages"): (row,)},
    )
    assert merged[("messaging", "messages")] == (row,)


class _MappingsResult:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self._rows = rows

    def mappings(self) -> _MappingsResult:
        return self

    def __iter__(self):
        return iter(self._rows)

    def one_or_none(self) -> dict[str, object] | None:
        assert len(self._rows) <= 1
        return self._rows[0] if self._rows else None


class _FakeConnection:
    def __init__(self, rows: list[dict[str, object]]) -> None:
        self._rows = rows

    async def execute(self, *_args, **_kwargs) -> _MappingsResult:
        return _MappingsResult(self._rows)


class _SequentialFakeConnection:
    def __init__(self, rows: list[list[dict[str, object]]]) -> None:
        self._rows = list(rows)
        self.statements: list[str] = []
        self.parameters: list[dict[str, object]] = []

    async def execute(self, statement, parameters) -> _MappingsResult:
        self.statements.append(str(statement))
        self.parameters.append(parameters)
        return _MappingsResult(self._rows.pop(0))


@pytest.mark.asyncio
async def test_validated_rows_strip_classifier_and_keep_only_safe_identifiers() -> None:
    identifier = UUID("50000000-0000-4000-8000-000000000010")
    rows = await _validated_key_rows(
        _FakeConnection([{"id": identifier, "safe": True}]),  # type: ignore[arg-type]
        label="fixture",
        statement="SELECT 1",
        parameters={},
    )
    assert rows == ({"id": identifier},)


@pytest.mark.asyncio
async def test_validated_rows_refuse_one_unmarked_provider_row() -> None:
    with pytest.raises(RuntimeError, match="without exact test/simulator markers"):
        await _validated_key_rows(
            _FakeConnection([{"id": UUID(int=1), "safe": False}]),  # type: ignore[arg-type]
            label="fixture",
            statement="SELECT 1",
            parameters={},
        )


@pytest.mark.asyncio
async def test_primary_voice_artifacts_use_strict_classifiers_and_exact_child_first_keys() -> None:
    tenant_id = UUID("10000000-0000-4000-8000-000000000001")
    job_id = UUID("a8e0f0b7-a6c3-47aa-95a2-473bd97b474b")
    job_audit_id = UUID("0d14ec53-ec4d-4809-be71-cd299208fa37")
    flow_audit_id = UUID("4221dec2-f96c-4386-b576-ef547890aae1")
    connection = _SequentialFakeConnection(
        [
            [{"id": job_id, "tenant_id": tenant_id, "safe": True}],
            [{"id": job_audit_id, "tenant_id": tenant_id, "safe": True}],
            [
                {
                    "id": DEMO_VOICE_FLOW,
                    "flow_id": DEMO_VOICE_FLOW,
                    "version": DEMO_VOICE_FLOW_VERSION,
                    "tenant_id": tenant_id,
                    "safe": True,
                }
            ],
            [{"id": flow_audit_id, "tenant_id": tenant_id, "safe": True}],
        ]
    )

    cleanup = await _discover_primary_voice_artifacts(connection)  # type: ignore[arg-type]

    assert [target.label for target in cleanup.targets] == [
        "primary_voice_simulator_job_audit",
        "primary_voice_simulator_jobs",
        "fictional_welcome_flow_audit",
        "fictional_welcome_flow",
    ]
    assert cleanup.rows[("ops", "jobs")] == ({"id": job_id, "tenant_id": tenant_id},)
    assert cleanup.rows[("audit", "records")] == (
        {"id": job_audit_id, "tenant_id": tenant_id},
        {"id": flow_audit_id, "tenant_id": tenant_id},
    )
    assert (
        cleanup.targets[1].delete_sql
    ) == 'DELETE FROM ops.jobs WHERE ("tenant_id" = :row_0_0 AND "id" = :row_0_1)'
    assert '"flow_id" = :row_0_1' in cleanup.targets[3].delete_sql
    assert '"version" = :row_0_2' in cleanup.targets[3].delete_sql

    rendered = "\n".join(connection.statements)
    assert "job.payload = jsonb_build_object" in rendered
    assert "job.status = 'succeeded'" in rendered
    assert "job.locked_at IS NULL" in rendered
    assert "record.metadata = jsonb_build_object" in rendered
    assert "md5(flow.source::text) = :source_fingerprint" in rendered
    assert "md5(flow.spec::text) = :spec_fingerprint" in rendered
    assert connection.parameters[0]["source_fingerprint"] == (DEMO_VOICE_FLOW_SOURCE_FINGERPRINT)
    assert connection.parameters[0]["spec_fingerprint"] == DEMO_VOICE_FLOW_SPEC_FINGERPRINT


@pytest.mark.asyncio
async def test_primary_voice_artifact_discovery_refuses_a_modified_simulator_job() -> None:
    connection = _SequentialFakeConnection(
        [[{"id": UUID(int=1), "tenant_id": UUID(int=2), "safe": False}]]
    )

    with pytest.raises(RuntimeError, match="completed voice simulator jobs"):
        await _discover_primary_voice_artifacts(connection)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_primary_voice_artifact_discovery_refuses_a_modified_flow() -> None:
    connection = _SequentialFakeConnection(
        [
            [],
            [],
            [
                {
                    "id": DEMO_VOICE_FLOW,
                    "flow_id": DEMO_VOICE_FLOW,
                    "version": DEMO_VOICE_FLOW_VERSION,
                    "tenant_id": UUID("10000000-0000-4000-8000-000000000001"),
                    "safe": False,
                }
            ],
        ]
    )

    with pytest.raises(RuntimeError, match="Fictional welcome voice flow"):
        await _discover_primary_voice_artifacts(connection)  # type: ignore[arg-type]


def test_simulator_discovery_requires_source_markers_and_rejects_meta_ids() -> None:
    source = inspect.getsource(_discover_simulator_dependents)
    assert "provider = 'simulator'" in source
    assert "provider_template_id IS NULL" in source
    assert "provider_payload->>'source' = 'whatsapp_simulator'" in source
    assert "provider_payload->>'simulator' = 'true'" in source
    assert "!~* '(wamid|meta)'" in source
    assert "credential" not in source


def test_recognized_test_tenants_have_a_minimal_explicit_table_allowlist() -> None:
    assert TEST_TENANT_TABLES["Default"] == frozenset()
    assert TEST_TENANT_TABLES["Other API tenant"] == frozenset()
    assert TEST_TENANT_TABLES["Phase 4 API"] == frozenset(
        {("public", "api_keys"), ("public", "memberships")}
    )
    source = inspect.getsource(_discover_test_tenants)
    assert "@example.test" in source
    assert "configuration.credential_id IS NULL" in source
    assert "NOT configuration.is_enabled" in source
    assert "configuration.settings = '{}'::jsonb" in source
    assert source.index('"recognized_test_tenants"') < source.index(
        "targets.extend(membership_targets)"
    )


@pytest.mark.asyncio
async def test_primary_workspace_normalization_only_updates_untouched_seed_identity() -> None:
    target = await _primary_workspace_normalization(
        _FakeConnection(  # type: ignore[arg-type]
            [{"name": PRIMARY_SEED_IDENTITY[0], "slug": PRIMARY_SEED_IDENTITY[1]}]
        )
    )
    assert target.operation == "update"
    assert target.parameters["new_name"] == PRIMARY_PRODUCT_IDENTITY[0]
    assert target.parameters["new_slug"] == PRIMARY_PRODUCT_IDENTITY[1]
    assert "name = :old_name" in target.delete_sql


@pytest.mark.asyncio
async def test_primary_workspace_normalization_refuses_custom_identity() -> None:
    with pytest.raises(RuntimeError, match="was customized"):
        await _primary_workspace_normalization(
            _FakeConnection([{"name": "Customer name", "slug": "customer-slug"}])  # type: ignore[arg-type]
        )


def test_cleanup_refuses_unknown_rows_in_the_secondary_demo_tenant() -> None:
    with pytest.raises(RuntimeError, match="unknown tenant-owned data"):
        refuse_unknown_demo_data({"messaging.conversations": 1})


def test_cleanup_refuses_non_fixture_children_of_fixture_entities() -> None:
    with pytest.raises(RuntimeError, match="referenced by non-fixture data"):
        refuse_fixture_references({"voice.calls via calls_contact_id_fkey": 1})


def test_reference_probe_excludes_only_exact_known_fixture_children() -> None:
    statement, parameters = _reference_probe(
        child=("messaging", "conversations"),
        child_columns=("contact_id",),
        parent_columns=("id",),
        parent_row={
            "id": UUID("30000000-0000-4000-8000-000000000001"),
            "tenant_id": UUID("10000000-0000-4000-8000-000000000001"),
        },
        constraint_name="conversations_contact_id_fkey",
    )

    assert 'FROM "messaging"."conversations"' in statement
    assert '"contact_id" = :reference_0' in statement
    assert "AND NOT" in statement
    assert parameters["reference_0"] == UUID("30000000-0000-4000-8000-000000000001")
    assert UUID("51000000-0000-4000-8000-000000000001") in parameters.values()


def test_reference_probe_treats_an_unknown_child_table_as_protected_data() -> None:
    statement, _ = _reference_probe(
        child=("voice", "calls"),
        child_columns=("contact_id",),
        parent_columns=("id",),
        parent_row={"id": UUID("30000000-0000-4000-8000-000000000001")},
        constraint_name="calls_contact_id_fkey",
    )

    assert "AND NOT" not in statement


def test_reference_probe_supports_composite_pipeline_stage_foreign_keys() -> None:
    stage = known_fixture_rows()[("crm", "pipeline_stages")][0]
    statement, parameters = _reference_probe(
        child=("crm", "deals"),
        child_columns=("pipeline_id", "stage_id"),
        parent_columns=("pipeline_id", "id"),
        parent_row=stage,
        constraint_name="deals_tenant_pipeline_stage_fkey",
    )

    assert '"pipeline_id" = :reference_0' in statement
    assert '"stage_id" = :reference_1' in statement
    assert parameters["reference_0"] == UUID("40000000-0000-4000-8000-000000000001")
    assert parameters["reference_1"] == UUID("41000000-0000-4000-8000-000000000001")


def test_reference_probe_refuses_an_unverifiable_parent_key() -> None:
    with pytest.raises(RuntimeError, match="cannot safely inspect"):
        _reference_probe(
            child=("automation", "runs"),
            child_columns=("flow_slug",),
            parent_columns=("slug",),
            parent_row={"id": UUID("30000000-0000-4000-8000-000000000001")},
            constraint_name="runs_flow_slug_fkey",
        )
