# Python service scope

- These entrypoints are future hosts for retained Or-on packages, not replacements.
- Preserve Or-on package identities and dependency direction during later imports.
- Use typed startup configuration, dependency injection, structured lifecycle,
  graceful shutdown, and structured redacted logging.
- Do not use mutable module-global service state.
- `/health/live` reports process liveness; `/health/ready` must probe mandatory
  dependencies and fail when PostgreSQL is unavailable.
- Tests and ordinary development must not invoke real telephony or providers.
