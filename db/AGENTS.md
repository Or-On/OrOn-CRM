# Database scope

- PostgreSQL is the only runtime database and Alembic is the only migration
  authority.
- Every schema change is a reviewed Alembic revision; CI must have one head.
- Migrations must be deterministic and support clean upgrade from base.
- Preserve Or-on's RLS and transaction-local context philosophy. Application
  services never run as the migrator or a superuser.
- Seeds are deterministic, idempotent, fictional, and contain no PII.
- `importers/` may later contain isolated one-time SQLite readers; runtime code may
  not depend on them.
