from or_on_platform.logging import redact_sensitive


def test_redacts_nested_sensitive_values() -> None:
    assert redact_sensitive(
        {
            "request_id": "request-1",
            "tenant_id": "tenant-safe",
            "nested": {"access_token": "never-print", "value": "visible"},
        }
    ) == {
        "request_id": "request-1",
        "tenant_id": "tenant-safe",
        "nested": {"access_token": "[REDACTED]", "value": "visible"},
    }
