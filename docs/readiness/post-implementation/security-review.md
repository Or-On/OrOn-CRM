# Security and data-integrity review

Review baseline: OWASP Application Security Verification Standard 5.0.0, the
current stable release published by OWASP in May 2025. Sources:
[OWASP ASVS repository](https://github.com/OWASP/ASVS) and
[ASVS releases](https://github.com/OWASP/ASVS/releases). This is a risk-based
engineering review, not ASVS certification, penetration testing or a legal
compliance claim.

## Control-area disposition

| Area | Source evidence and disposition | Status |
| --- | --- | --- |
| Authentication/session | Server-side sessions, cookie/session rotation, origin checks and fresh membership/tenant context are covered by auth and PostgreSQL tests. Public MFA/recovery/session-management decisions remain open. | **PASS** for implemented controls; **BLOCKED** only for authenticated DEV acceptance and open advanced controls |
| Authorization/multi-tenancy | Canonical role/permission decision, super-admin separation, route permission checks, tenant-bound SQL, forced RLS and composite FKs. Sensitive documents received dedicated permissions. | **PASS** in unit/static contracts and PostgreSQL runtime-role/RLS tests; authenticated DEV role journeys remain **BLOCKED** |
| Protected customer data | National IDs stay strings, are encrypted and masked; reveal/write/clear requires sensitive permission. Identity documents use matching object permissions. Audit metadata avoids raw values. | **PASS** locally; key rotation/loss drill **BLOCKED** |
| Request/webhook safety | WhatsApp HMAC verification, replay receipts, trusted channel mapping and 2 MiB body bound; Stripe signed webhook/tenant event binding. | **PASS** simulated; real provider ordering/reconciliation **BLOCKED** |
| File/object safety | Root-confined names, no arbitrary URLs, checksum/size/MIME plus PNG/JPEG/WebP/PDF/text structure, dimension limit, private authorization and safe headers. Unsupported content fails closed. | **PASS** for allowlisted contract; malware scanning and crash-only orphan reconciliation remain **OPEN** |
| Injection/browser controls | Parameterized SQL, schema validation, no HTML provider rendering, safe spreadsheet cell handling, nosniff/frame/cross-origin download headers and server-only secrets. | **PASS** by source/tests; no broad hostile scan was run against shared systems |
| OAuth/external calls | Server-owned credentials, redirect/state contracts and capability/readiness distinctions; local disconnect revokes channels, tombstones tokens, clears pending state and audits under fresh tenant-manager authorization. | **PASS** locally; real callback/upstream revoke/refresh behavior **BLOCKED** |
| Dependency integrity | Frozen pnpm/uv locks, peer check, pnpm audit and repository-controlled pip-audit policy. Five images bind OCI revision; release deploy binds exact digests. | **PASS** with one time-bounded Python advisory exception through 2026-10-13 |
| Release/backup | Safe archive entry validation, source/digest check, writer drain, pre-migration complete bundle, exact running-image verification and prior-profile rollback. | **PASS** in source tests and authorized DEV deployment; isolated restore/off-host retention **BLOCKED** |

## Dependency result detail

- `pnpm audit --audit-level critical`: no known vulnerabilities. The command's
  threshold is not treated as a complete risk assessment; the returned advisory
  set was empty.
- `scripts/pip_audit.py`: no unexcepted known vulnerability; repository exception
  `PYSEC-2026-3740` expires 2026-10-13 and must be removed or renewed with review.
  Internal editable packages are absent from PyPI and were explicitly reported
  as unauditable by name; their source is covered by repository checks/tests.
- Five immutable images were built, published by digest and started healthy in
  DEV. No container-registry advisory scan result was available.

## Upload threat boundary

Content validation establishes that allowlisted files are structurally plausible
within bounded size/complexity; it does not declare them safe from every exploit
or malware. PDFs and text are forced to download, images use `nosniff`, private
cache and same-origin resource policy, and every object read follows tenant/case
authorization before storage access. Adding Office/archive formats requires a
quarantine and scanning design first.

## Prohibited claims/actions avoided

No denial-of-service, exploit attempt, broad scan, credential dump, customer-data
inspection, real payment, real provider send/call or destructive restore was
performed. Remaining environment/provider skips are visible in
[Test results](test-results.md).
