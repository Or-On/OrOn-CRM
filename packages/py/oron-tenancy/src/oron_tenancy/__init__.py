"""Control plane for or-on: tenants, phone numbers, and API keys.

Deliberately separate from oron-sessions. This is the administrative plane —
who exists and who may call — with a different audience (operators, the
dispatcher), a different auth posture (minting a key is far more sensitive than
writing a call row), and a different blast radius. Sessions is the data plane.

Shares a database, so `sessions.tenant_id` keeps its foreign key to `tenants.id`.
"""

from oron_tenancy.config import SipSettings, build_sip_provisioner
from oron_tenancy.models import (
    ApiKey,
    ApiKeyPublic,
    PhoneNumber,
    PhoneNumberCreate,
    PhoneNumberPublic,
    Tenant,
    TenantCreate,
    TenantPublic,
)
from oron_tenancy.provisioner import LiveKitSipProvisioner, SipProvisioner
from oron_tenancy.router import router
from oron_tenancy.security import (
    generate_api_key,
    hash_key,
    require_service_key,
    require_tenant,
    resolve_tenant,
)

__all__ = [
    "ApiKey",
    "ApiKeyPublic",
    "LiveKitSipProvisioner",
    "PhoneNumber",
    "PhoneNumberCreate",
    "PhoneNumberPublic",
    "SipProvisioner",
    "SipSettings",
    "Tenant",
    "TenantCreate",
    "TenantPublic",
    "build_sip_provisioner",
    "generate_api_key",
    "hash_key",
    "require_service_key",
    "require_tenant",
    "resolve_tenant",
    "router",
    "__version__",
]
__version__ = "0.1.0"
