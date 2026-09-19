"""The voice runtime runs the same lead contract fixtures as TypeScript.

packages/ts/crm/src/lead-contract.test.ts runs these cases from its own mirror.
A rule that changes in only one language fails one of the two suites.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from oron_agent.lead_capture import (
    LeadFieldValidationError,
    LeadSchemaError,
    js_number_string,
    lead_completeness,
    lead_tool_descriptors,
    normalize_lead_field,
    parse_lead_field_schema,
    to_fixed,
)
from oron_agent.lead_capture_contract import CONTRACT

CANONICAL = Path(__file__).resolve().parents[4] / "db" / "contracts" / "lead-capture.v1.json"
PARITY = CONTRACT["parity"]
SCHEMA = parse_lead_field_schema(PARITY["schema"])


def test_mirror_matches_the_canonical_contract() -> None:
    assert json.loads(CANONICAL.read_text(encoding="utf-8")) == CONTRACT


def test_every_fixture_error_is_a_declared_code() -> None:
    declared = set(CONTRACT["errorCodes"])
    assert {case["error"] for case in PARITY["normalization"] if "error" in case} <= declared


@pytest.mark.parametrize("case", PARITY["normalization"], ids=lambda case: case["name"])
def test_normalization_parity(case: dict) -> None:
    options = case.get("options", {})
    if "error" in case:
        with pytest.raises(LeadFieldValidationError) as caught:
            normalize_lead_field(
                SCHEMA, case["observation"], phone_region=options.get("phoneRegion")
            )
        assert caught.value.code == case["error"]
        return
    result = normalize_lead_field(
        SCHEMA, case["observation"], phone_region=options.get("phoneRegion")
    )
    for key, value in case["expect"].items():
        assert result[key] == value, key


@pytest.mark.parametrize("case", PARITY["completeness"], ids=lambda case: case["name"])
def test_completeness_parity(case: dict) -> None:
    assert lead_completeness(SCHEMA, case["current"]) == case["expect"]


@pytest.mark.parametrize("case", PARITY["schemas"], ids=lambda case: case["name"])
def test_schema_parity(case: dict) -> None:
    if "error" in case:
        with pytest.raises(LeadSchemaError):
            parse_lead_field_schema(case["definition"])
        return
    parsed = parse_lead_field_schema(case["definition"])
    assert [entry.key for entry in parsed.fields] == case["expectKeys"]


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (1500.0, "1500"),
        (12.5, "12.5"),
        (-0.0, "0"),
        (0.1, "0.1"),
        (0.000001, "0.000001"),
        (1e-7, "1e-7"),
        (123.456, "123.456"),
        (1e21, "1e+21"),
        (-2.5e-8, "-2.5e-8"),
    ],
)
def test_numbers_are_written_as_javascript_writes_them(value: float, expected: str) -> None:
    assert js_number_string(value) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [(0.125, "0.13"), (1.005, "1.00"), (50000.0, "50000.00"), (0.0, "0.00"), (2.675, "2.67")],
)
def test_amounts_round_as_javascript_to_fixed_does(value: float, expected: str) -> None:
    assert to_fixed(value, 2) == expected


def test_voice_advertises_the_tool_surface_whatsapp_advertises() -> None:
    descriptors = {
        descriptor.name: descriptor
        for descriptor in lead_tool_descriptors(
            ["lead.write", "lead.finalize", "lead.follow_up"], SCHEMA
        )
    }
    assert list(descriptors) == [
        "lead_read_state",
        "lead_save_fields",
        "lead_finalize_collection",
        "lead_request_follow_up",
    ]
    assert descriptors["lead_finalize_collection"].properties == {
        "summary": {
            "type": "string",
            "maxLength": 4000,
            "description": "What the customer asked for, in their own terms.",
        },
        "nextAction": {"type": "string", "maxLength": 1000},
    }
    assert descriptors["lead_finalize_collection"].required == ["summary"]
    assert descriptors["lead_request_follow_up"].required == ["note"]
    items = descriptors["lead_save_fields"].properties["observations"]["items"]
    assert items["properties"]["key"]["enum"] == [entry.key for entry in SCHEMA.fields]
    assert items["required"] == ["key", "state"]


def test_no_capability_means_no_tool() -> None:
    assert lead_tool_descriptors([], SCHEMA) == []
    assert [d.name for d in lead_tool_descriptors(["lead.read"], SCHEMA)] == ["lead_read_state"]
