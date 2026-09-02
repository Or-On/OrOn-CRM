import base64
import uuid
from types import SimpleNamespace

import pytest
from cryptography.exceptions import InvalidTag
from oron_sessions.crypto import (
    FieldCipherBackend,
    KmsFieldCipher,
    LocalFieldCipher,
    blind_index,
    build_field_cipher,
    normalize_e164,
)

TEST_KEY = bytes(range(32))  # deterministic 32-byte key, test-only
TENANT = uuid.uuid4()
WRAPPED_DEK = b"kms-wrapped-dek-bytes"


class FakeKmsClient:
    """Stands in for KeyManagementServiceClient: unwraps to a known DEK and
    counts calls, so tests never reach GCP."""

    def __init__(self, dek: bytes):
        self._dek = dek
        self.decrypt_calls: list[dict] = []

    def decrypt(self, request: dict):
        self.decrypt_calls.append(request)
        return SimpleNamespace(plaintext=self._dek)


def test_round_trips():
    cipher = LocalFieldCipher(TEST_KEY)
    ct = cipher.encrypt(TENANT, "+14155550100")
    assert ct != "+14155550100"
    assert cipher.decrypt(TENANT, ct) == "+14155550100"


def test_ciphertext_has_v1_prefix():
    cipher = LocalFieldCipher(TEST_KEY)
    assert cipher.encrypt(TENANT, "+14155550100").startswith("v1:")


def test_two_encryptions_of_the_same_value_differ():
    # Fresh random nonce per call — required for GCM: reusing a nonce with the
    # same key breaks confidentiality.
    cipher = LocalFieldCipher(TEST_KEY)
    assert cipher.encrypt(TENANT, "+14155550100") != cipher.encrypt(TENANT, "+14155550100")


def test_tampered_ciphertext_fails_to_decrypt():
    # Flip a byte in the decoded payload (not the base64 text directly) so
    # the tamper always corrupts the GCM tag/ciphertext and never just breaks
    # base64 padding — that would raise binascii.Error instead of InvalidTag.
    cipher = LocalFieldCipher(TEST_KEY)
    ct = cipher.encrypt(TENANT, "+14155550100")
    raw = bytearray(base64.b64decode(ct.removeprefix("v1:")))
    raw[-1] ^= 0xFF
    tampered = "v1:" + base64.b64encode(bytes(raw)).decode("ascii")
    with pytest.raises(InvalidTag):
        cipher.decrypt(TENANT, tampered)


def test_wrong_key_fails_to_decrypt():
    ct = LocalFieldCipher(TEST_KEY).encrypt(TENANT, "+14155550100")
    other_key = bytes(range(1, 33))
    with pytest.raises(InvalidTag):
        LocalFieldCipher(other_key).decrypt(TENANT, ct)


def test_wrong_tenant_fails_to_decrypt():
    # tenant_id is bound as AES-GCM AAD: a ciphertext copied into another
    # tenant's row must not decrypt under that tenant's id.
    cipher = LocalFieldCipher(TEST_KEY)
    ct = cipher.encrypt(TENANT, "+14155550100")
    other_tenant = uuid.uuid4()
    with pytest.raises(InvalidTag):
        cipher.decrypt(other_tenant, ct)


def test_rejects_bad_key_length():
    with pytest.raises(ValueError):
        LocalFieldCipher(b"short")


def test_normalize_e164_strips_formatting():
    assert normalize_e164("+1 (415) 555-0100") == "+14155550100"
    assert normalize_e164("14155550100") == "+14155550100"


def test_blind_index_is_deterministic_for_equivalent_numbers():
    key = b"k" * 32
    assert blind_index("+14155550100", key) == blind_index("+1 (415) 555-0100", key)


def test_blind_index_differs_by_key():
    assert blind_index("+14155550100", b"k" * 32) != blind_index("+14155550100", b"j" * 32)


def test_build_field_cipher_local_backend_returns_local_cipher():
    cipher = build_field_cipher(FieldCipherBackend.LOCAL, local_key=TEST_KEY)
    assert isinstance(cipher, LocalFieldCipher)
    ct = cipher.encrypt(TENANT, "+14155550100")
    assert cipher.decrypt(TENANT, ct) == "+14155550100"


def test_build_field_cipher_local_backend_requires_key():
    with pytest.raises(ValueError):
        build_field_cipher(FieldCipherBackend.LOCAL, local_key=None)


def test_build_field_cipher_kms_backend_requires_key_name():
    with pytest.raises(ValueError):
        build_field_cipher(FieldCipherBackend.KMS, kms_wrapped_dek=WRAPPED_DEK)


def test_build_field_cipher_kms_backend_requires_wrapped_dek():
    with pytest.raises(ValueError):
        build_field_cipher(FieldCipherBackend.KMS, kms_key_name="projects/p/…/cryptoKeys/k")


def _kms_cipher(client: FakeKmsClient) -> KmsFieldCipher:
    return KmsFieldCipher("projects/p/…/cryptoKeys/k", WRAPPED_DEK, client=client)


def test_kms_round_trips():
    cipher = _kms_cipher(FakeKmsClient(TEST_KEY))
    ct = cipher.encrypt(TENANT, "+14155550100")
    assert ct.startswith("v1:")
    assert cipher.decrypt(TENANT, ct) == "+14155550100"


def test_kms_and_local_interoperate_on_the_same_dek():
    # Same DEK, same format: whichever backend is configured, previously
    # written rows must keep decrypting.
    kms = _kms_cipher(FakeKmsClient(TEST_KEY))
    local = LocalFieldCipher(TEST_KEY)
    assert kms.decrypt(TENANT, local.encrypt(TENANT, "+14155550100")) == "+14155550100"
    assert local.decrypt(TENANT, kms.encrypt(TENANT, "+14155550100")) == "+14155550100"


def test_kms_unwraps_the_dek_exactly_once():
    # The hot path must never call KMS — one unwrap at construction, then local
    # AES-GCM for every field.
    client = FakeKmsClient(TEST_KEY)
    cipher = _kms_cipher(client)
    for _ in range(5):
        cipher.decrypt(TENANT, cipher.encrypt(TENANT, "+14155550100"))
    assert len(client.decrypt_calls) == 1
    assert client.decrypt_calls[0]["ciphertext"] == WRAPPED_DEK


def test_kms_wrong_tenant_fails_to_decrypt():
    cipher = _kms_cipher(FakeKmsClient(TEST_KEY))
    ct = cipher.encrypt(TENANT, "+14155550100")
    with pytest.raises(InvalidTag):
        cipher.decrypt(uuid.uuid4(), ct)


def test_kms_tampered_ciphertext_fails_to_decrypt():
    cipher = _kms_cipher(FakeKmsClient(TEST_KEY))
    raw = bytearray(base64.b64decode(cipher.encrypt(TENANT, "+14155550100").removeprefix("v1:")))
    raw[-1] ^= 0xFF
    with pytest.raises(InvalidTag):
        cipher.decrypt(TENANT, "v1:" + base64.b64encode(bytes(raw)).decode("ascii"))
