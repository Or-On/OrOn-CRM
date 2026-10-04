# Compiled-container acceptance

All five application images were built from an exact Git archive of `0331908b56edf737bf970c7bb5fa174450310eb8`. Running DEV remains on `42eebac2`; no image was published and no live deployment occurred. Later test-isolation and documentation commits do not alter production application source.

| Image | Immutable local image ID | Build seconds |
|---|---|---|
| web | `sha256:1312f7244ad0471fda82e8aee8e5f9de894978864d50fe158586dcb88fedbdc7` | 98.293 |
| messaging-worker | `sha256:121b1461853eafaf831bc7b18b2e8d476bcb3857e0d42422c42a3b7ff8c61acc` | 57.367 |
| control-api | `sha256:04d367194779105c23856d120dc0863f5a4c3341c9f586edfaa8a66413094a81` | 91.982 |
| dispatcher | `sha256:9a107188f85e5b0b47eaa9568c884025cb3bc220a46c3d72d68156fd8c921465` | 58.434 |
| migrator | `sha256:96e9efa710d79c4cf416694ed36c831f57d82724b33f7082ad8508e670272401` | 36.336 |

## Main isolated stack

The existing production Compose topology ran under the separately owned `oron-poc-rescue-stack` project, with loopback HTTP on13880, fictional private configuration, real-provider flags false and no seeded user accounts. The original developer PostgreSQL container and live services were not modified.

| Executed check | Observed result | Limit |
|---|---|---|
| Startup and migration | All six long-running containers healthy; packaged migration reached `9e43a5b02d81`; zero unsafe runtime roles | Login health is web liveness, not proof of all authenticated workflows |
| Application identity | All four running app image IDs match the033 archive receipts; web/worker UID1000, Python UID100; readonly roots and cap_drop ALL, no added capabilities | Migrator and temporary fixture ownership setup are separate privileged operations |
| Shared private objects | Worker wrote an object and web read/removed the exact bytes | Fictional content only |
| Caddy and signed LiveKit ingress | Unsigned401; signed200; duplicate200; tampered401; one durable receipt; public outbound control404 | Locally generated SDK signature, no actual provider call |
| Control API stopped | Web login200, worker ready and signed callback still accepted | Does not certify every control-dependent business tool |
| Dispatcher stopped | Web login200 and worker ready; callback502, then normal signed admission after restart | No zero-downtime callback claim while dispatcher is unavailable |
| PostgreSQL stopped | Both Python liveness200/readiness503; worker health exits1; signed callback503; web login remains200 as liveness only | Retriable failure, not a false successful acknowledgement |
| Recovery and service restart | All health/role/schema/object checks pass again; signed/deduplicated/tampered callback checks repeated | Controlled local fault, no production availability measurement |
| Linux accounting spool | Eight tests passed, zero skipped in the033 worker build stage, including the POSIX symlink case skipped on Windows | Covers filesystem spool behavior, not external billing acceptance |

The ownership setup initially failed because `cap_drop: ALL` also applied to its temporary root container. The helper now adds only CHOWN/FOWNER for that one-shot command; inspection confirms every running app still has all capabilities dropped.

## Encrypted restore

The final candidate dump was 1,790,630 bytes and the drill completed in **29.689 seconds**. A separately restored database matched schema/head/table counts and FORCE RLS. A restricted runtime role could see only its fictional contact; an encrypted session field decrypted with the independently retained fictional key, and both wrong-key and wrong-tenant attempts were rejected. The synthetic object archive checksum also matched.

This is a same-host Docker restore of a small fictional dataset. It does not prove production-key escrow, a separate-VM disaster recovery time, production data volume or replay of restored workers. The actual production escrow references exist, but authorized payload access was denied; their match remains unknown.

## Previous images and forward recovery

The exact four deployed42eebac2 images were pulled by immutable digest and exercised in a separate internally networked compatibility project. Twelve authenticated HTTP/CRM/tenant-denial checks, voice admission/control/finalization function checks and signed Caddy callback checks passed against the new schema. See [RUNBOOK.md](RUNBOOK.md) for precise receipts and forward-recovery results.

The old worker failed all four new Coexistence types on8d. Additive9e preserves its legacy claim contract: ordinary text is processed and the four new types remain untouched for a capable worker. The final packaged033 migrator contains exactly the migration bytes used in that comparison.

**Old web remains ineligible after Coexistence callbacks are enabled.** Its actual parser classifies historical media as fresh ingress and discards the original field provenance. Keep a capable ingress during any later rollback; do not infer whole-release compatibility from the successful ordinary-flow checks. Coexistence has not been activated.

## Evidence

Ignored local receipts: `final-image-*.json`, `linux-accounting-spool.log`, `container-stack/{start,dependency,dispatcher-dependency,database-fault,restart,recover,check,final-runtime-identity}.json`, and `previous-image-compat/`. Detailed logs retain initial failures and corrected runs. No secret values appear in this document.
