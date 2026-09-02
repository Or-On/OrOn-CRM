"""The production `PlaceCall`: post to the dispatcher's existing `/calls`.

Deliberately the same endpoint a human clicking "call" already uses, so a
campaign dial and a manual dial take the identical path through SIP, the agent
and session bookkeeping — one path to keep working, not two.
"""

import uuid

import httpx


class DispatcherDialer:
    def __init__(self, base_url: str, token: str, *, client: httpx.AsyncClient | None = None):
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._client = client or httpx.AsyncClient(timeout=30.0)

    async def __call__(
        self, *, phone_number: str, tenant_id: uuid.UUID, flow_id: uuid.UUID
    ) -> uuid.UUID:
        response = await self._client.post(
            f"{self._base_url}/calls",
            json={
                "phone_number": phone_number,
                "tenant_id": str(tenant_id),
                "flow_id": str(flow_id),
            },
            headers={"Authorization": f"Bearer {self._token}"},
        )
        response.raise_for_status()
        return uuid.UUID(response.json()["session_id"])

    async def aclose(self) -> None:
        await self._client.aclose()
