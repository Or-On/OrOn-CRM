"""Path arguments are typed and URL-encoded by the sole client generator."""

from typing import Any

import pytest

from scripts.generate_openapi import generate_client


def document(*, declare: bool = True) -> dict[str, Any]:
    operation: dict[str, Any] = {
        "operationId": "get_voice_session_control",
        "responses": {
            "200": {
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/VoiceControlState"}
                    }
                }
            }
        },
    }
    if declare:
        operation["parameters"] = [
            {
                "in": "path",
                "name": "session_id",
                "required": True,
                "schema": {"type": "string", "format": "uuid"},
            }
        ]
    return {"paths": {"/voice/{session_id}/control": {"get": operation}}}


def test_get_path_parameters_are_required_and_encoded():
    generated = generate_client(document())
    assert "parameters: { readonly session_id: string }" in generated
    assert "${encodeURIComponent(String(parameters.session_id))}" in generated
    assert '"/voice/{session_id}/control"' not in generated


def test_post_keeps_path_and_body_independent():
    schema = document()
    path = schema["paths"]["/voice/{session_id}/control"]
    operation = path.pop("get")
    operation["operationId"] = "set_voice_session_control"
    operation["requestBody"] = {
        "content": {
            "application/json": {"schema": {"$ref": "#/components/schemas/VoiceControlCommand"}}
        }
    }
    path["post"] = operation
    generated = generate_client(schema)
    assert "parameters: { readonly session_id: string }, body: VoiceControlCommand" in generated
    assert 'method: "POST"' in generated
    assert "body: JSON.stringify(body)" in generated


def test_undeclared_path_placeholder_fails_generation():
    with pytest.raises(ValueError, match="declared parameter"):
        generate_client(document(declare=False))
