import hashlib
import hmac
from unittest.mock import AsyncMock, patch
from uuid import UUID

import httpx
import pytest
from dispatcher_runtime.sms import SmsUnavailable, TwilioSmsSender, code_digest


def test_sms_digest_matches_the_shared_wire_contract():
    challenge = UUID("10000000-0000-4000-8000-000000000001")
    pepper = "fictional-sms-pepper-with-thirty-two-characters"
    expected = hmac.new(
        pepper.encode(), f"sms-otp-v1:{challenge}:012345".encode(), hashlib.sha256
    ).hexdigest()
    assert code_digest(challenge, "012345", pepper) == expected
    with pytest.raises(ValueError):
        code_digest(challenge, "12345", pepper)


async def test_sms_sender_never_logs_carrier_response_or_retries():
    response = httpx.Response(
        429,
        json={"message": "private provider body"},
        request=httpx.Request("POST", "https://api.twilio.com"),
    )
    client = AsyncMock()
    client.post.return_value = response
    client.__aenter__.return_value = client
    with patch("dispatcher_runtime.sms.httpx.AsyncClient", return_value=client):
        sender = TwilioSmsSender("AC" + "a" * 32, "fictional-token", "+12025550101")
        with pytest.raises(SmsUnavailable, match="^SMS verification is unavailable$"):
            await sender.send("+12025550102", "012345")
    client.post.assert_awaited_once()
