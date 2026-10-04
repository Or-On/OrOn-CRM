# Cloud security and release prerequisites

Read-only inspection on October 5, 2026. No IAM, firewall, secret, retention, machine, disk or deployment settings were changed. The application remains on `42eebac2d423bb70a0c69690e8d2899beab12249` / schema `fc6e851f3ba0`.

## Observations

| Requirement | Observed state | Remaining acceptance |
|---|---|---|
| PDF-009, logging | Cloud Logging `_Default` bucket has 30-day retention; VM Ops Agent is inactive | Prove application logs reach an off-host sink, including a controlled failure and redaction |
| PDF-091, backups | `oron-artifacts` is in `ME-WEST1`, the VM region; seven-day soft deletion is configured. The returned bucket metadata has no versioning/protected-retention setting. VM nightly backup timer is active and its last result is success | Different-region destination, hourly recovery points, retention decision, completed upload/checksum evidence and failure notification |
| PDF-092, key escrow | Secret Manager contains `oron-field-cipher-key` and `oron-blind-index-key`. A subsequent direct read using the existing authorized deployment identity was denied both version metadata and payload access for these two references. No key values were obtained or persisted | An identity authorized for these specific keys must verify that protected versions match the running encryption/blind-index keys and decrypt a restored field. Inaccessible values are **unknown**, not evidence of mismatch or missing escrow; no access policy was expanded |
| PDF-093, restore | Existing tooling preserves security ownership, FORCE RLS, object checksums and external-key requirement | Full application restore on a separately authorized host with encrypted-field verification; recurring drill not scheduled |
| PDF-095, SSH/RDP | VM has `oron-dev-secure` and `oron-dev-web` tags. IAP SSH allow priority 800 precedes public SSH deny priority 900. IAP SSH was exercised successfully. Network-wide `default-allow-rdp` permits public TCP 3389; no target-specific deny was found. VM has no RDP listener | Remove the network-level RDP allowance for this target without touching unrelated VMs; absence of a listener is not a firewall-policy pass |
| PDF-096, service credentials | Web, worker, control API and dispatcher share one `AUTH_SERVICE_SECRET`. Service-specific env files exist | Separate service authentication scopes and verify least privilege. Existing shared-secret deployment is not certified as fully separated |
| PDF-102, recovery | `oron-dev-recovery.timer` is inactive | Opt-in activation only after the packaged helper, manifest, bounded-restart drill and operator response are verified |
| PDF-103/104, capacity | `oron-dev` is an `e2-medium` with 4 GB; earlier runtime snapshot showed swap use. Voice and messaging share the host | Capacity/load evidence, approved host decision and isolated voice capacity before live activation |

A configured backup timer proves scheduling, not a recoverable off-host copy. A Secret Manager name proves an escrow location exists, not that its current version can decrypt the running database. The local candidate does not establish any elapsed 48-hour canary period.

## Concrete WIF repair for later approval

Current provider `projects/157867817612/locations/global/workloadIdentityPools/github-oron-dev/providers/oron-crm-main` trusts issuer `https://token.actions.githubusercontent.com`, with mappings for subject, actor, ref and repository. Its condition is exactly:

```text
assertion.repository=='Abssel-AI/OrOn-CRM' && assertion.ref=='refs/heads/main'
```

The deploy service account has a `roles/iam.workloadIdentityUser` principalSet for the same old repository. This explains why the current `Or-On/OrOn-CRM` workflow cannot satisfy that trust. The existing human impersonation binding enabled the read-only inspection and must be preserved.

Proposed scope: change only the repository literal in the provider condition and its workload-identity principalSet to `Or-On/OrOn-CRM`, retaining the exact `refs/heads/main` restriction and existing issuer/mappings. Preserve unrelated service-account bindings, use the freshly read IAM policy etag, and fail review if the observed policy changed. Capture the previous provider condition and policy for rollback. Do not grant an organization-wide, wildcard-repository or wildcard-branch principal. After approval, verify a manual workflow's exact reviewed SHA; successful authentication alone does not authorize publishing or deploying it.

## Concrete RDP restriction for later approval

Add a single ingress deny rule for TCP 3389, source `0.0.0.0/0`, target tag `oron-dev-secure`, network `default`, priority 900. Before applying, re-read all VMs carrying that tag and stop if its scope includes an unreviewed machine. Keep IAP SSH and HTTPS rules intact. Verify IAP access before and after; remove only this new rule if rollback is required. Do not edit the network-wide default rule, since unrelated workloads use the same network.

Infrastructure mutation remains subject to the explicit approval rule in [infra/AGENTS.md](../../../infra/AGENTS.md). These are prepared scopes, not executed changes. Different-region backup resources, retention locking, host resizing and separate voice capacity require their own concrete cost/access review; no irreversible retention lock or server deletion is proposed here.

## Local evidence

Private local artifacts under `.artifacts/poc-rescue-local`: `cloud-wif-provider.json`, `cloud-deployer-bindings.json`, `cloud-firewall-inventory.json`, `cloud-target-instance.json`, `cloud-backup-bucket.json`, `cloud-log-retention.json`, `cloud-secret-references.txt`, `cloud-runtime-security.json`, `escrow-access-result.json`, and `remote-baseline-30day-corrected.txt`. These contain configuration references/status only; no secret values were printed or saved.

## PDF-109: managed PostgreSQL decision

Decision: retain the current PostgreSQL architecture for the immediate repair; evaluate single-zone Cloud SQL with PITR in an isolated, separately authorized pilot after migration/security compatibility. No managed database was provisioned or selected as a production replacement.

| Option | Reliability/operational tradeoff | Cost assessment | Compatibility gate |
|---|---|---|---|
| Current VM PostgreSQL | Already operates the application; database, voice and messaging share one host. Nightly local backup and incomplete off-host proof leave recovery gaps | Current infrastructure is shared; this investigation did not obtain a verified itemized bill or accepted capacity estimate | Local PostgreSQL 18.6 migrations, runtime roles, FORCE RLS and fictional encrypted restore were actually tested |
| Single-zone managed PostgreSQL with PITR | Separates database operation from the app VM; backup/log recovery needs explicit configuration and a restore drill. Selecting one zone does not itself prove continuity during a zone failure | Incremental service cost must be quoted for region, measured CPU/RAM, database growth, backup/log retention and connectivity before approval; no fabricated price or saving is claimed | Run all139 revisions and dedicated definer-function/owner/grant tests with the managed administrative role; test all three restricted runtime roles and restore |

Cloud SQL does not expose a true PostgreSQL superuser to customers. Its administrative role has a different privilege contract, so a successful local migration as `platform_migrator` is insufficient compatibility evidence. The repository creates restricted capability roles, installs `citext`, and deliberately assigns security-definer function owners; those require direct managed-service validation without weakening FORCE RLS. [Google's user and role documentation](https://docs.cloud.google.com/sql/docs/postgres/users?hl=en).

PITR must be explicitly checked in the resulting instance configuration; creation method changes defaults. The pilot must test a timestamped recovery into a separate target and verify encrypted data with independently accessible escrow keys. [Google's PITR configuration documentation](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/configure-pitr?hl=en). Pilot cost, provider permissions and actual compatibility remain open approval/measurement gates rather than reasons to move the database during the POC repair.
