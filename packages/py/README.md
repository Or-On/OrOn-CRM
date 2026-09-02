# Python packages

`platform-integration` contains new cross-system configuration, observability, and
contract glue only. Later Or-on packages keep their mature distribution/import
names and proven dependency direction; they are not renamed to `platform-*`.

Phase 5 retains these low-level Or-on packages under their original identities:

- `oron-common`: call context, E.164 validation, and usage/cost models.
- `oron-db`: SQLModel bases, engine construction, runtime-role selection, and
  transaction-local tenant RLS helpers.
- `oron-flows`: typed voice graph, component catalog, composition, publishing,
  and storage interfaces.
- `oron-tenancy`: canonical tenant/membership models plus phone, flow, and SIP
  admission control with provider actions disabled by default.
- `oron-secrets`: optional GCP Secret Manager reference resolution at an
  entrypoint boundary.
- `oron-sessions`: encrypted voice-session, artifact, and campaign persistence
  behavior.
- `oron-dispatcher`: signed LiveKit webhook, fail-closed DID admission,
  one-agent-per-room lifecycle, and guarded SIP orchestration behavior.
- `oron-hebrew`: Hebrew normalization, number/niqqud filters, and explicitly
  checksum-pinned local speech-model adapters with no download fallback.
- `oron-agent`: the retained Pipecat/LiveKit media pipeline, flow runtime, and a
  task-based launcher injected into the dispatcher behind provider safety gates.

They are proprietary project code imported from the locked Or-on revision. The
target manifests pin verified Python 3.14-compatible dependency versions;
source behavior and behavioral assertions are preserved. The heavy agent,
PyTorch, ONNX, and audio stack is isolated in the root uv `voice` dependency
group so ordinary control/CRM synchronization remains small.
