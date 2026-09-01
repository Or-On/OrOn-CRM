# OpenLive persistence map

Locked source: `../openlive` at
`849173cd1c8c17a95d600b17b428c301722bf5df`. The map is based on the actual
`packages/db`, agent service, API routes, desktop shell, and browser persistence
code—not README summaries.

| Source store / key | Actual source semantics | Canonical target | Import/runtime disposition |
| --- | --- | --- | --- |
| `data/openlive.db` `chats` | Title, create/update time, agent ID, workspace cwd, ACP session ID | `live.chats`, tenant/user scoped | One-time SQLite importer; PostgreSQL adapter at runtime. |
| `data/openlive.db` `messages` | Append `seq`, source ID, chat, role, JSON message blocks, live flag, instant | `live.messages` with stable per-chat sequence and JSONB content | One-time SQLite importer; preserves same-timestamp order. |
| `conversations.json` | Older chats/messages format migrated by OpenLive to SQLite | Same `live.chats/messages` | Importer accepts directly and deduplicates against SQLite/source IDs. |
| `providers.json` | Provider kind/name/default, encrypted API-key blob, last four | `live.provider_configurations` + canonical credential reference | Metadata imported; ciphertext is never decrypted/logged. Credential rewrap is a separate approved process. |
| `settings.json` general keys | live model/provider/effort, vision model/provider, default cwd, instructions, narration | `live.user_preferences` typed key/JSONB value | Imported per destination tenant/user with allowlisted keys. |
| `settings.json` per-agent/per-chat keys | `bind:*`, `agentCwd:*`, `acpSession:*`, `acpCommand:*`, `agentHidden:*` | Chat fields/session refs and scoped user preferences | Imported with explicit chat/agent ID mapping; command overrides are sensitive settings. |
| `settings.json` private keys | `exa_api_key`, `agent_notes` | Credential reference; private agent memory preference | Never exposed/logged; plaintext secret import prohibited. |
| `voice-profiles.json` | Profile name, transcript, WAV filename, created time, duration | `live.voice_profiles` + `objects.object_metadata` | Metadata/checksum import; WAV bytes copied to approved object storage separately. |
| `data/voices/*.wav` | Voice-cloning reference audio | Mounted object directory / future GCS | Binary is not stored in PostgreSQL; consent/retention status is metadata. |
| `data/.enc-key` | Auto-generated local AES key for JSON provider secrets | No database row | Never imported as a target master key; future master key remains outside PostgreSQL. |
| `data/models/zipvoice` and browser model cache | Downloaded model artifacts/cache readiness | Device/cache management, not business DB | Not imported as authoritative data; model selection persists separately. |
| `data/scratch` | Temporary work | None | Not imported. |
| Harness model catalog cache | Download/cache optimization | Cache only | Not authoritative; no import. |
| Browser `openlive-pipeline-v1` | VAD/STT/turn/TTS engine, model, voice, thresholds/speed | `live.user_preferences` for sync plus device-local override/cache | Import optional through an explicit browser export; remains safe to keep device-local. |
| Browser conversation keys | bind, cwd, resume session; recent folders | Chat/session fields and user preferences | Server values become authoritative; browser cache may remain a replica. |
| Browser agent metadata/model/mode/options | Last ACP capabilities and user selections | User preference + non-authoritative capability cache | Persist choices; refresh capabilities from agent. |
| Browser UI-only flags | panels, tour, hotkey, PTT, debug, disclosure/filter | Device-local preferences | No required database import. |
| External coding-agent session files | Agent-owned transcript/session state | `live.sessions.external_session_id` reference only | Do not copy or claim ownership; OpenLive message replay remains separately imported. |
| Desktop window/PID/autostart files | Local shell/process state | Device-local | No database import. |

## Target distinctions

OpenLive live-agent chats are not WhatsApp conversations. They share canonical
tenant/user/contact/agent references only where semantically valid. Message block
content stays versioned JSONB because ACP/tool blocks vary; role, sequence,
timestamps, session, and tenancy remain normalized. Provider secrets are
credential references, never embedded in preference JSON.

The legacy importer lives under `db/importers/openlive_legacy/`, is not in any
runtime package, and may use Python's SQLite reader only there. It supports
explicit source paths, destination tenant/user, dry-run plans, deterministic ID
mapping, source checksums, duplicate detection, resumable import ledgers, and
PII-safe diagnostics. PostgreSQL writes and idempotency execution are **PENDING
LIVE POSTGRESQL VALIDATION — PHASE 2B**.
