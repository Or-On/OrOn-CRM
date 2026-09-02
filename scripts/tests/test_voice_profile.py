from __future__ import annotations

import pytest

from scripts.verify_voice_profile import (
    VoiceProfileVerificationError,
    validate_local_credentials,
)


def test_voice_profile_rejects_missing_or_short_credentials() -> None:
    with pytest.raises(VoiceProfileVerificationError, match="API_KEY"):
        validate_local_credentials("", "x" * 32)
    with pytest.raises(VoiceProfileVerificationError, match="32 characters"):
        validate_local_credentials("local-key", "short")


def test_voice_profile_rejects_upstream_placeholder_pair() -> None:
    with pytest.raises(VoiceProfileVerificationError, match="placeholder"):
        validate_local_credentials("devkey", "secret")


def test_voice_profile_accepts_generated_local_credentials() -> None:
    validate_local_credentials("local-key", "x" * 32)


@pytest.mark.parametrize("api_key", ["bad:key", "bad key", "bad\tkey"])
def test_voice_profile_rejects_key_delimiter_and_whitespace(api_key: str) -> None:
    with pytest.raises(VoiceProfileVerificationError, match="unsupported"):
        validate_local_credentials(api_key, "x" * 32)
