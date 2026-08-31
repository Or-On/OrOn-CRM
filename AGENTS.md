# Or-On Platform — Codex Instructions

## Repository scope

This repository is the only writable project repository.

The following sibling repositories are read-only upstream references:

- `../or-on`
- `../wacrm`
- `../openlive`

Never modify files in those three upstream repositories.

Never run formatting, dependency installation, migrations, resets, cleanup,
commits, rebases, pushes, or generated-code commands inside an upstream
repository unless the user explicitly authorizes it.

All integrated application code, tests, infrastructure, documentation,
migrations, and configuration must be created inside this repository.

The final project must build and run independently without requiring the
three sibling repositories to remain present.

## Database

PostgreSQL is the only runtime database and source of truth.

Do not introduce:

- Firebase
- Firestore
- Supabase runtime services
- Supabase Auth
- SQLite runtime persistence
- MongoDB
- filesystem JSON as an application database

SQLite is permitted only inside a one-time legacy OpenLive import utility.

## Upstream paths

Use these exact relative paths:

- Or-on: `../or-on`
- WACRM: `../wacrm`
- OpenLive: `../openlive`

## Initial workflow

1. Read `MASTER_PROMPT.md` completely.
2. Audit all three upstream repositories before implementation.
3. Record their URLs, branches, commit SHAs, and licenses.
4. Create the architecture and migration plan.
5. Implement incrementally with tests and coherent commits.
6. Never perform a real telephone call or WhatsApp send without explicit user
   authorization.