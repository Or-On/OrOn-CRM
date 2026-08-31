"""Structured JSON logging with recursive sensitive-value redaction."""

from __future__ import annotations

import json
import logging
import re
import sys
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

_SENSITIVE_KEY = re.compile(
    r"authorization|cookie|credential|database.?url|key|password|secret|token", re.IGNORECASE
)


def redact_sensitive(value: object) -> object:
    """Recursively redact known secret-shaped keys without hiding correlation IDs."""

    if isinstance(value, Mapping):
        return {
            str(key): "[REDACTED]" if _SENSITIVE_KEY.search(str(key)) else redact_sensitive(item)
            for key, item in value.items()
        }
    if isinstance(value, list | tuple):
        return [redact_sensitive(item) for item in value]
    return value


class JsonFormatter(logging.Formatter):
    """Emit the platform's stable structured-log envelope."""

    def __init__(self, *, service: str, environment: str) -> None:
        super().__init__()
        self._service = service
        self._environment = environment

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(UTC).isoformat(),
            "level": record.levelname.lower(),
            "service": self._service,
            "environment": self._environment,
            "request_id": getattr(record, "request_id", None),
            "trace_id": getattr(record, "trace_id", None),
            "tenant_id": getattr(record, "tenant_id", None),
            "message": record.getMessage(),
        }
        fields = getattr(record, "fields", None)
        if isinstance(fields, Mapping):
            payload["fields"] = redact_sensitive(fields)
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def configure_logging(*, service: str, environment: str, level: str = "INFO") -> logging.Logger:
    """Configure and return a named process logger without mutating root logging."""

    logger = logging.getLogger(f"or_on_platform.{service}")
    logger.handlers.clear()
    logger.propagate = False
    logger.setLevel(level)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(service=service, environment=environment))
    logger.addHandler(handler)
    return logger
