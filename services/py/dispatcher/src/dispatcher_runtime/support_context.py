"""Compatibility imports; the pure composer is shared with the control API."""

from oron_common.voice_instructions import (
    BUSINESS_DESCRIPTION_MAX_LENGTH as BUSINESS_DESCRIPTION_MAX_LENGTH,
)
from oron_common.voice_instructions import (
    DEFAULT_AGENT_ROLE_TITLE as DEFAULT_AGENT_ROLE_TITLE,
)
from oron_common.voice_instructions import (
    GLOBAL_VOICE_POLICY as GLOBAL_VOICE_POLICY,
)
from oron_common.voice_instructions import (
    PRODUCT_OR_SERVICE_MAX_LENGTH as PRODUCT_OR_SERVICE_MAX_LENGTH,
)
from oron_common.voice_instructions import (
    TENANT_SUPPORT_PROFILE_MAX_BYTES as TENANT_SUPPORT_PROFILE_MAX_BYTES,
)
from oron_common.voice_instructions import (
    TenantSupportProfile as TenantSupportProfile,
)
from oron_common.voice_instructions import (
    TenantTerminology as TenantTerminology,
)
from oron_common.voice_instructions import (
    compile_voice_runtime_prompt as compile_voice_runtime_prompt,
)
from oron_common.voice_instructions import (
    normalize_agent_role_title as normalize_agent_role_title,
)
from oron_common.voice_instructions import (
    support_profile_from_database as support_profile_from_database,
)
from oron_common.voice_instructions import (
    terminology_quality_overrides as terminology_quality_overrides,
)
