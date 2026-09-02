# Phase 5 telephony compatibility gate

Verified 2026-09-02 against the locked Or-on commit
`cece174f4d590a1b8a283d539dd66e08cc689aa9`, current PyPI metadata, official
project documentation, and isolated imports on the selected CPython 3.14.7
runtime.

This gate separates dependency selection from source import. It makes no call,
starts no provider service, downloads no model, and changes no upstream file.

## Selected dependency baseline

| Dependency | Or-on locked | Registry stable | Phase 5 selection | Result / rationale |
| --- | ---: | ---: | ---: | --- |
| Pydantic | 2.13.4 | 2.13.5 | **2.13.5** | Existing target pin; retained models and all low-level package tests pass. |
| phonenumbers | 9.0.34 | 9.0.38 | **9.0.38** | Pure-Python CPython 3.14 import; E.164 source tests pass. |
| SQLModel | 0.0.39 | 0.0.42 | **0.0.42** | Existing Phase 1 candidate; retained model tests pass. |
| SQLAlchemy | 2.0.51 | 2.0.52 | **2.0.52** | Existing target pin; asyncpg/RLS test passes against PostgreSQL. |
| asyncpg | 0.31.0 | 0.31.0 | **0.31.0** | Existing target pin; live transaction-local tenant test passes. |
| FastAPI | 0.139.0 | 0.141.1 | **0.141.1** | Existing control API pin; service integration remains P5-004/P5-007. |
| pydantic-settings | 2.14.2 | 2.15.0 | **2.15.0** | Existing target pin; provider settings remain typed/default-off. |
| Loguru | 0.7.3 | 0.7.3 | **0.7.3** | Preserve source boundary; adapt output to structured/redacted logging. |
| LiveKit API | 1.2.0 | 1.2.1 | **1.2.1** | Isolated Python 3.14 import passed with Pipecat's LiveKit extra. |
| Pipecat | 1.7.0 | 1.8.1 | **1.8.1** | Latest stable declares Python >=3.11; source-relevant extras imported. Full retained agent tests remain P5-010. |
| audiolab | transitive | 0.5.2 | **0.5.1** | Required compatibility fallback: 0.5.2 removed the `Graph(rate=...)` API used by Pipecat's pinned `pyrnnoise==0.4.3`; the retained RNNoise test failed on Windows with 0.5.2 and passed with 0.5.1. |
| Renikud Plus | 0.3.0 | 0.5.0 | **0.5.0 with `cpu` extra** | Import passed without constructing `G2P` or downloading a model. Version 0.5 makes ONNX Runtime explicit through the CPU extra. |
| ONNX Runtime | 1.24.4 | 1.29.0 | **1.24.4** | Pipecat 1.8.1 requires `~=1.24.3`; 1.24.4 is the newest compatible patch and imported on Python 3.14. |
| PyTorch | 2.13.0 | 2.13.0 | **2.13.0** | CPU import passed on Python 3.14. |
| Torchaudio | 2.11.0 | 2.11.0 | **2.11.0** | Import passed with PyTorch 2.13. Official stable-ABI documentation supports PyTorch 2.11+ and Python through 3.14. |
| safetensors | 0.8.0 | 0.8.0 | **0.8.0** | Import passed; no weight file loaded. |
| cryptography | 49.0.0 | 50.0.1 | **50.0.1** | Updated target from 50.0.0 to the current wheel/OpenSSL patch; retained AES-GCM tests must remain green. |
| Google Cloud KMS | 3.16.0 | 3.16.0 | **3.16.0** | Preserve envelope-key adapter; no credential or network access in normal tests. |
| Google Cloud Storage | 3.13.0 | 3.13.1 | **3.13.1** | Retained artifact reader dependency; mounted object storage remains the local write default. |
| Google Cloud Secret Manager | >=2.20 source range | 2.30.0 | **2.30.0** | Retained optional entrypoint adapter; injected-client tests pass without GCP access. |
| OpenTelemetry OTLP gRPC | 1.44.0 | 1.44.0 | **1.44.0** | Isolated import passed; no telemetry exported. |
| OpenInference Pipecat | 2.0.1 | 2.0.3 | **2.0.3** | Patch import passed with Pipecat 1.8.1. |
| Phoenix OTel | 0.16.1 | 0.17.1 | **0.17.1** | `phoenix.otel` import passed; exporter remains optional. |

