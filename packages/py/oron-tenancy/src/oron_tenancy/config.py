from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from oron_tenancy.provisioner import LiveKitSipProvisioner, SipProvisioner


class SipSettings(BaseSettings):
    """LiveKit SIP config for DID admission. The LiveKit connection is optional:
    without it the app runs with no provisioner and registration fails closed
    (503) rather than registering a number that would never route.

    The inbound trunk is identified by **name**, not id. LiveKit assigns the id
    and can reassign it, so a stored id drifts; the name is what we declare, and
    the id is resolved from it when needed. `inbound_trunk_name` has a default, so
    it is the LiveKit credentials — not the trunk — that decide whether SIP is on.
    """

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    enable_real_telephony: bool = Field(default=False, validation_alias="ENABLE_REAL_TELEPHONY")
    livekit_url: str | None = None
    livekit_api_key: SecretStr | None = None
    livekit_api_secret: SecretStr | None = None
    inbound_trunk_name: str = "oron-inbound"
    # No default: LiveKit reads an unset ACL as "admit everyone", so a forgotten
    # setting must fail at convergence rather than open SIP to the internet.
    inbound_trunk_allowed_addresses: list[str] = []
    sip_allow_any_address: bool = False
    room_prefix: str = "call-"


def build_sip_provisioner(settings: SipSettings | None = None) -> SipProvisioner | None:
    """Construct the LiveKit provisioner from env, or None when SIP is not
    configured (dev without a SIP stack). None makes registration fail closed."""
    s = settings or SipSettings()
    if not s.enable_real_telephony:
        return None
    if not (s.livekit_url and s.livekit_api_key and s.livekit_api_secret):
        return None
    return LiveKitSipProvisioner(
        url=s.livekit_url,
        api_key=s.livekit_api_key.get_secret_value(),
        api_secret=s.livekit_api_secret.get_secret_value(),
        inbound_trunk_name=s.inbound_trunk_name,
        inbound_trunk_allowed_addresses=s.inbound_trunk_allowed_addresses,
        allow_any_address=s.sip_allow_any_address,
        room_prefix=s.room_prefix,
    )
