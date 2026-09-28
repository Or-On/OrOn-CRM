"""SMS provider port; verification and quotas remain authoritative in PostgreSQL."""

from __future__ import annotations

import hashlib
import hmac
import re
from typing import Protocol
from uuid import UUID

import httpx


class SmsUnavailable(ValueError):
    def __init__(self) -> None:
        super().__init__("SMS verification is unavailable")


class SmsSender(Protocol):
    async def send(self, phone: str, code: str) -> None: ...


def code_digest(challenge: UUID, code: str, pepper: str) -> str:
    if len(pepper) < 32 or re.fullmatch(r"[0-9]{6}", code) is None:
        raise ValueError("invalid SMS verification material")
    return hmac.new(
        pepper.encode(), f"sms-otp-v1:{challenge}:{code}".encode(), hashlib.sha256
    ).hexdigest()


class TwilioSmsSender:
    def __init__(self, account_sid: str, auth_token: str, from_number: str) -> None:
        if (
            re.fullmatch(r"AC[0-9a-fA-F]{32}", account_sid) is None
            or not auth_token
            or re.fullmatch(r"\+[1-9][0-9]{7,14}", from_number) is None
        ):
            raise SmsUnavailable()
        self._account_sid = account_sid
        self._auth_token = auth_token
        self._from_number = from_number

    async def send(self, phone: str, code: str) -> None:
        if (
            re.fullmatch(r"\+[1-9][0-9]{7,14}", phone) is None
            or re.fullmatch(r"[0-9]{6}", code) is None
        ):
            raise SmsUnavailable()
        try:
            async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
                response = await client.post(
                    f"https://api.twilio.com/2010-04-01/Accounts/{self._account_sid}/Messages.json",
                    auth=(self._account_sid, self._auth_token),
                    data={
                        "To": phone,
                        "From": self._from_number,
                        "Body": (
                            f"Or-On customer verification code: {code}. Expires in 5 minutes. "
                            "Share only with the agent on your active call."
                        ),
                    },
                )
                response.raise_for_status()
                result = response.json()
                if (
                    not isinstance(result, dict)
                    or re.fullmatch(r"SM[0-9a-fA-F]{32}", str(result.get("sid"))) is None
                    or result.get("status")
                    not in {"accepted", "queued", "sending", "sent", "delivered"}
                ):
                    raise SmsUnavailable()
        except Exception:
            raise SmsUnavailable() from None
