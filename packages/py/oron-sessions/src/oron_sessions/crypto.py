"""Field-level encryption for caller-identity columns (from_number/to_number).

Postgres never sees plaintext phone numbers: `oron_sessions.crud` encrypts
before insert; only the backfill migration and a future erasure job ever
decrypt (D4 in the design note — the API never does). Ciphertext is
`v1:<base64(nonce || ciphertext_with_tag)>`, AES-256-GCM — the version prefix
lets a future scheme/key change keep decrypting old rows.

`FieldCipher.encrypt`/`decrypt` carry `tenant_id` from day one (D1) so a v2
per-tenant-DEK backend is a drop-in swap, not a signature change.
`LocalFieldCipher` binds `tenant_id` as AES-GCM additional authenticated data
(AAD): a ciphertext copied into another tenant's row fails to decrypt.
"""

import hashlib
import hmac
import re
import uuid
from enum import StrEnum
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from google.cloud.kms import KeyManagementServiceClient

_VERSION_PREFIX = "v1:"
_NONCE_LEN = 12  # bytes; standard for AES-GCM
_E164_ALLOWED = re.compile(r"[^\d+]")


class FieldCipher(Protocol):
    def encrypt(self, tenant_id: uuid.UUID, plaintext: str) -> str:
        """Returns `v1:<b64(nonce||ct||tag)>`."""
        ...

    def decrypt(self, tenant_id: uuid.UUID, ciphertext: str) -> str:
        """Inverse of `encrypt`. Raises if the value is tampered, the wrong
        version, or wasn't encrypted under this cipher's key."""
        ...


class LocalFieldCipher:
    """AES-256-GCM with a single key held in memory. Dev and tests: no KMS, no
    GCP — round-trips identically to `KmsFieldCipher`."""

    def __init__(self, key: bytes):
        if len(key) != 32:
            raise ValueError(f"AES-256-GCM key must be 32 bytes, got {len(key)}")
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        self._aesgcm = AESGCM(key)

    def encrypt(self, tenant_id: uuid.UUID, plaintext: str) -> str:
        import base64
        import os

        nonce = os.urandom(_NONCE_LEN)
        ct = self._aesgcm.encrypt(nonce, plaintext.encode("utf-8"), str(tenant_id).encode("utf-8"))
        return _VERSION_PREFIX + base64.b64encode(nonce + ct).decode("ascii")

    def decrypt(self, tenant_id: uuid.UUID, ciphertext: str) -> str:
        import base64

        if not ciphertext.startswith(_VERSION_PREFIX):
            raise ValueError(f"unsupported ciphertext version: {ciphertext[:3]!r}")
        raw = base64.b64decode(ciphertext.removeprefix(_VERSION_PREFIX))
        nonce, ct = raw[:_NONCE_LEN], raw[_NONCE_LEN:]
        return self._aesgcm.decrypt(nonce, ct, str(tenant_id).encode("utf-8")).decode("utf-8")


class KmsFieldCipher:
    """v1's shared-DEK backend (design note D1): one Cloud-KMS-wrapped data
    encryption key, unwrapped once at construction (a single KMS call) and
    cached in memory; every field after that is local AES-256-GCM, so the hot
    path never calls KMS. `tenant_id` is accepted but ignored — the fast-follow
    per-tenant-DEK backend (design D1, v2) is what makes it meaningful, once
    `did-tenant-routing` lands.

    Provisioning the wrapped DEK is a one-time step: generate 32 random bytes,
    KMS-encrypt them under the KEK (`gcloud kms encrypt --key=$KMS_KEY_NAME`),
    and store the base64 result as `SECRET__KMS_WRAPPED_DEK` — the plaintext DEK
    is never persisted anywhere.
    """

    def __init__(
        self,
        kms_key_name: str,
        wrapped_dek: bytes,
        client: KeyManagementServiceClient | None = None,
    ):
        if client is None:
            from google.cloud.kms import KeyManagementServiceClient

            client = KeyManagementServiceClient()
        dek = client.decrypt(request={"name": kms_key_name, "ciphertext": wrapped_dek}).plaintext
        # Same AES-GCM/`v1:` implementation as LOCAL, so a value written under
        # either backend decrypts under the other given the same DEK.
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
    """Construct the configured cipher. Called once at the edge (app startup,
    or a migration entrypoint) and injected — nothing downstream reads
    settings for itself.

    LOCAL requires an explicit `local_key`: field encryption must never
    invent its own key, since a key that only lives in process memory is
    unrecoverable after any restart (permanent data loss for every
    LOCAL-encrypted value). KMS is fail-closed for the same reason: it needs
    both the KEK name and the wrapped DEK, and never invents either.
    """
    if backend is FieldCipherBackend.LOCAL:
        if local_key is None:
            raise ValueError("LOCAL field cipher requires a key (set FIELD_CIPHER_LOCAL_KEY)")
        return LocalFieldCipher(local_key)
    if not kms_key_name:
        raise ValueError("FieldCipherBackend.KMS requires kms_key_name (set KMS_KEY_NAME)")
    if not kms_wrapped_dek:
        raise ValueError("FieldCipherBackend.KMS requires kms_wrapped_dek (set KMS_WRAPPED_DEK)")
    return KmsFieldCipher(kms_key_name, kms_wrapped_dek)


def normalize_e164(value: str) -> str:
    """Strip everything but digits and `+`, then ensure a leading `+`, so
    `+1 (415) 555-0100`, `1-415-555-0100`, and `+14155550100` all blind-index
    to the same value."""
    if not value:
        raise ValueError("normalize_e164 requires a non-empty number")
    stripped = _E164_ALLOWED.sub("", value.strip())
    if not stripped.startswith("+"):
        stripped = "+" + stripped
    return stripped


def blind_index(value: str, key: bytes) -> str:
    """Deterministic HMAC-SHA256 of the normalized E.164 number, hex-encoded.
    Keyed separately from the encryption DEK (design D2) — the index reveals
    nothing about the number without this key, but two rows for the same
    caller always index identically, so an exact-match lookup (or
    right-to-erasure "find every row for this number") never needs to
    decrypt.
    """
    normalized = normalize_e164(value)
    return hmac.new(key, normalized.encode("utf-8"), hashlib.sha256).hexdigest()
