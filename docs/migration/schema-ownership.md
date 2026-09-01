# Schema ownership

| Schema/location | Owner | Authority / rule |
| --- | --- | --- |
| Historical public Or-on tables | Voice/control domains | Never relocated for neatness; historical Alembic revisions remain authoritative. |
| `platform` | Cross-domain identity, campaign, credential metadata | Canonical integration records only. |
| `crm` | Contacts, channel identities, tags, fields, notes, pipelines/deals | WACRM behavior adapted to `tenant_id`. |
| `messaging` | Channels, conversations, messages, templates, broadcasts | WACRM messaging semantics without Supabase runtime services. |
| `automation` | Canonical flow definitions/versions/runs | Adapters compile to retained Or-on and WACRM engines later. |
| `agents` | Knowledge/search and later canonical agent persistence | PostgreSQL FTS required; pgvector optional. |
| `live` | OpenLive server-side durable state | Replaces SQLite/JSON runtime persistence. |
| `objects` | Object/media metadata | Bytes remain in mounted storage/GCS. |
| `ops` | Inbox, outbox, jobs, idempotency, import ledger | Durable coordination only; Redis is not authoritative. |
| `audit` | Append-only security/action records | Normal runtime roles cannot update/delete. |

Alembic is the only schema owner and migration authority. TypeScript generated
types/repositories are consumers. No application service owns a separate
database.
