"""A bounded, authenticated TwiML boundary; it never places a call itself."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import re
from collections.abc import Awaitable, Callable
from typing import Literal, Protocol
from urllib.parse import parse_qsl, urlsplit
from uuid import UUID
from xml.etree.ElementTree import Element, SubElement, tostring

import aiohttp
from fastapi import HTTPException, Request
from fastapi.responses import Response
from oron_common import E164
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from oron_dispatcher.tenancy_client import PhoneResolution

CALLBACK_PATH = "/twilio/voice/inbound"
_MAX_BODY = 16_384
_SID = re.compile(r"CA[0-9a-fA-F]{32}\Z")


class TwilioInboundRoute(BaseModel):
    """Operator-owned binding; none of these values comes from a caller."""

    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)
    tenant_id: UUID
    account_sid: str = Field(pattern=r"^AC[0-9a-fA-F]{32}$")
    auth_token: SecretStr
    phone_number_sid: str = Field(pattern=r"^PN[0-9a-fA-F]{32}$")
    did: E164
    trunk_id: str = Field(pattern=r"^ST_[a-zA-Z0-9_-]+$")
    sip_host: str = Field(min_length=4, max_length=253, pattern=r"^[a-zA-Z0-9.-]+$")
    sip_transport: Literal["tls"] = "tls"
    auth_username: SecretStr
    auth_password: SecretStr

    @field_validator("auth_token", "auth_username", "auth_password")
    @classmethod
    def secret_is_present(cls, value: SecretStr) -> SecretStr:
        raw = value.get_secret_value()
        if not 16 <= len(raw) <= 256 or any(not 33 <= ord(c) <= 126 for c in raw):
            raise ValueError("invalid configured credential")
        return value

    @field_validator("sip_host")
    @classmethod
    def hostname_is_valid(cls, value: str) -> str:
        if any(
            not label or label.startswith("-") or label.endswith("-") for label in value.split(".")
        ):
            raise ValueError("invalid configured SIP host")
        return value.lower()


def validate_routes(routes: tuple[TwilioInboundRoute, ...]) -> tuple[TwilioInboundRoute, ...]:
    dids, trunks, credentials = set(), set(), set()
    accounts: dict[str, str] = {}
    for route in routes:
        credential = route.auth_username.get_secret_value()
        if route.did in dids or route.trunk_id in trunks or credential in credentials:
            raise ValueError("ambiguous Twilio inbound binding")
        token = route.auth_token.get_secret_value()
        if route.account_sid in accounts and accounts[route.account_sid] != token:
            raise ValueError("inconsistent Twilio account credential")
        dids.add(route.did)
        trunks.add(route.trunk_id)
        credentials.add(credential)
        accounts[route.account_sid] = token
    return routes


def validate_callback_url(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path != CALLBACK_PATH
        # Twilio HTTPS Voice signatures omit explicit ports. One canonical
        # port-free URL keeps signing and proxy authority checks identical.
        or parsed.port is not None
    ):
        raise ValueError("Twilio callback requires the exact configured HTTPS URL")
    return value


def _form_signature(token: str, url: str, params: dict[str, str]) -> str:
    signed = url + "".join(key + params[key] for key in sorted(params))
    return base64.b64encode(hmac.digest(token.encode(), signed.encode(), hashlib.sha1)).decode()


class CallLookup(Protocol):
    async def active(self, route: TwilioInboundRoute, call_sid: str, caller: str) -> bool: ...


class TwilioCallLookup:
    async def active(self, route: TwilioInboundRoute, call_sid: str, caller: str) -> bool:
        # Fixed provider origin. aiohttp does not emit request URL/access logs
        # (which would contain a CallSid) for this client-side lookup.
        url = (
            f"https://api.twilio.com/2010-04-01/Accounts/{route.account_sid}/Calls/{call_sid}.json"
        )
        auth = aiohttp.BasicAuth(route.account_sid, route.auth_token.get_secret_value())
        async with (
            aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=3), auth=auth) as client,
            client.get(url, allow_redirects=False) as response,
        ):
            if response.status == 404:
                return False
            if response.status != 200:
                raise RuntimeError("call verification unavailable")
            raw = bytearray()
            async for chunk in response.content.iter_chunked(8192):
                raw.extend(chunk)
                if len(raw) > 65_536:
                    raise RuntimeError("call verification response exceeded bound")
            data = json.loads(raw)
        if not isinstance(data, dict):
            raise RuntimeError("invalid call verification response")
        return (
            data.get("sid") == call_sid
            and data.get("account_sid") == route.account_sid
            and data.get("phone_number_sid") == route.phone_number_sid
            and data.get("to") == route.did
            and data.get("from") == caller
            and data.get("direction") == "inbound"
            and data.get("status") in {"queued", "ringing", "in-progress"}
        )


class TwilioInboundHandler:
    def __init__(
        self,
        *,
        callback_url: str,
        routes: tuple[TwilioInboundRoute, ...],
        resolve_phone: Callable[[str], Awaitable[PhoneResolution | None]],
        call_lookup: CallLookup | None = None,
    ):
        self._callback_url = validate_callback_url(callback_url)
        self._authority = urlsplit(callback_url).netloc.lower()
        self._routes = {(r.account_sid, r.did): r for r in validate_routes(routes)}
        self._resolve_phone = resolve_phone
        self._calls = call_lookup or TwilioCallLookup()
        self._reads = asyncio.Semaphore(16)

    async def respond(self, request: Request) -> Response:
        # Only the operator-configured URL participates in authentication.
        # Caddy preserves Host and sets the HTTPS forwarded headers itself.
        if (
            request.url.path != CALLBACK_PATH
            or request.url.query
            or request.headers.get("host", "").lower() != self._authority
            or request.headers.get("x-forwarded-host", self._authority).lower() != self._authority
            or request.headers.get("x-forwarded-proto", "https").lower() != "https"
        ):
            raise HTTPException(403, "invalid provider request")
        if (
            request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            != "application/x-www-form-urlencoded"
        ):
            raise HTTPException(415, "unsupported provider request")
        signature = request.headers.get("x-twilio-signature", "")
        if not re.fullmatch(r"[A-Za-z0-9+/]{27}=", signature):
            raise HTTPException(403, "invalid provider request")
        body = bytearray()
        try:
            async with asyncio.timeout(3):
                async for chunk in request.stream():
                    if len(chunk) > _MAX_BODY - len(body):
                        raise HTTPException(413, "provider request too large")
                    body.extend(chunk)
        except TimeoutError:
            raise HTTPException(408, "provider request timed out") from None
        try:
            encoded = body.decode("utf-8", errors="strict")
            if re.search(r"%(?![0-9a-fA-F]{2})", encoded):
                raise ValueError("invalid encoding")
            pairs = parse_qsl(
                encoded,
                keep_blank_values=True,
                strict_parsing=True,
                errors="strict",
                max_num_fields=64,
            )
            if any(not k or len(k) > 128 or len(v) > 2048 for k, v in pairs):
                raise ValueError("invalid form field")
            params = dict(pairs)
            if len(params) != len(pairs):
                raise ValueError("duplicate form field")
        except ValueError, UnicodeError:
            raise HTTPException(400, "invalid provider form") from None
        route = self._routes.get((params.get("AccountSid", ""), params.get("To", "")))
        if route is None:
            raise HTTPException(403, "invalid provider request")
        # Twilio's documented form signing algorithm includes EVERY field,
        # sorted by name. Duplicate keys are rejected above, not collapsed.
        expected = _form_signature(route.auth_token.get_secret_value(), self._callback_url, params)
        if not hmac.compare_digest(expected, signature):
            raise HTTPException(403, "invalid provider request")
        call_sid, caller = params.get("CallSid", ""), params.get("From", "")
        if not _SID.fullmatch(call_sid) or not caller or len(caller) > 128:
            raise HTTPException(403, "invalid provider request")
        try:
            async with asyncio.timeout(4), self._reads:
                resolution = await self._resolve_phone(route.did)
                if (
                    resolution is None
                    or resolution.tenant_id != route.tenant_id
                    or not resolution.dispatch_rule_id
                    or not re.fullmatch(r"SDR_[A-Za-z0-9_-]+", resolution.dispatch_rule_id)
                ):
                    raise HTTPException(503, "provider routing unavailable")
                if not await self._calls.active(route, call_sid, caller):
                    raise HTTPException(403, "invalid provider call")
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, "provider verification unavailable") from None
        root = Element("Response")
        dial = SubElement(root, "Dial")  # preserve original inbound caller ID
        sip = SubElement(
            dial,
            "Sip",
            username=route.auth_username.get_secret_value(),
            password=route.auth_password.get_secret_value(),
        )
        sip.text = f"sip:{route.did}@{route.sip_host};transport={route.sip_transport}"
        return Response(
            tostring(root, encoding="utf-8", xml_declaration=True),
            media_type="application/xml",
            headers={"Cache-Control": "no-store"},
        )
