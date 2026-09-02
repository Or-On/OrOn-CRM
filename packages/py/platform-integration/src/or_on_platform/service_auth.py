"""Canonical short-lived service assertion verification for Python runtimes."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

import jwt
from pydantic import BaseModel, ValidationError


class ServicePrincipal(BaseModel):
    """Authenticated user context forwarded by the same-origin web boundary."""

    user_id: UUID
    tenant_id: UUID
    role: Literal["viewer", "agent", "admin", "owner"]
    session_id: UUID
    capability: str | None = None


class InvalidServiceAssertion(ValueError):
    """Raised without leaking token or claim details."""


class ServiceAssertionVerifier:
    """Verify a narrowly scoped assertion for one explicit service audience."""

    def __init__(self, secret: str, *, audience: str) -> None:
        if len(secret) < 32:
            raise ValueError("service assertion secret must be at least 32 characters")
        if not audience:
            raise ValueError("service assertion audience is required")
        self._secret = secret
        self._audience = audience

    def verify(self, token: str) -> ServicePrincipal:
        try:
            claims = jwt.decode(
                token,
                self._secret,
                algorithms=["HS256"],
                audience=self._audience,
                issuer="or-on-platform-web",
                options={"require": ["exp", "iat", "iss", "aud", "sub", "jti"]},
            )
            issued_at = claims["iat"]
            expires_at = claims["exp"]
            if (
                not isinstance(issued_at, (int, float))
                or isinstance(issued_at, bool)
                or not isinstance(expires_at, (int, float))
                or isinstance(expires_at, bool)
                or expires_at <= issued_at
                or expires_at - issued_at > 120
            ):
                raise TypeError("assertion lifetime is invalid")
            return ServicePrincipal(
                user_id=claims["sub"],
                tenant_id=claims["tenant_id"],
                role=claims["role"],
                session_id=claims["session_id"],
                capability=claims.get("capability"),
            )
        except (jwt.PyJWTError, KeyError, TypeError, ValidationError) as exc:
            raise InvalidServiceAssertion("service assertion is invalid") from exc
