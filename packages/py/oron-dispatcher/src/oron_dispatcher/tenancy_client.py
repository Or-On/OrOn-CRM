"""Fail-closed DID resolution port retained from Or-on."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from uuid import UUID

import httpx
from pydantic import BaseModel

logger = logging.getLogger(__name__)


class PhoneResolution(BaseModel):
    tenant_id: UUID
    flow_id: UUID


class TenancyClient:
    """Resolve a normalized DID through an authenticated canonical API client."""

    def __init__(
        self,
        base_url: str,
        *,
        headers: Mapping[str, str] | None = None,
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 5.0,
    ) -> None:
        self._client = client or httpx.AsyncClient(
            base_url=base_url.rstrip("/"), timeout=timeout_seconds, headers=headers
        )
        self._owns_client = client is None

    async def resolve_phone(self, e164: str) -> PhoneResolution | None:
        try:
            response = await self._client.get(
                "/api/v1/voice/phone-resolution", params={"did": e164}
            )
        except httpx.HTTPError as exc:
            logger.warning(
                "DID resolution transport failed", extra={"error_type": type(exc).__name__}
            )
            return None
        if response.status_code == 404:
            return None
        if not response.is_success:
            logger.warning("DID resolution failed", extra={"status_code": response.status_code})
            return None
        return PhoneResolution.model_validate(response.json())

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()
