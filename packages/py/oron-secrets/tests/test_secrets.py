from types import SimpleNamespace

from oron_secrets import hydrate_env_from_secret_manager, resolve_secret


class FakeClient:
    def __init__(self, mapping: dict[str, str]):
        self._mapping = mapping
        self.requested: list[str] = []

    def access_secret_version(self, name: str):
        self.requested.append(name)
        return SimpleNamespace(payload=SimpleNamespace(data=self._mapping[name].encode()))


def test_resolve_secret_decodes_payload():
    client = FakeClient({"projects/p/secrets/s/versions/latest": "shh"})
    assert resolve_secret("projects/p/secrets/s/versions/latest", client=client) == "shh"


def test_hydrate_builds_resource_from_short_id_and_sets_var():
    env = {
        "GOOGLE_CLOUD_PROJECT": "jpost",
        "SECRET__SESSIONS_API_KEY": "oron-dispatcher-key",
    }
    client = FakeClient({"projects/jpost/secrets/oron-dispatcher-key/versions/latest": "svc-key"})

    hydrated = hydrate_env_from_secret_manager(env, client=client)

    assert hydrated == ["SESSIONS_API_KEY"]
    assert env["SESSIONS_API_KEY"] == "svc-key"


def test_hydrate_accepts_full_resource_name():
    env = {"SECRET__DATABASE_URL": "projects/p/secrets/db/versions/3"}
    client = FakeClient({"projects/p/secrets/db/versions/3": "postgresql://x"})

    hydrate_env_from_secret_manager(env, client=client)

    assert env["DATABASE_URL"] == "postgresql://x"


def test_hydrate_does_not_override_explicit_value():
    env = {
        "GOOGLE_CLOUD_PROJECT": "jpost",
        "SESSIONS_API_KEY": "already-set",
        "SECRET__SESSIONS_API_KEY": "oron-dispatcher-key",
    }
    client = FakeClient({})

    hydrated = hydrate_env_from_secret_manager(env, client=client)

    assert hydrated == []
    assert env["SESSIONS_API_KEY"] == "already-set"
    assert client.requested == []  # explicit value wins → no SM call


def test_hydrate_noop_without_refs():
    env = {"LIVEKIT_API_SECRET": "plain"}
    assert hydrate_env_from_secret_manager(env, client=FakeClient({})) == []
