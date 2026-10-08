# Publication bindings: local verification

Task 6 adds explicit `pinned` and `follow_published` references. Historic references default to pinned. Process policy is stored in the reviewed tenant configuration; canonical agent and retained voice-node policies remain in immutable canonical source. No production configuration was changed.

## Publication and admission

Agent/canonical publication accepts an exact expected version, a UUID request ID and an activation request. It serializes tenant configuration changes, rejects stale authoring bases, clones only approved followers, and uses the existing submit/approve authority. Ordinary managers receive `published_pending_activation`; authorized approval gives `active_for_new_interactions`. Pins and existing conversations/calls remain on their exact snapshot. Retained source publication allocates the next server version and stages a durable operation; activation can be retried after interruption. GET source returns the exact tenant-owned source, revision, base version and editability.

New voice admissions query the current approved configuration using the actual inbound/outbound trigger. Warm and second dispatcher instances select the same new inbound bundle without cache flush; a separately pinned outbound route remains unchanged. Queued work with an old explicit binding must pass current admission validation and may be refused; admitted calls are not restarted. Existing WhatsApp conversations require explicit rebind. Rebind locks its candidate set, increments the existing ownership fence, excludes human-owned and removed conversations, and returns real rebound/skipped counts. Stale counts use the same eligibility predicate.

## Candidate evaluation

When the golden gate is enabled, an operation is prepared with a database-derived digest of its exact candidate, current approved routes, tenant instructions, model/knowledge snapshot and relevant retained sources. The status is `blocked_evaluation` until candidate-specific evidence passes. GET/POST golden evaluation APIs accept `publicationOperationId`; the trusted worker claim includes the immutable candidate and digest. Physical case records must attest that digest. Finalization, activation retries and direct release approval recheck current candidate evidence, approved real anonymized data, evaluator policy, model and knowledge. Synthetic fixtures never authorize publication. A changed candidate/context requires a new request.

The repository provides the trusted database worker protocol, not a standalone physical golden provider worker. An external trusted evaluator must consume the candidate context and execute the physical suite. No real provider suite or production activation was performed in this task. The UI exposes the exact blocked state and candidate evaluation actions; this is not a claim of production readiness.

## Evidence

- Fresh owned PostgreSQL 18 database, migrations through `a3ae6075bf24`; application mutations/read paths exercised under `platform_web`, `platform_voice`, and `platform_agent_evaluation` roles.
- Seven publication PostgreSQL tests: concurrent idempotent publication, concurrent agent/retained publications preserving both references, tenant isolation, stale-base and pending-review rollback, ordinary-manager approval denial, separate inbound/outbound pins, retained publication/retry, immutable existing calls/chats, removed-chat exclusion, candidate job idempotency, unrelated candidate rejection, synthetic receipt rejection, trusted claim payload/digest attestation, and stale tenant context rejection.
- Three Python PostgreSQL tests: exact source permissions/server version allocation/retry/concurrency and real warm/second dispatcher admission, and immutable admitted provenance plus per-attempt hash attribution.
- Nine reset/WhatsApp eligibility PostgreSQL tests passed after rebind count changes. The broader leads suite was refused by its owned-database-name guard (requires `oron_ui_preview_*`, while this owned fixture is `oron_crm_*`); the guard was preserved. Integration must run that suite against its correctly named owned fixture.
- Nine focused web API tests passed; five generated API client tests passed including exact prompt query selectors. CRM/API-client typechecks, focused ESLint, Python Ruff and migration graph checks passed.
- The new evidence migration upgraded and downgraded before test evidence existed. Once evidence exists its downgrade deliberately requires archival, preventing silent receipt destruction.

No pre-change failing reproduction of the complete feature was captured. Local intermediate failures (migration multi-statement execution, privilege wrapper, source client arity, stricter lint and fixture-name guard) were observed and corrected or explicitly retained as limitations. No local HTTP server was started after prior automatic review denied server startup. Browser screenshots, physical audio/provider delivery and production release are not included in this evidence.

Global NULL-tenant retained flows remain hidden by the established tenant predicate. There is no authorized packaged catalog/copy endpoint in this implementation; those sources are not silently granted cross-tenant visibility.
