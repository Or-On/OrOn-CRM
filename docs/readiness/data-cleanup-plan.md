# Cleanup and data provenance

Status: no customer-data deletion authorized or performed by this task.

442 pre-existing changed paths were preserved; historical migrations and upstream
licenses remain intact. No framework, ORM, provider engine, database or heavy voice
dependency was removed merely to reduce line count. No upstream file was modified.

Implemented packaging cleanup: exclude ignored local credentials/data, Terraform
state/configuration and nested provider caches from Docker build context; package
public web assets; build worker JavaScript exports rather than relying on runtime
TypeScript stripping inside node_modules. No provider credentials are baked in.

Candidate presentation cleanup: simulation mutations require explicit development
mode. Empty/unavailable runtime dependencies are not converted to fake success.
Historical simulation records still exist in the user's database; they have NOT
been removed or automatically reclassified as real.

## Required data dry run before any deletion

Use a read-only transaction against an explicitly selected database only after
operator review. Identify simulator channels by exact `provider='simulator'`, and
join conversations/messages/jobs/campaign executions by their actual foreign keys
and source metadata. Emit exact IDs and counts to a protected local artifact,
not names, message content, email addresses or phone numbers. Include audit and
financial dependencies; ambiguous provenance is an exclusion, never a heuristic
match. Group deletable test records separately from financial corrections and
retained audit history. Review a current checksum-backed backup/restore drill
before authorizing any material deletion. This report deliberately contains no
invented IDs/counts from an unqueried user database.

Task-owned disposable benchmark databases were removed after measurement; they
contained only generated fictional contacts. The isolated recovery database and
Docker volumes are retained for inspection. Never use `docker system prune`,
recursive workspace deletion, or a developer Compose `down -v` for this cleanup.

Four pre-existing Python formatting failures and three long SQL lines are repaired
mechanically in the candidate; no Or-on migration semantics/revision was changed.
