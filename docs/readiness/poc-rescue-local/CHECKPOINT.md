# Local rescue checkpoint — 2026-10-04 Asia/Jerusalem

Work is in progress; none of the three readiness gates is declared passed.

## Runtime alignment correction (authoritative)

Fetching origin revealed local `3582027b` was six commits behind current main.
Live DEV actually runs `42eebac2d423bb70a0c69690e8d2899beab12249`, confirmed by
all four application OCI image revisions and immutable digests. Its schema is
`fc6e851f3ba0`. The previous local baseline results below are historical local
evidence ONLY, not evidence of defects in the running release.

All local work was preserved in snapshot `86c3641`. A merge of origin/main into
the rescue branch is being resolved with ownership by domain. Mature upstream
media, model recovery, queue fencing, agent admission, memory, opening menus,
auth lock preservation, manual deployment gates and rollback are retained;
duplicate early repairs are removed. New tests will run on the integrated tree.

GCP SSH is available through the existing deployment service account and existing
Token Creator permission; no IAM bindings were changed. The earlier personal
account denial is not an ongoing access blocker. Read-only inventory is in
ignored `.artifacts/poc-rescue-local/remote-inventory.txt`.

Active production-shaped DEV tenants are `or-on-dev`
(`00000000-0000-0000-0000-000000000001`) and `protouch`
(`633d9906-3866-4ddd-b85c-99c525bd3cb3`). A deleted ProTouch tenant with a different
UUID still exists and must not be mistaken for the active tenant. Both active
Meta channels are configured; ProTouch additional credentials exist in BOTH
remote web and worker environments. Local developer configuration differs.

The user confirmed ProTouch's source ending **4553** and a separate authorized
test recipient ending **7692**. ProTouch has a distinct existing Twilio trunk
with no termination domain or attached credential list. The existing carrier
credential named Protouch and ignored local secret bundle were found. No
provider provisioning, live call or message has been performed yet.

- Repository: Or-On/OrOn-CRM, local directory OrOn-Platform.
- Branch: `codex/poc-rescue-local-20261004`; initial clean HEAD `3582027b`.
- Referenced `BOOST.md` absent in repo, parent directories, attachments and Downloads.
- Historical `76ac719` patch not found; current source differs from that description.
- Docker PostgreSQL 18.6 healthy on loopback 5433. Existing developer DB schema `6f8b0d3e5a29`; left unchanged.
- Existing local tenants: `00000000-0000-0000-0000-000000000001` (`default`) and `10000000-0000-4000-8000-000000000001` (`or-on-workspace`). No ProTouch tenant in this local developer DB.
- Isolated preview uses owned UUID database, web 3100, fictional login helper 3101 and simulator voice API 3102. No live workers launched.
- Node 24.20.0 and pnpm 11.24.0 are bundled under `.artifacts/toolchains`; uv 0.12.7 is installed.
- Disposable DB harness `.artifacts/poc_rescue_verify.py` creates/migrates a fresh DB per suite, sanitizes output, then drops only that owned DB. Auth: 14 files / 66 tests passed, zero skips.
- Python baseline and WhatsApp regression work are running. UI, voice, WhatsApp agents have nonoverlapping ownership.

## Confirmed findings

1. Source dispatcher passes a global outbound trunk without a tenant sender; actual configured LiveKit project has one Or-On outbound trunk and zero inbound trunks/dispatch rules. Tenant routing fix under test; ProTouch provider setup is absent in this project.
2. WhatsApp media creates an AI job but history loads text only, causing missing inbound trigger. Regression and fix in progress.
3. Ticket name lookup is limited to first 500 contacts; settings grids misplace children; templates are in customer details. UI fixes in progress.
4. Caddy has no LiveKit webhook route; deployment rollback uses ERR trap and misses explicit exit; voice drain stops messaging/web before waiting. Infrastructure fixes in progress.
5. GCP read access works. `oron-dev` is RUNNING on e2-medium. WIF condition still requires `Abssel-AI/OrOn-CRM` main, not actual Or-On repository. No IAM change performed.
6. GCP SSH failed on missing `compute.osLoginExternalUser` for the current account in the external organization. Runtime image/SHA/schema and private remote provider configuration remain unverified. No live deployment performed.

## Next exact work

Finish scoped fixes and regression suites; inspect all failures/skips; run real browser acceptance with isolated data; verify Docker Caddy/dispatcher wiring and deployment failure handling; inventory current local tenant/channel/agent settings and document remote gaps. Update each coverage row with evidence, never infer live success from source/tests. Live sends/calls require a configured approved test destination; no customer messaging has been performed.
