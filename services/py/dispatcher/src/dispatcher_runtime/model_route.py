"""Voice consumes the same bound AES-GCM model credential format as messaging.

Only the active-session database projection can supply an envelope. This module
never accepts a caller-selected endpoint or falls back to deployment credentials.
"""

import base64
import json
import math
import re
from uuid import UUID

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pydantic import SecretStr


def model_keys(current: SecretStr | None, ring: SecretStr | None) -> dict[str, bytes]:
    values = json.loads(ring.get_secret_value()) if ring else {}
    if not isinstance(values, dict) or len(values) > 16:
        raise ValueError("invalid model keyring")
    if current:
        if "env:model:v2" in values:
            raise ValueError("duplicate model key version")
        values["env:model:v2"] = current.get_secret_value()
    keys = {}
    for version, encoded in values.items():
        if not re.fullmatch(r"[A-Za-z0-9:_.-]{1,100}", version) or version == "env:v1":
            raise ValueError("invalid model key version")
        key = base64.b64decode(encoded, validate=True)
        if len(key) != 32 or base64.b64encode(key).decode() != encoded:
            raise ValueError("invalid model key")
        keys[version] = key
    return keys


def resolve_route(projection: dict, keys: dict[str, bytes], tenant_id: str) -> dict:
    try:
        configuration, envelope = projection["configuration"], projection["credential"]
        provider = configuration["provider"]
        if provider not in {"gemini", "openai"} or envelope["provider"] != provider:
            raise ValueError()
        if configuration["tenantId"] != tenant_id or envelope["tenantId"] != tenant_id:
            raise ValueError()
        if envelope["modelConfigurationId"] != configuration["id"]:
            raise ValueError()
        for field in ("tenantId", "modelConfigurationId", "credentialId"):
            if str(UUID(envelope[field])) != envelope[field]:
                raise ValueError()
        if (
            envelope["kind"] != "llm_api_key_v2"
            or envelope["algorithm"] != "aes-256-gcm:model-provider:v2"
        ):
            raise ValueError()
        aad = json.dumps(
            [
                "oron.model.provider.v2",
                envelope["tenantId"],
                envelope["modelConfigurationId"],
                envelope["credentialId"],
                provider,
            ],
            separators=(",", ":"),
        ).encode()
        nonce = bytes.fromhex(envelope["nonce"])
        if len(nonce) != 12:
            raise ValueError()
        decoded = json.loads(
            AESGCM(keys[envelope["keyVersion"]]).decrypt(
                nonce, bytes.fromhex(envelope["ciphertext"]), aad
            )
        )
        if set(decoded) != {"apiKey"} or not re.fullmatch(
            r"[\x21-\x7e]{1,8192}", decoded["apiKey"]
        ):
            raise ValueError()
        model, settings = configuration["model"], configuration["settings"]
        if not isinstance(model, str) or not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", model
        ):
            raise ValueError()
        if (provider == "gemini") != model.startswith("gemini-"):
            raise ValueError()
        if not isinstance(settings, dict) or set(settings) - {
            "temperature",
            "maxTokens",
            "timeoutMs",
            "fallbackModel",
        }:
            raise ValueError()
        for name, maximum in (("maxTokens", 8192), ("timeoutMs", 60000)):
            if name in settings and (
                type(settings[name]) is not int or not 1 <= settings[name] <= maximum
            ):
                raise ValueError()
        temperature = settings.get("temperature", 0.2)
        if (
            type(temperature) not in (float, int)
            or not math.isfinite(temperature)
            or not 0 <= temperature <= 2
        ):
            raise ValueError()
        fallback = settings.get("fallbackModel")
        if fallback is not None and (
            not isinstance(fallback, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", fallback)
        ):
            raise ValueError()
        return {
            "model": model,
            "apiKey": SecretStr(decoded["apiKey"]),
            "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai"
            if provider == "gemini"
            else "https://api.openai.com/v1",
            "settings": settings,
        }
    except (KeyError, ValueError, TypeError, InvalidTag) as error:
        raise ValueError("explicit voice model route unavailable") from error
