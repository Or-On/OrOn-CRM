# Retired migration artifacts

Files in this directory are provenance records and are not an executable
Alembic version location.

`0001_platform_foundation.py` was the Phase 1 offline migration proof. Phase 1
progress evidence records that Docker/PostgreSQL was unavailable and that live
`alembic upgrade`/`alembic current` never ran. Phase 2A therefore removed it
from the active graph without rewriting Git history and recreated its useful
schema content after the preserved Or-on head.
