# Candidate source delta — conflict-safe review manifest

Status: APPLIED TO ORIGINAL CHECKOUT after the user's explicit stopped-runner confirmation on 2026-09-12. All 89 reviewed source files matched their candidate hashes after application. The table below preserves the original pre-application review snapshot captured 2026-09-12T17:40:33Z; do not replay its preconditions as though the merge were still pending. Merged-tree verification is recorded separately.

Original: `C:/Users/almo9/Or-On-Integration/OrOn-Platform`.
Candidate: `C:/Users/almo9/Or-On-Integration/OrOn-Platform/.artifacts/readiness/candidate`.

This compares current filesystem bytes, including the user's pre-existing dirty changes; it is not a diff against HEAD. No source files were applied, deleted or renamed. Original runtime processes/settings/data were not changed by this manifest operation.

## Scope and method

- Compared files under `apps/`, `packages/`, `services/`, `db/`, `scripts/` and root `.env.example`, using SHA-256.
- Excluded generated/build/dependency/cache directories: `node_modules`, `.next`, `dist`, `build`, `generated`, `.artifacts`, `.venv`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.turbo`, `.cache`, `coverage`, `test-results`, `playwright-report`, and `*.egg-info`; excluded `*.tsbuildinfo`, `*.log`, `*.pyc`, `.eslintcache`, and all other `.env*` files.
- Original `infra/`, `docs/` and `.github/` changes are intentionally independent. Never replace or reverse them with the candidate tree. Root package/config files beyond `.env.example` are outside this source delta; they were included in the missing-file check, not proposed for copying.
- No secret environment file or credential value was read. Hashes are source-file integrity evidence, not secrets-scanner or application-correctness evidence.

Compared 835 original paths and 858 candidate paths: **64 changed, 25 added, 769 unchanged**; 2 original-only paths are preserved separately below, not deletions.

## Safe application prerequisites

Historical prerequisites below were satisfied for this application. All 64
pre-application source files were backed up under the ignored
`.artifacts/readiness/merge-backup-20260912/` and their original SHA-256 hashes
matched exactly. The 25 new files had no original conflicts. No file was deleted,
and `.env`, root configuration and original-only infrastructure were not copied.
No user database migration or real worker startup occurred.

1. Keep live runner/workers stopped before applying runtime code. This manifest does not authorize stopping them or applying changes.
2. For every changed path, rehash the current original and require an exact match to its Original SHA-256 below. A mismatch is a conflict requiring review; do not overwrite it.
3. For every added path, require that the original still has no file at that path. If one appeared, review it as a conflict.
4. Rehash each candidate file and require the Candidate SHA-256 to match. Candidate drift requires a refreshed manifest and relevant tests.
5. Apply only explicitly reviewed added/changed source files. Do not copy the whole candidate directory, generated artifacts, dependency trees, fixture data, `.env`, or original-only deletions.
6. Run migration/contract freshness checks, affected suites and builds against the merged tree. Apply the successor chain before code requiring the new schema/functions. Previous candidate tests are not a claim that a future merged tree passed.

## Added and changed files

`—` means the original path was absent. Hashes are lowercase SHA-256 of exact bytes.

| Path | Status | Original SHA-256 | Candidate SHA-256 |
| --- | --- | --- | --- |
| `apps/web/src/app/api/auth/invitations/accept/route.ts` | CHANGED | `44d6e869cc6b270e64664cc496b1a0f9c034051fee6d63ca5b478bce5adc9804` | `1f44fff48ea5e4d22dbed4ffcccb588b6bd95321a2f6b71d7279a24f69635afa` |
| `apps/web/src/app/api/automations/[id]/run/route.ts` | CHANGED | `6a086f6c8554e0f8f1e5826e70727b43e209e15e0d32ead056cabbb805464f9f` | `5479f4916e284ce7244979eb3e18ebfa610970eac6dcdbdc6808c17d2a592430` |
| `apps/web/src/app/api/billing/payment-source/route.ts` | CHANGED | `9dd85df5a1e222b557ae1e17d94fc198a70d90121c723797f49dd72390ca0277` | `1bec7ad7b66c9937b2c7d67c6cf97e8123e0dc53a04ba62b056848a593169454` |
| `apps/web/src/app/api/billing/topups/route.ts` | CHANGED | `bfa7e6b1ea7386c49cdac48059caeee64b3bba35ddb2028f3d088af87f893fd2` | `51cb717400c5053d74f5274d3b49548d2d22ba2adc5052294c4ff875e7cae87a` |
| `apps/web/src/app/api/campaigns/[id]/deliver/route.ts` | CHANGED | `7941f54aa82fee6d6ce6383d7499a797e354b9d3c637e59c83259f082a1025a8` | `81e35cf9ec98164602a0b98aa37bc9f20c7cb675999959b1f8d2683d8d56ed7e` |
| `apps/web/src/app/api/campaigns/route.ts` | CHANGED | `0e7eaa6177217d880a5ac387f30d1d400a948434e4ec96484fe94879e04271a3` | `dd22bcc0363bbe2964a177ec18f1292abb0bce5b94cfc269afa2965daf29910d` |
| `apps/web/src/app/api/email/oauth/[provider]/callback/route.ts` | CHANGED | `28f806fd868ae96efca1d8467e6849d1eb7d970e1f99a16c2f76efecb0ce35c4` | `eb40b2edb18558fbb773775f37dc5d14abcb6d4722b9d6777f3defdd40d27c6d` |
| `apps/web/src/app/api/email/oauth/[provider]/start/route.ts` | CHANGED | `d6b99884de83edb65a05fbe8d526a9227227c5f43811d570d926d1068ce2626e` | `f3161aef7432dde45903328151d95e4caac649f545db0e7dde1eae3ee3eadd82` |
| `apps/web/src/app/api/messaging/conversations/[id]/messages/route.ts` | CHANGED | `fac3ae417702951002c11f589f9be6be33e0a29b7617dd36a79688bb4f29f11a` | `58900ac8086177f8934c95b55285b1fe8c868821e511a272484117f49f1449b7` |
| `apps/web/src/app/api/messaging/simulate/inbound/route.ts` | CHANGED | `857e783daa0bc0ab0ef0c2e03a81d7067affde4d8a7d8182a23253eacf702083` | `5d2175a115a2d92a07d8e37d995f64fe3ddc14cf12839535dfcc0e0f5e5a816f` |
| `apps/web/src/app/api/orchestration/flows/[id]/simulate/route.ts` | CHANGED | `97c6c1a385ff29439d766946602a28eafd91dc58e02ea73b31309570e3c1380f` | `579673858785d906ee10a9f110e8a6d5576044d1cc5b3ba026d96c2c6941d8ab` |
| `apps/web/src/app/api/orchestration/simulate/route.ts` | CHANGED | `d5fa5012dc4bedafae193f5db1594adfab1306fe42481f02ce8ee93f020cd6b6` | `375207cba12b276cfb877d5d78139ec1da8f79fb85f5540f4266a14657d47399` |
| `apps/web/src/app/api/voice/simulated-calls/route.ts` | CHANGED | `3e840d85ec118e40852a1428935dfc1db237b868c809ec0e10bd9a6a4e43f8d1` | `0eb3cf385697a47371c36a1680dd854722fe074311843f6b6c1c26096ebdf2ce` |
| `apps/web/src/app/api/webhooks/stripe/route.ts` | CHANGED | `76441a440c5f10ea00951e669f5e7b149d5c8982fb1ab50f7b354bcc6ba7763a` | `bea8b7abd30dd13756aa0200873865d3341c37b0976a4ff5f2e0daf1dfec9afe` |
| `apps/web/src/app/contacts/[id]/page.tsx` | CHANGED | `6f1d0ef65afb9a2305c6db37dbaaa8736f4260176ea07907c78b5afaa4592a5b` | `1a8045800847b0096f6676ea5c1ff4008ea6f513f4ddc95d504edf987e77c460` |
| `apps/web/src/app/studio-replica.css` | CHANGED | `c9a87871a86c42b07c70a6e6f594974e762d62ff93536926dd9eaadc27c3c0cb` | `3ab289c35abcef4c0e081463ef4749377e418d0de7ff5c0e2a1b7c6cf929dfbf` |
| `apps/web/src/app/workspace-details.css` | CHANGED | `43f7a6b433ad4ab65fb9d14d107dfeab412b1aaa722f0efcb3ffd5ce895d8a7b` | `8042199da644665615849daf1f5edff5b0e9def094ba65670ecc2681dad6d1da` |
| `apps/web/src/features/auth/fresh-authorization.test.ts` | ADDED | — | `03e7e563e8bb38ba557a05b3c3e61ceb71524978768a0c8f0c41405645b55e2b` |
| `apps/web/src/features/auth/request.test.ts` | ADDED | — | `506f327f56286aa65034f50f8c2654564a92c0a8eac571b7d964500bb0c3cc14` |
| `apps/web/src/features/auth/request.ts` | CHANGED | `2b899c3246343e664399415c0e0a0ff9a614cefca10c9ff748d12733cc4479e7` | `36851a93e8ee7e66246b0d1597538f7c403dfe36c3b6f1796749860425473b60` |
| `apps/web/src/features/auth/server.ts` | CHANGED | `9e8634b83819f563d206610ce69da24e57487f662ee2c1103d47a2a33e556c23` | `d9ec092bcb5ece0b392d4c54da5ee3ee42bc723dd418ed9fb73575c64ac063b0` |
| `apps/web/src/features/contacts/contact-detail-panel.tsx` | CHANGED | `f15a461c90278727fc3c243b2bb2481167f30c3a7f33bb3aa14e23595fec63d2` | `1e520b0652c67712e28f283226fc9c8b112a48d6d65a8eabaeff926683486f95` |
| `apps/web/src/features/email/index.ts` | CHANGED | `15854891cf7bc0fd4b01d80e6b850a1534e8e3f0fbd5915d88b97b670e7ebcc4` | `6ea43a361b604cb520f41d74bd051110d24964b0745889e5d41a83f32020141f` |
| `apps/web/src/features/email/oauth-server.ts` | CHANGED | `9ca956832102330fd12cbe9fe3747b976e54a94eaf14c5b6905d9185d1ef30b6` | `d93166d5bb7521fe647e07c1ec6423b326ce09f24bccbb674d09cf447938bd61` |
| `apps/web/src/features/email/oauth-state.ts` | ADDED | — | `99349ba65f5fb4da8065782755ab051f3562ab04c145e97c2a02e96cfb182b38` |
| `apps/web/src/features/finance/index.ts` | CHANGED | `72bd7a75fcb7e3ae888f2c1fb02ccc1ac7a611aff3945aa4362bc2bd61582d0c` | `c74eb612f153e39b268d83ebe1b12909bd18f4ba75c912e0fd9ccc75f56f79a6` |
| `apps/web/src/features/finance/payment-setup-server.ts` | ADDED | — | `64c4e886f06c2bb60036a95823bbfa117ba34b1e4ca1448a336acaf5d6a8e7d9` |
| `apps/web/src/features/finance/stripe-events.ts` | ADDED | — | `8106123c55e48c4938a85811fb28715bb2bce98ac86f0e8a305257df96b32cd4` |
| `apps/web/src/features/finance/stripe-server.test.ts` | CHANGED | `e7520e5bd15ace396ac557f347eade8f5885af20508e75d7a8a0157a8d493417` | `dda15937411fe32eb866b9637b70d465fd1197c7130c2290c878a495322c1ae0` |
| `apps/web/src/features/finance/stripe-server.ts` | CHANGED | `27220c8b85cb840ddc5a75829256640d8af7a618aedb347247a535856840b2de` | `30950269ac9c7ecd53e80e2dd2fea35c371759400af40555592567d53a304929` |
| `apps/web/src/features/simulation-policy/index.ts` | ADDED | — | `852802b8b3f36ff919d174bf818c871245d02ffbe0e988aab5546de1a1869215` |
| `apps/web/src/features/users/users-workspace.module.css` | CHANGED | `45844d729d32620b769b0a98dd21842e1c4b57405140fa974d35c2a7d5a9ea5f` | `e99592ea0fd39485376bfecfe924894c0cb5ad0694e6ee2a342113694929e318` |
| `apps/web/src/i18n/messages/en.json` | CHANGED | `a244d415eb952d1323f72b59c1c654c7a20d50d02f0a3b3c3eaac7df97406e0d` | `840e46709b8c978de9bf881f6f2bb749a7c108bab2f6585e87c03c8654f277b1` |
| `apps/web/src/i18n/messages/he.json` | CHANGED | `5d5bc796538ce0a3e6b64ad19c748b00e27afac41b428edae906b160c0781219` | `1d1f157f0f4e356020508e3ff718c8b5a373e1d43ecd44e39212ddba2796d8be` |
| `apps/web/tests/billing-topup-route.test.ts` | ADDED | — | `44b27ea2e6cb090d294647f959f4c46e9b7b9232c8dfa8948f13569252c74c61` |
| `apps/web/tests/contact-page-resilience.test.tsx` | ADDED | — | `3cdf149f91090294c84b63a197ec17ac4e123b2daaae654f7511624fe50febc7` |
| `apps/web/tests/form-recovery.test.tsx` | CHANGED | `a7193aa2ef1a88b3b5cb5c21b647d28695f540d7a576d5f07d1ed3348fb5d411` | `82c2a81ad16f415dfaf31d72972490a44cb4bbdca372f7f717861fae79f8b0bc` |
| `apps/web/tests/invitation-accept-route.test.ts` | CHANGED | `3343535720277a604f8283b1cd91af9f46d5d6fffdda4d927ce2ba4c66f0925e` | `02d40eaa9720e998e6442be0931158671df1c3475c626213864a18de11c19d2d` |
| `apps/web/tests/oauth-credential.postgres.test.ts` | ADDED | — | `dbaf612ca4536f5aefc02784ffbbe7b9ca40e47443d29024bfbc357d2b2d477b` |
| `apps/web/tests/oauth-state.test.ts` | ADDED | — | `cc05e0cdc3aa5d3e672e742055658eed5568ab2ffc42fafc85c8a7a4bf2f1db7` |
| `apps/web/tests/orchestration.test.tsx` | CHANGED | `18afd52fefb7388eadbc953b4668f39619b6928986cab1517cc9673a9e72396d` | `a905f74e6f91b445975f3337b73afecc5eb3f94ce2f3deeab16d740f80cab667` |
| `apps/web/tests/payment-setup-route.test.ts` | ADDED | — | `e7d2bfbc4bf421b13db8caee828a5773d90f2aff2452085133875da3cb32c5ea` |
| `apps/web/tests/simulation-deployment-policy.test.ts` | ADDED | — | `55426c306e62337d08002a55143569ff4e4d490396097f10c7afd84d2a0f003a` |
| `apps/web/tests/stripe-webhook-route.test.ts` | ADDED | — | `505e63b219db422749e99a688276c40022e19fad16132a304010366d746948e2` |
| `apps/web/tests/whatsapp-api.test.ts` | CHANGED | `2a4bf8b36693e50ee9bc164734db7b71017848afdcff640e56a215b6ec1b47b0` | `59cc5736a235b431a17f10e4209798a4df50a74a80819de456ed2fed9732bfbe` |
| `db/alembic/versions/2b2b64433c98_fence_messaging_worker_claims_and_.py` | ADDED | — | `da7d847b463af298d2a9269b59c47a94ff88a5015c6af98ff1122d425db4b5c4` |
| `db/alembic/versions/6d9561f45598_bind_oauth_authorization_and_revoke_.py` | ADDED | — | `315078a1065b4b6307d7cfe0a30a00237b020f3a114a27a9e4c44a9c7240b5b6` |
| `db/alembic/versions/74e4f347dbbd_bind_billing_provider_events_to_.py` | ADDED | — | `c2d10465088c9216236ac8cb97473826aeca3395372adc108d1973d4230df120` |
| `db/alembic/versions/bfb741c767fd_lock_fresh_auth_authorization_before_.py` | ADDED | — | `b16e238a25b2afdd36970935624aa0fbdac910a4d5cbfbe7de3360fd7f6d2ef7` |
| `db/alembic/versions/c92f8341a7de_add_user_and_tenant_identity_images.py` | CHANGED | `2240fb125f8df5ef5a01f839de3402c1167dc4f81c3918d5944f5394cd00a13b` | `9fb1115d31b65a2cbd2d6f497f370d742c178301fab2b10cae150678838f4afc` |
| `db/alembic/versions/ce2dff05c838_authorize_tenant_messaging_ai_workers.py` | CHANGED | `bf2227f28ebd31412b75eb97d45aba908965e200eac414a0a694bf78859aadbf` | `7609d8e1853a1d9fa591b2199a830c5a132345d25949a4c9bec57d1bfd46940b` |
| `db/alembic/versions/d41b2038c77a_require_stripe_payment_sources.py` | CHANGED | `aeee04849c33db061223b185215064c968c15700861fccd94cf11bfa1e1de53f` | `eb68d25b7c9d91226606d3964b24d1bcbf46b9c878b6d68e9eed269483029573` |
| `db/contracts/schema-manifest.json` | CHANGED | `77d68643fb1415f6e1849d465c8480767b842efb7e223a3bf2800d5f30c8c36c` | `d6e833fa60b92dc714f9682abe884568816d98246d9499c8d28f04f88275902c` |
| `db/tests/postgres/test_billing_event_binding.py` | ADDED | — | `081f5c16571d6c2813e34595c8420101faf572637c291b9627558562be4bcd64` |
| `db/tests/postgres/test_fresh_authorization.py` | ADDED | — | `a5ae6e899ea85c44a69a502bbea6538b355f87d1cacf3f6539a897a5b3ef2b4e` |
| `db/tests/postgres/test_readiness_identity.py` | ADDED | — | `5db887f07406a3a96ed33e0330fad78cdcb95afede83014b7b64ffe6985a8f81` |
| `packages/py/oron-agent/tests/test_caller_gender.py` | CHANGED | `061a4efa1f8ac26607ae8e90aacf9305051ae14a213c0757ac6c7eafd6b2f7e9` | `ee5389e5f259b0932f1cb736f89e3ec01d39f35254218b4e75bc71e4d437dd1a` |
| `packages/py/oron-agent/tests/test_responsive_turn_start.py` | CHANGED | `b192095f90eb3529b4fb287e65e3b7c0496885bfc83f5775caf2e360d2f56d5b` | `9bf902ae2aff1223687101bf82f916e1dac52cde1b4d21c9daa51cb43cdb1ff2` |
| `packages/py/oron-tenancy/src/oron_tenancy/models.py` | CHANGED | `bdb2ee0ed2491293f6bbc305d4a0d5c9532151072ff4adc9e3936d087ebfa037` | `c06ca5553e2c996a6e6a585c3e3c3840f8511163d0ebca45a178163301d5b5da` |
| `packages/py/oron-tenancy/tests/test_users_models.py` | CHANGED | `ac9c8c00ca9e08c7e8d2ba06b33facebc55a79f836d71bde7573b8647eee90a2` | `64332d28188fb16df363eadae6b6acd68fc1840858f3270cd08018b088962c89` |
| `packages/ts/crm/src/api-keys.ts` | CHANGED | `33506cbaf515ee13634cd5d57b6d8ba419a352ad482e2c0776d9f1e65fcb444c` | `09d3a8916ddf5c4d4acca0e4f06b6aa0a220ed8891ff0c1baf38b71f54f09b80` |
| `packages/ts/crm/src/billing-idempotency.postgres.test.ts` | ADDED | — | `b2ed99418cf285ab7d90aa06513e8fae5bf8db345845885411b4fdbe3deb9547` |
| `packages/ts/crm/src/billing-idempotency.test.ts` | ADDED | — | `9e7ee40257bb3940b7b207b8fb26fdd2adf68726b44ce757b0e7f425d0a14866` |
| `packages/ts/crm/src/billing.ts` | CHANGED | `1dc4702b1140c447f0396578a291f0bc5fd9d50e050f830ef92799a4ddff663b` | `f07bb7595a0327085044142f08f4ba8a87a55a2a980eed726783c8693033295f` |
| `packages/ts/crm/src/contact-creation-policy.postgres.test.ts` | CHANGED | `903485315b228fa91124a456296f93c3e354775a9dd5077a203f85ac757f6d46` | `d2af0c2beed9758d5674a97e449820d03582681edb574085f55963ed1dd01eef` |
| `packages/ts/crm/src/contact-creation-policy.test.ts` | CHANGED | `1b782069157977e5f979467019309ce606fb81015280326e5d4fcca6c2793180` | `564c946879d89975589d5fdcb90e7e2b1518578c316f0264ff9763aac35ea927` |
| `packages/ts/crm/src/contacts.ts` | CHANGED | `db7ebfed715c4e93132625e9bd45feed211f8fcc9fa44578b713b75e818aef94` | `2eec4133e2473e5690f3d0e377a4e8beb6a5d92a957e90cc2f65b7873d460ad3` |
| `packages/ts/crm/src/messaging.ts` | CHANGED | `bba2660ba1a2cf096870bf2eacd37e870dd1ed97dae2830489b081d8c26f4446` | `c203fc68dc4a7be42c3a8b613ba3b027a33453cd2f3d8779ffdeb783a2865884` |
| `packages/ts/crm/src/webhook-store.ts` | CHANGED | `5bec077c17e9ecc395710676218a15bd993b2d7fa0bf53e48f99dade13b23614` | `02a99d4bcbee3728dc9c3cae3fbd585bcb582bf66ffd13ac3ca7a579c7c7534a` |
| `packages/ts/crm/src/webhook.test.ts` | CHANGED | `367176fde89f33db76078942930d8c827bfc1d163099846232f3efb6ba9bb705` | `5cd1201493de84c8b9a017f36a68dce3d390e049c1215a8a00570e2fc958e499` |
| `packages/ts/crm/src/webhook.ts` | CHANGED | `8294eaf28f74a734e59961add57a5ea8c710b247e85bf895d00c663c2cb071c5` | `79033174bd10efba980bae035ed4f0dc7df0d876970988a693444d9dffa5cea0` |
| `packages/ts/crm/src/whatsapp-diagnostics.ts` | CHANGED | `f45b5068f5eb624f50997360c85e4c82bea3cf626e123e0ea43b2a837b307cf9` | `443997339a953698454c66c6dbcd87918cc5de852c4d30342125ea64929a308a` |
| `packages/ts/crm/src/whatsapp-outbound.ts` | CHANGED | `ac3906d44a89af1003969f056c287cb6322e36096530a4839ba5deb5f4504df0` | `3efcda65e11cea1111dea21498c0d2d1e88e9c338be36f0948a991f8b69a411d` |
| `scripts/benchmark_readiness.mjs` | ADDED | — | `bb1318dfd7099ff1bf2841cc2c72550f381386636ed227e13492d7c87137d3b1` |
| `scripts/capture_ui_preview.mjs` | CHANGED | `c81f3bb6c1f49237dad71145b2c76731c7c2440251bd27e3ce0fe5d6abe353e1` | `99ff3285ec5d4966c2873c62e43afc7cd244d12cf42cd644b764529f85880bc9` |
| `scripts/preview_ui.py` | CHANGED | `4faca10e84a2dd31301367a87f8a2d618c7952f44524f243c884e79f7d65999f` | `3f0686d5886a3e0cd54918a0e870827d65cf92cce8e88589ff27b20e02416155` |
| `scripts/tests/test_db_verify.py` | CHANGED | `c57ef5918017164f449a633261abad1145d33f00208938fe5fb913a4fc1d5829` | `ef0749e8101055cd9d004993c9dae8e5253fd2c8d21d2cb6727b72023925b072` |
| `scripts/verify_contact_outage_preview.mjs` | ADDED | — | `3d902873e0858967d7d142a99b25975936553f4b692d786a35e4753b13a91673` |
| `scripts/verify_workspace_ui_preview.mjs` | CHANGED | `2205f915fd543598de8baad9b1e26b7ee40635a3d5377ea926060736b5a7af62` | `527cab00f9a13b02cbd3f82c7c7996bd5d734aadd2d193e65863fbbc55ae7fc4` |
| `services/ts/messaging-worker/src/database.ts` | CHANGED | `aa69aa013f279b0e0d40248a83fd52d5f460af9c248c50df58ef5a547964f7ee` | `b7ba6ad0a8650ab10e2e4ec48470565bbf406d093154806c82ca641b166c7dcb` |
| `services/ts/messaging-worker/src/main.ts` | CHANGED | `1d76682c0e4b5d54cde70c346fb99079e8daf90ff51be3d973cc5de609c1421d` | `1a91fdc51bba5386137255cfb11dd69c0d78401897f0963b70a1a4e41d4ab665` |
| `services/ts/messaging-worker/src/providers.ts` | CHANGED | `69e5fbf8032cc4ae204fb6ca99c451bd298ca93fb406e9500ab1f8dbcb741a89` | `7e7911699bb619f9928765bc80d9f8c233ae000d2d0fd988ab4307df9f0ebccc` |
| `services/ts/messaging-worker/src/worker.ts` | CHANGED | `66903b2b995f7e62a9067b5de60cef2a145c49ecd413a8ecb25474798591524c` | `d06d2474b450317e05ad5b0861fe9028244dd891c11ced4152bbaf6101d3eb4c` |
| `services/ts/messaging-worker/tests/ai-reply.live.test.ts` | CHANGED | `8b022094a5f7b5de5a3ba8f6a124ae811f587e362e8c3ab976625e022e6007d1` | `bbdb102e178d5dcdd65734380f0deb651c09e6885b0575687756acab3cf196d7` |
| `services/ts/messaging-worker/tests/call-followup.live.test.ts` | CHANGED | `a078d4943bfbc433e9b6a5bf981f4c09bef9f44181670b849e809dc6643eebfa` | `763f132aa39ec926442c65a691c6a30bf1b4b62c4474b013c457a3799376803c` |
| `services/ts/messaging-worker/tests/database.live.test.ts` | CHANGED | `c3d95e1e33d4447a9c437b2a08a8306bf03a176d35b438033e0984a50966b27c` | `31a1e54fd6e10b303ecfc5fc1c2e48ff1531c66a996f8620e5d552ee5a382d9d` |
| `services/ts/messaging-worker/tests/providers.test.ts` | CHANGED | `3fb9f90dff3f86d882e520e0dfcd813a9dd0756a32651b22eb5151ae5435894b` | `bc0a323a67ed0fb4c28519374a1a2dbcef7b8698d569822c590f681ab182bf9c` |
| `services/ts/messaging-worker/tests/readiness.live.test.ts` | ADDED | — | `57b8e9d261c39a6a58351130bc8da920b7fc371e7adc2cb2fab03fada1b18303` |
| `services/ts/messaging-worker/tests/worker.test.ts` | CHANGED | `9c664634b38f1dcd22282a68f8a8142d466a73986813468f3fcce78886d25b09` | `956b6ac613bc3e7dfcebad049aa79bcdd6684ce29dec3bb6db289227b6a91cd4` |

## Original-only paths — preserve, never delete

These two staging tests were authored in the original workstream after the candidate snapshot. They depend on original-only `infra/scripts/staging_secrets.py`; they are not evidence of an intended source deletion or an accidentally lost baseline application. If final candidate validation is meant to cover them, explicitly synchronize the new staging test/infrastructure set rather than treating absence as a delete.

| Path | Disposition | Original SHA-256 | Candidate SHA-256 |
| --- | --- | --- | --- |
| `scripts/tests/staging_secrets_posix_check.py` | PRESERVE ORIGINAL; absent in candidate | `94af77e2fcfa9bf4719cca7396e923ff111944267c6ca947b98fb0a30c2e1e74` | — |
| `scripts/tests/test_staging_secrets.py` | PRESERVE ORIGINAL; absent in candidate | `531b328b8f15b99c5cdd626124bcdb9d867bb0c3e19b806b2bac6cb33d5fcbd3` | — |

## Snapshot-omission verification

- Checked every currently existing Git-tracked or nonignored untracked original file for candidate presence, excluding intentionally independent `docs/`, `infra/`, `.github/` and secret environment files.
- Only the two new staging test paths above were absent. No other existing baseline runtime, root configuration or test file was missing.
- `.env.example` was restored in the candidate and is present, unchanged: original and candidate SHA-256 both `43916a8e31c44f7da931fbc179dfe7153b5e017895d2832199c5e198729b81ae`.
- No generated files were proposed for copying. Regenerate/freshness-check generated contracts from their authoritative sources after any eventual merge.

## Final verification and preservation notes

- Final consolidated run passed formatting/lint/typechecking,619 TypeScript tests (48 skipped),834 Python tests (108 skipped), contract/migration checks, production build, peer checks and pnpm audit; its final expired NLTK advisory gate failed. Therefore this snapshot is **not release-approved**. Skipped tests are not passes.
- Separate final PostgreSQL suite:107 passed at57 revisions/head `bfb741c767fd`. Four generated-contract before/after hashes remained identical in the main workstream's freshness check; those generated artifacts are not copied by this manifest.
- The final scan includes the verified formatter-only OAuth concurrency test change and `scripts/preview_ui.py` explicit None-returning stop callback repair.
- All previously recorded65 original hashes stayed unchanged, and25 candidate-added paths remained absent from the original. No pre-task full source hash set exists, so this is preservation since the prior manifest, not cryptographic proof of pre-task equivalence. No runtime merge occurred.
