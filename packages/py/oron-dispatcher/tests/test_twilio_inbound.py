"""Offline provider boundary tests: real ASGI requests, no calls or credentials."""

import asyncio
import base64
import hashlib
import hmac
from unittest.mock import AsyncMock
from urllib.parse import urlencode
from uuid import uuid4
from xml.etree.ElementTree import fromstring

import httpx
import pytest
from oron_dispatcher.config import DispatcherSettings
from oron_dispatcher.tenancy_client import PhoneResolution
from oron_dispatcher.twilio_inbound import (
    CALLBACK_PATH,
    TwilioInboundHandler,
    TwilioInboundRoute,
    _form_signature,
)
from oron_dispatcher.webhook import create_app
from pydantic import ValidationError

URL = "https://voice.example.invalid" + CALLBACK_PATH


def test_official_twilio_security_signature_vector():
    # Published provider protocol vector, independent of our test signing helper:
    # https://www.twilio.com/docs/usage/security#explore-the-algorithm-yourself
    assert (
        _form_signature(
            "12345",
            "https://example.com/myapp.php?foo=1&bar=2",
            {
                "Digits": "1234",
                "To": "+18005551212",
                "From": "+14158675310",
                "Caller": "+14158675310",
                "CallSid": "CA1234567890ABCDE",
            },
        )
        == "L/OH5YylLD5NRKLltdqwSvS0BnU="
    )


def route(**changes):
    return TwilioInboundRoute.model_validate(
        {
            "tenant_id": str(uuid4()),
            "account_sid": "AC" + "1" * 32,
            "auth_token": "fictional-token-0123456789",
            "phone_number_sid": "PN" + "2" * 32,
            "did": "+14155550101",
            "trunk_id": "ST_fictional",
            "sip_host": "fictional.sip.livekit.cloud",
            "sip_transport": "tls",
            "auth_username": "fictional-user-0123456789",
            "auth_password": 'fictional-<>&"-password',
            **changes,
        }
    )


def form(binding):
    return {
        "AccountSid": binding.account_sid,
        "To": binding.did,
        "From": "+14155550102",
        "CallSid": "CA" + "3" * 32,
        "CallStatus": "ringing",
        "UnexpectedFutureField": "provider extension",
    }


def sign(binding, params, url=URL):
    text = url + "".join(key + params[key] for key in sorted(params))
    return base64.b64encode(
        hmac.digest(binding.auth_token.get_secret_value().encode(), text.encode(), hashlib.sha1)
    ).decode()


def application(*routes, resolver=None, lookup=None):
    resolver = resolver or AsyncMock(
        return_value=PhoneResolution(
            tenant_id=routes[0].tenant_id, flow_id=uuid4(), dispatch_rule_id="SDR_fictional"
        )
    )
    lookup = lookup or AsyncMock()
    lookup.active.return_value = True
    handler = TwilioInboundHandler(
        callback_url=URL, routes=routes, resolve_phone=resolver, call_lookup=lookup
    )
    return (
        create_app(
            dispatcher=None,
            receiver=None,
            ledger=None,
            assertion_verifier=None,
            twilio_inbound=handler,
        ),
        resolver,
        lookup,
    )


async def request(app, binding, params=None, *, path=CALLBACK_PATH, headers=None, body=None):
    params = form(binding) if params is None else params
    headers = {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": sign(binding, params),
        **(headers or {}),
    }
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://voice.example.invalid"
    ) as client:
        return await client.post(
            path, content=urlencode(params) if body is None else body, headers=headers
        )


