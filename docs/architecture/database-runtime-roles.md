# Database runtime roles

| Role | Owns schema? | Intended access |
| --- | --- | --- |
| `platform_migrator` | migration-only | Alembic DDL and controlled data migrations; never an app DSN. |
| `platform_web` | no | User-facing CRM, messaging, live preferences, and read models under tenant/user context. |
| `platform_messaging` | no | Messaging provider metadata, inbox/outbox, message/campaign jobs. |
| `platform_voice` | no | Preserved voice sessions/campaign execution, append-only session events, bounded contact/object linkage, and insert-only audit/outbox production. |
| `platform_worker` | no | Claims explicitly granted durable work across bounded domains. |
| `platform_readonly` | no | Audited operational views without credential ciphertext. |

Historical `oron_sessions_app` and `oron_tenancy_app` remain because old Or-on
revisions and runtime packages depend on them. They coexist during migration and
are removed only after application parity and live privilege tests.

Every runtime role is `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
NOBYPASSRLS`. Passwords are provisioned outside migration SQL. Object ownership
remains with the migration owner. Default privileges are not made public.

Phase 2B inspected `pg_roles`, schema/table/function privileges, RLS bypass,
attempted runtime DDL, and forbidden cross-domain reads on PostgreSQL 18.6. The
prepared successor and historical roles exist, runtime roles are unprivileged,
normal roles cannot perform DDL, and voice/messaging domain separation passed.
Phase 5 grants `platform_voice` CRUD only on retained session/campaign execution
tables, read/insert on append-only `session_events`, and read/insert on the
tenant-scoped audit/outbox boundaries. It receives no messaging-table access and
cannot update or publish outbox records.
