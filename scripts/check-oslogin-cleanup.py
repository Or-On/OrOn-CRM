"""Verify absence of the exact temporary public key, without printing keys."""

import json
import sys
from pathlib import Path


def verify(public_key: str, profile: object) -> None:
    expected = public_key.split()[:2]
    if len(expected) != 2:
        raise ValueError("Invalid temporary public key")
    if not isinstance(profile, list):
        raise ValueError("Expected the OS Login SSH-key list")
    for entry in profile:
        if not isinstance(entry, dict):
            raise ValueError("Unrecognized OS Login key-list entry")
        # gcloud lists additionalProperties as {key: fingerprint, value: SshPublicKey}.
        value = entry.get("value", entry)
        if not isinstance(value, dict) or not isinstance(value.get("key"), str):
            raise ValueError("Unrecognized OS Login key-list entry")
        actual = value["key"].split()[:2]
        if len(actual) != 2 or not actual[0].startswith(("ssh-", "ecdsa-", "sk-")):
            raise ValueError("Unrecognized OS Login public key")
        if actual == expected:
            raise ValueError("Temporary OS Login key remains registered; TTL is fallback")


if __name__ == "__main__":
    try:
        verify(Path(sys.argv[1]).read_text(), json.loads(Path(sys.argv[2]).read_text()))
    except (ValueError, OSError, IndexError) as error:
        sys.exit(str(error))
    print("Temporary OS Login public key absence verified")