The other retained session dependencies use the latest compatible stable values
seen in registry metadata: `openpyxl==3.1.5`, `python-multipart==0.0.32`, and
`google-cloud-kms==3.16.0`. Package manifests are added only with the slice that
uses them so ordinary control/CRM development does not acquire the heavy voice
environment prematurely.

## Compatibility evidence

- CPython 3.14.7 isolated voice environment: 147 packages installed and imports
  passed for Pipecat 1.8.1, LiveKit API 1.2.1, Renikud Plus 0.5.0, PyTorch 2.13.0,
  Torchaudio 2.11.0, ONNX Runtime 1.24.4, safetensors 0.8.0, OpenInference 2.0.3,
  Phoenix OTel 0.17.1, and OTLP 1.44.0.
- The import gate did not instantiate Renikud, fetch Hugging Face files, load
  ECAPA weights, contact speech/LLM services, start LiveKit/SIP, or place a call.
- The isolated 162-package voice environment and the current target environment
  both reported no known vulnerabilities through `pip-audit==2.10.1`.
- The 45 imported low-level source/test/fixture files preserve locked-source
  behavior. Adaptations are limited to Python 3.14 annotation modernization,
  target line-length wrapping, and the PostgreSQL test harness described below.
- Low-level retained package suite: 115 passed, one real-PostgreSQL test skipped
  in the ordinary run, and one external LLM evaluation skipped. The PostgreSQL
  RLS helper test then passed separately against the configured local server.
- The completed P5-010 retained Hebrew/agent/dispatcher/voice-service suite
  passes 349 tests. Three deployment-wiring assertions are explicitly skipped
  until the P5-011 LiveKit/SIP/Redis Compose profile exists. Strict Pyrefly,
  Ruff, repository-policy, and secret checks pass for the imported slice.
- Base `uv sync --all-packages --locked` removes the heavy voice/media packages
  and the dispatcher still imports. The explicit `voice-bootstrap` action
  installs the locked uv `voice` group while all real provider flags remain
  false.

The imported RLS test is the only test-harness adaptation in this slice. It now
uses the repository's `postgres`/`rls` markers, skips cleanly when no live DSN is
provided, and normalizes the unified environment's standard PostgreSQL URL to
SQLAlchemy's asyncpg driver form. Long evaluation fixtures were wrapped without
changing their runtime values. Assertions and production behavior are unchanged.

## Authoritative sources

- [Pipecat package metadata](https://pypi.org/project/pipecat-ai/) records the
  stable release, Python support, BSD-2-Clause license, and supported extras.
- [LiveKit API package metadata](https://pypi.org/project/livekit-api/) records
  release 1.2.1, Python support, and Apache-2.0 licensing.
- [LiveKit self-hosted SIP documentation](https://docs.livekit.io/transport/self-hosting/sip-server/)
  confirms that the SIP service is separate and its local Compose topology uses
  Redis; an SFU-only check is not SIP control-plane evidence.
- [Torchaudio installation compatibility](https://docs.pytorch.org/audio/main/installation.html)
  documents Torchaudio 2.11's stable ABI, PyTorch 2.11+ compatibility, and Python
  3.10–3.14 support.
- [cryptography changelog](https://cryptography.io/en/stable/changelog/) records
  the 50.0.1 wheel update and the 50.0.0 security hardening inherited by it.

## Model and asset license gate

Package licensing and model licensing remain separate:

- `renikud-plus` 0.5.0 declares MIT on PyPI. The current RenikudPlus model card
  declares Apache-2.0, but historical repository metadata has also shown
  CC-BY-4.0. The target must pin an exact model revision, checksum, and license
  record before it may fetch or distribute a model. Automatic unpinned download
  is not accepted as the target runtime policy.
- `JaesungHuh/voice-gender-classifier` declares MIT and the referenced
  TaoRuijie ECAPA-TDNN implementation is MIT. The retained Or-on architecture
  also cites an intermediate Jpost port whose exact provenance must be recorded
  before the code/weights enter a distributable image.
- Krisp remains an optional separately licensed SDK/model and is not installed,
  bundled, or selected by this gate.

P5-010 therefore preserves model-dependent behavior behind an operator-owned
local-asset boundary rather than accepting or distributing a model. Renikud and
ECAPA load only when both a local path and exact SHA-256 are configured; ECAPA
also uses `local_files_only=True`. An absent or invalid asset disables the
processor, and there is no network fallback. Model-enabled behavioral parity and
any redistribution decision remain deferred until an exact approved asset has a
recorded immutable revision, checksum, license, and notice. This does not block
provider-free P5-010 integration and prevents accidental downloads.