async def test_validated_twiml_escapes_credentials_and_preserves_original_caller(caplog):
    binding = route()
    app, resolver, lookup = application(binding)
    response = await request(
        app,
        binding,
        headers={"x-forwarded-host": "voice.example.invalid", "x-forwarded-proto": "https"},
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    xml = fromstring(response.content)  # noqa: S314 - locally generated fixture XML
    sip = xml.find("./Dial/Sip")
    assert sip is not None and sip.attrib["password"] == binding.auth_password.get_secret_value()
    assert sip.text == f"sip:{binding.did}@{binding.sip_host};transport=tls"
    assert xml.find("Dial").attrib == {}  # no callerId substitution
    resolver.assert_awaited_once_with(binding.did)
    lookup.active.assert_awaited_once_with(binding, form(binding)["CallSid"], form(binding)["From"])
    assert binding.auth_password.get_secret_value() not in caplog.text
    assert binding.auth_token.get_secret_value() not in caplog.text


@pytest.mark.parametrize(
    "change",
    [
        {"AccountSid": "AC" + "9" * 32},
        {"To": "+14155550103"},
        {"CallSid": "invalid"},
        {"From": ""},
    ],
)
async def test_unknown_or_malformed_signed_identity_never_reads_provider(change):
    binding = route()
    app, resolver, lookup = application(binding)
    response = await request(app, binding, {**form(binding), **change})
    assert response.status_code == 403
    resolver.assert_not_awaited()
    lookup.active.assert_not_awaited()


@pytest.mark.parametrize(
    "headers,path",
    [
        ({"host": "attacker.invalid"}, CALLBACK_PATH),
        ({"x-forwarded-host": "attacker.invalid"}, CALLBACK_PATH),
        ({"x-forwarded-proto": "http"}, CALLBACK_PATH),
        ({}, CALLBACK_PATH + "?override=1"),
        ({"x-twilio-signature": "z" * 27 + "="}, CALLBACK_PATH),
        ({"x-twilio-signature": "é" * 28}, CALLBACK_PATH),
    ],
)
async def test_forged_auth_and_proxy_url_are_denied(headers, path):
    binding = route()
    app, resolver, lookup = application(binding)
    # HTTPX only encodes header str as ASCII; bytes exercise raw ASGI latin1.
    if "é" in headers.get("x-twilio-signature", ""):
        headers["x-twilio-signature"] = headers["x-twilio-signature"].encode("latin1")
    response = await request(app, binding, headers=headers, path=path)
    assert response.status_code == 403
    resolver.assert_not_awaited()
    lookup.active.assert_not_awaited()


@pytest.mark.parametrize(
    "body,status",
    [
        ("To=%ZZ", 400),
        ("To=%FF", 400),
        ("To=x&To=y", 400),
        ("x=" + "a" * 17000, 413),
        ("&".join(f"a{i}=x" for i in range(65)), 400),
    ],
)
async def test_forms_are_bounded_without_secret_xml(body, status):
    binding = route()
    app, resolver, lookup = application(binding)
    response = await request(app, binding, body=body)
    assert response.status_code == status and "<Sip" not in response.text
    resolver.assert_not_awaited()
    lookup.active.assert_not_awaited()


async def test_signs_all_fields_and_closed_call_replay_returns_no_xml():
    binding = route()
    app, _, lookup = application(binding)
    params = form(binding)
    signature = sign(binding, params)
    params["UnexpectedFutureField"] = "tampered"
    assert (
        await request(app, binding, params, headers={"x-twilio-signature": signature})
    ).status_code == 403
    lookup.active.assert_not_awaited()
    lookup.active.return_value = False
    assert (await request(app, binding)).status_code == 403
    lookup.active.return_value = True
    assert (await request(app, binding)).status_code == 200
    # An active provider retry returns the same routing response, never dials.
    assert (await request(app, binding)).status_code == 200


@pytest.mark.parametrize("kind", ["missing", "foreign", "simulator", "no-rule"])
async def test_authoritative_did_drift_refuses_xml_before_provider_read(kind):
    binding = route()
    resolution = (
        None
        if kind == "missing"
        else PhoneResolution(
            tenant_id=uuid4() if kind == "foreign" else binding.tenant_id,
            flow_id=uuid4(),
            dispatch_rule_id={"simulator": "simulator-fixture", "no-rule": None}.get(
                kind, "SDR_fixture"
            ),
        )
    )
    app, _, lookup = application(binding, resolver=AsyncMock(return_value=resolution))
    assert (await request(app, binding)).status_code == 503
    lookup.active.assert_not_awaited()


async def test_two_simultaneous_tenants_receive_only_their_bound_credentials():
    first = route()
    second = route(
        account_sid="AC" + "4" * 32,
        did="+14155550104",
        trunk_id="ST_second",
        auth_username="second-user-0123456789",
        auth_password="second-password-0123456789",
    )

    async def resolve(did):
        selected = first if did == first.did else second
        await asyncio.sleep(0)
        return PhoneResolution(
            tenant_id=selected.tenant_id, flow_id=uuid4(), dispatch_rule_id="SDR_" + did[-4:]
        )

    app, _, _ = application(first, second, resolver=resolve)
    responses = await asyncio.gather(request(app, first), request(app, second))
    for binding, response in zip((first, second), responses, strict=True):
        assert response.status_code == 200
        assert (
            fromstring(response.content).find("./Dial/Sip").attrib["username"]  # noqa: S314
            == binding.auth_username.get_secret_value()
        )


def test_config_requires_explicit_complete_bindings_and_redacts_validation():
    assert DispatcherSettings(_env_file=None).enable_twilio_inbound is False
    with pytest.raises(ValidationError):
        DispatcherSettings(_env_file=None, ENABLE_TWILIO_INBOUND=True)
    binding = route()
    raw = binding.model_dump(mode="json")
    raw.update(
        auth_token="secret-value-invalid",
        auth_username="secret-value-invalid",
        auth_password="secret-value-invalid",
        sip_host="bad://host",
    )
    with pytest.raises(ValidationError) as error:
        DispatcherSettings(_env_file=None, TWILIO_INBOUND_ROUTES_JSON=[raw])
    assert "secret-value-invalid" not in str(error.value)


async def test_default_disabled_endpoint_never_serves_xml():
    app = create_app(dispatcher=None, receiver=None, ledger=None, assertion_verifier=None)
    assert (await request(app, route())).status_code == 404
