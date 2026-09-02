"""Load or-on secrets from GCP Secret Manager into the environment.

Convention: an env var ``SECRET__<NAME>`` holds a Secret Manager reference; at
startup its payload is fetched (via ADC — the VM/pod service account, no key
files) and placed in ``<NAME>``, which the existing pydantic ``validation_alias``
settings then read unchanged. An explicit ``<NAME>`` always wins, so dev/local
never needs Secret Manager.

The reference is either a full resource name
(``projects/P/secrets/S/versions/latest``) or a bare secret id, in which case it
is expanded with ``GOOGLE_CLOUD_PROJECT`` and the ``latest`` version.
"""

import os
from collections.abc import MutableMapping

_PREFIX = "SECRET__"


def resolve_secret(resource_name: str, *, client=None) -> str:
    """Return the decoded payload of a Secret Manager secret version."""
    if client is None:  # pragma: no cover - exercised only against real GCP
        from google.cloud import secretmanager

        client = secretmanager.SecretManagerServiceClient()
    response = client.access_secret_version(name=resource_name)
    return response.payload.data.decode("utf-8")


def _resource_name(ref: str, project: str | None) -> str:
    if "/" in ref:
        return ref  # already a full resource name
    if not project:
        raise ValueError(f"secret id {ref!r} needs GOOGLE_CLOUD_PROJECT to build a resource name")
    return f"projects/{project}/secrets/{ref}/versions/latest"


def hydrate_env_from_secret_manager(
    environ: MutableMapping[str, str] | None = None, *, client=None, project: str | None = None
) -> list[str]:
    """Resolve every ``SECRET__<NAME>`` reference into ``<NAME>`` (unless already
    set). Returns the names that were hydrated. Call once at process start,
    before settings load."""
    environ = os.environ if environ is None else environ
    project = project or environ.get("GOOGLE_CLOUD_PROJECT")
    refs = {
        key.removeprefix(_PREFIX): value
        for key, value in environ.items()
        if key.startswith(_PREFIX) and value
    }
    hydrated: list[str] = []
    for name, ref in refs.items():
        if environ.get(name):
            continue  # explicit value wins
        environ[name] = resolve_secret(_resource_name(ref, project), client=client)
        hydrated.append(name)
    return hydrated


__all__ = ["resolve_secret", "hydrate_env_from_secret_manager"]
__version__ = "0.1.0"
