"""Compatibility surface for preserved historical Or-on revisions.

The historical migrations imported :class:`oron_db.DbRole` from an upstream
workspace package and migration 0004 imported Or-on's field-cipher configuration.
Target migrations must execute without sibling repositories, so this module
preserves those exact migration-time semantics without copying the runtime package.
"""

import base64
import hashlib
import hmac
import os
import re
import uuid
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

_VERSION_PREFIX = "v1:"
_NONCE_LEN = 12
_E164_ALLOWED = re.compile(r"[^\d+]")


class DbRole(StrEnum):
    """Historical Or-on least-privilege database role names."""

    SESSIONS = "oron_sessions_app"
    TENANCY = "oron_tenancy_app"


class FieldCipher(Protocol):
    def encrypt(self, tenant_id: uuid.UUID, plaintext: str) -> str: ...

    def decrypt(self, tenant_id: uuid.UUID, ciphertext: str) -> str: ...


class LocalFieldCipher:
    """Historical AES-256-GCM format with the tenant UUID bound as AAD."""

    def __init__(self, key: bytes):
        if len(key) != 32:
            raise ValueError(f"AES-256-GCM key must be 32 bytes, got {len(key)}")
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        self._aesgcm = AESGCM(key)

    def encrypt(self, tenant_id: uuid.UUID, plaintext: str) -> str:
        nonce = os.urandom(_NONCE_LEN)
        ciphertext = self._aesgcm.encrypt(
            nonce,
            plaintext.encode("utf-8"),
            str(tenant_id).encode("utf-8"),
        )
        return _VERSION_PREFIX + base64.b64encode(nonce + ciphertext).decode("ascii")

    def decrypt(self, tenant_id: uuid.UUID, ciphertext: str) -> str:
        if not ciphertext.startswith(_VERSION_PREFIX):
            raise ValueError(f"unsupported ciphertext version: {ciphertext[:3]!r}")
        raw = base64.b64decode(ciphertext.removeprefix(_VERSION_PREFIX))
        nonce, payload = raw[:_NONCE_LEN], raw[_NONCE_LEN:]
        return self._aesgcm.decrypt(
            nonce,
            payload,
            str(tenant_id).encode("utf-8"),
        ).decode("utf-8")


class KmsFieldCipher:
    """Historical KMS-unwrapped DEK adapter, loaded only when explicitly selected."""

    def __init__(self, kms_key_name: str, wrapped_dek: bytes):
        from google.cloud.kms import KeyManagementServiceClient  # type: ignore[import-not-found]

        client = KeyManagementServiceClient()
        dek = client.decrypt(request={"name": kms_key_name, "ciphertext": wrapped_dek}).plaintext
        self._cipher = LocalFieldCipher(dek)

    def encrypt(self, tenant_id: uuid.UUID, plaintext: str) -> str:
        return self._cipher.encrypt(tenant_id, plaintext)

    def decrypt(self, tenant_id: uuid.UUID, ciphertext: str) -> str:
        return self._cipher.decrypt(tenant_id, ciphertext)


class FieldCipherBackend(StrEnum):
    LOCAL = "local"
    KMS = "kms"


def build_field_cipher(
    backend: FieldCipherBackend,
    *,
    local_key: bytes | None = None,
    kms_key_name: str | None = None,
    kms_wrapped_dek: bytes | None = None,
) -> FieldCipher:
    if backend is FieldCipherBackend.LOCAL:
        if local_key is None:
            raise ValueError("LOCAL field cipher requires FIELD_CIPHER_LOCAL_KEY")
        return LocalFieldCipher(local_key)
    if not kms_key_name:
        raise ValueError("KMS field cipher requires KMS_KEY_NAME")
    if not kms_wrapped_dek:
        raise ValueError("KMS field cipher requires KMS_WRAPPED_DEK")
    return KmsFieldCipher(kms_key_name, kms_wrapped_dek)


def normalize_e164(value: str) -> str:
    if not value:
        raise ValueError("normalize_e164 requires a non-empty number")
    normalized = _E164_ALLOWED.sub("", value.strip())
    return normalized if normalized.startswith("+") else f"+{normalized}"


def blind_index(value: str, key: bytes) -> str:
    normalized = normalize_e164(value)
    return hmac.new(key, normalized.encode("utf-8"), hashlib.sha256).hexdigest()


def _secret_env(name: str) -> str | None:
    """Read the direct setting first, then the established Or-on secret alias."""

    return os.environ.get(name) or os.environ.get(f"SECRET__{name}")


@dataclass(frozen=True, slots=True)
class MigrationCipherSettings:
    field_cipher_backend: FieldCipherBackend
    field_cipher_local_key: str | None
    blind_index_key: str | None
    kms_key_name: str | None
    kms_wrapped_dek: str | None


def load_migration_cipher_settings() -> MigrationCipherSettings:
    return MigrationCipherSettings(
        field_cipher_backend=FieldCipherBackend(
            os.environ.get("FIELD_CIPHER_BACKEND", FieldCipherBackend.LOCAL)
        ),
        field_cipher_local_key=_secret_env("FIELD_CIPHER_LOCAL_KEY"),
        blind_index_key=_secret_env("BLIND_INDEX_KEY"),
        kms_key_name=_secret_env("KMS_KEY_NAME"),
        kms_wrapped_dek=_secret_env("KMS_WRAPPED_DEK"),
    )
