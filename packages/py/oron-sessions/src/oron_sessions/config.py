from oron_db import DbRole
from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import URL

from oron_sessions.crypto import FieldCipherBackend

DRIVER = "postgresql+asyncpg"


class Settings(BaseSettings):
    """Config for the sessions app.

    The two DSNs differ only by role, so they are configured as shared parts
    (`DB_HOST`/`DB_PORT`/`DB_NAME`) plus a password per role, and composed. A
    full `DATABASE_URL`/`CONTROL_DATABASE_URL` still wins when set — that is how
    prod supplies them today, via `SECRET__…`. Neither form may half-build a
    DSN: parts too incomplete to compose, with no override, fails at load.
    """

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    enable_real_telephony: bool = Field(default=False, validation_alias="ENABLE_REAL_TELEPHONY")

    # Full DSNs, when something supplies them whole. Read through the
    # `database_url` / `control_database_url` properties, never directly.
    database_url_override: str | None = Field(default=None, validation_alias="DATABASE_URL")
    control_database_url_override: str | None = Field(
        default=None, validation_alias="CONTROL_DATABASE_URL"
    )

    # The parts both DSNs share. One host to change, not two.
    db_host: str | None = Field(default=None, validation_alias="DB_HOST")
    db_port: int = Field(default=5432, validation_alias="DB_PORT")
    db_name: str | None = Field(default=None, validation_alias="DB_NAME")
    # One password per role: a leaked sessions DSN must not also be a login for
    # the role that holds `api_keys`. Resolvable via SECRET__DB_*_PASSWORD.
    db_sessions_password: SecretStr | None = Field(
        default=None, validation_alias="DB_SESSIONS_PASSWORD"
    )
    db_tenancy_password: SecretStr | None = Field(
        default=None, validation_alias="DB_TENANCY_PASSWORD"
    )

    # Not hardcoded: under host networking LiveKit's webhook wants 8080 too.
    port: int = Field(default=8080, validation_alias="PORT")

    # How long a session may sit at `started` before the sweeper calls it failed.
    # Must exceed the longest plausible call, or live calls get failed underneath us.
    stale_session_minutes: int = Field(default=120, validation_alias="STALE_SESSION_MINUTES")

    # Which FieldCipher backend encrypts from_number/to_number. v1 ships on
    # `local` (AES-256-GCM, key supplied via Secret Manager — see
    # field_cipher_local_key below); `kms` unwraps the same kind of DEK from
    # Cloud KMS instead (see KmsFieldCipher) and needs kms_key_name +
    # kms_wrapped_dek.
    field_cipher_backend: FieldCipherBackend = Field(
        default=FieldCipherBackend.LOCAL, validation_alias="FIELD_CIPHER_BACKEND"
    )
    # Base64-encoded 32-byte AES key. LOCAL backend only. Resolvable via
    # SECRET__FIELD_CIPHER_LOCAL_KEY (oron_secrets convention) — this is how
    # prod supplies it today, ahead of the KMS backend landing.
    field_cipher_local_key: SecretStr | None = Field(
        default=None, validation_alias="FIELD_CIPHER_LOCAL_KEY"
    )
    # Base64-encoded HMAC key for from_number_bidx. Kept separate from the
    # encryption key/DEK (design D2). Resolvable via SECRET__BLIND_INDEX_KEY.
    blind_index_key: SecretStr | None = Field(default=None, validation_alias="BLIND_INDEX_KEY")
    # The campaign dialer posts to the dispatcher's `/calls`. Unset means no
    # dialer runs — campaigns can still be authored and uploaded, nothing rings.
    dispatcher_url: str | None = Field(default=None, validation_alias="DISPATCHER_URL")
    outbound_api_token: SecretStr | None = Field(
        default=None, validation_alias="OUTBOUND_API_TOKEN"
    )
    campaign_poll_seconds: float = Field(default=5.0, validation_alias="CAMPAIGN_POLL_SECONDS")
    # Simultaneous campaign calls per tenant, across all of its campaigns. This
    # is the trunk/agent-fleet ceiling; per-campaign `max_concurrent` is the
    # author's pacing choice and cannot exceed it.
    campaign_max_concurrent_per_tenant: int = Field(
        default=20, validation_alias="CAMPAIGN_MAX_CONCURRENT_PER_TENANT"
    )

    # KMS backend only: full resource name of the KEK,
    # e.g. projects/P/locations/L/keyRings/R/cryptoKeys/K.
    kms_key_name: str | None = Field(default=None, validation_alias="KMS_KEY_NAME")
    # KMS backend only: the base64 DEK, wrapped under that KEK. Safe at rest in
    # wrapped form; resolvable via SECRET__KMS_WRAPPED_DEK.
    kms_wrapped_dek: SecretStr | None = Field(default=None, validation_alias="KMS_WRAPPED_DEK")

    def _dsn(self, override: str | None, role: DbRole, password: SecretStr | None) -> str:
        if override:
            # Deployment env files use the driverless form every other service
            # reads; the async engine needs the asyncpg dialect named, and would
            # otherwise try (and fail) to import psycopg2 on every sweep.
            for prefix in ("postgresql://", "postgres://"):
                if override.startswith(prefix):
                    return f"{DRIVER}://{override.removeprefix(prefix)}"
            return override
        parts = {
            "DB_HOST": self.db_host,
            "DB_NAME": self.db_name,
            f"DB_{role.name}_PASSWORD": password,
        }
        missing = [name for name, value in parts.items() if not value]
        if missing:
            raise ValueError(
                f"cannot build the {role} DSN: set {', '.join(missing)}, or the full URL"
            )
        return URL.create(
            DRIVER,
            username=str(role),
            password=password.get_secret_value() if password else None,
            host=self.db_host,
            port=self.db_port,
            database=self.db_name,
        ).render_as_string(hide_password=False)

    @property
    def database_url(self) -> str:
        return self._dsn(self.database_url_override, DbRole.SESSIONS, self.db_sessions_password)

    @property
    def control_database_url(self) -> str:
        return self._dsn(
            self.control_database_url_override, DbRole.TENANCY, self.db_tenancy_password
        )

    @model_validator(mode="after")
    def _dsns_are_buildable(self) -> Settings:
        """Fail at load, not at the first connection three layers deeper."""
        _ = (self.database_url, self.control_database_url)
        return self


def load_settings() -> Settings:
    return Settings()
