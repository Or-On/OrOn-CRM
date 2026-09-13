# Voice AI quality implementation matrix

Baseline: 2026-09-12, `codex/phase-7-ui-polish`, HEAD
`7afa8534fc89259cd679da7ff58ec7546bd01b14`; 555 pre-existing changed paths.
No commits, branch reset, provider requests, app/worker restart or `.env` changes
are authorized by this checkpoint. Upstream references are read-only.

The complete `docs/audit/voice-ai-quality-master-prompt.md` governs this work.
This matrix tracks implementation, not a claim of production speech quality.

| Stage                         | Existing authority / path                                               | Finding                                                                      | Implemented direction / evidence                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator → published agent    | CRM cross-channel profiles, immutable versions, orchestration inspector | No approved knowledge/version editor; quality knobs fragmented               | `agent-quality.ts`, versioned quality/knowledge selection and evaluation UI; management evidence                                                                                    |
| Admission → dispatcher        | Canonical voice flow, RBAC/consent, dispatcher PostgreSQL adapter       | Agent prompt resolved but knowledge/quality not carried                      | Pin agent version/quality once per call; tenant-scoped current knowledge reads                                                                                                      |
| Inbound audio → STT           | LiveKit input, hold opener, Soniox, VAD/turn strategy                   | Provisional/final boundaries implicit                                        | Explicit acceptance processor, raw/accepted separation, supported bounded Soniox terms                                                                                              |
| Caller address                | Context before user aggregator                                          | Quoted/negated requests and conflicting corrections                          | Preference precedence fixes; no new acoustic model; independent agent grammar                                                                                                       |
| Accepted input → LLM          | Pipecat context, Vertex or configured compatible endpoint               | History and prose could assert unsupported business facts                    | Fresh eligible evidence block, no caller/history-as-proof, closed output selections                                                                                                 |
| Routing / tools               | `goto`, `route_by`, `collect_gate`, configured transfer action          | Routing/collected arguments are not verified business operations             | No invented financial/customer lookup tools; no voice business completion receipts                                                                                                  |
| LLM → complete turn           | HebrewTurnPlanner                                                       | Stale/orphan output and punctuation could escape after interruption          | Bounded complete-turn buffering, stale text suppression, JSON preservation                                                                                                          |
| Complete turn → speech        | New evidence gate, existing safety filter                               | Regex-only spoken protection missed material claims                          | Exact eligible fact or bounded conversation rendering; fresh eligibility recheck                                                                                                    |
| Text → TTS                    | Soniox/Gemini, Hebrew normalizers, authored lexicon                     | Time minutes, grouped amounts and generic digit joining could change meaning | Semantic regressions fixed; validated pronunciation only on speech path; no global niqqud switch                                                                                    |
| TTS → transport               | Leading-silence trim, LiveKit output                                    | Trim buffer cancellation / onset loss                                        | Reset on interruption, onset preroll; real acoustic effect pending                                                                                                                  |
| Transcript / recording / cost | Existing session recorder, two-channel artifacts, usage observer        | Generated text is not exact proof of what a caller heard                     | Preserve existing artifacts/cost; quality observations explicitly mark exact playback unknown                                                                                       |
| WhatsApp → AI → call          | Durable jobs, ownership epoch, approved profile, callback admission     | Older jobs could select later inbound intent; free generated claims          | Trigger binding, exact grounded answers, server-derived action status, post-delay/per-attempt rechecks                                                                              |
| Source revocation / isolation | PostgreSQL tenant RLS                                                   | No immutable approved knowledge lifecycle                                    | Knowledge successor migration; latest-version validity/revocation, conflict rejection, tenant/RBAC tests                                                                            |
| Active-call AI control        | New durable PostgreSQL command/acknowledgement, existing Pipecat worker | No dependable operator pause/resume in the call view                         | Epoch/idempotency-bound pause, processing barriers, acknowledged state, explicit resume; not human media connection                                                                 |
| Pronunciation preview         | Existing Soniox/Gemini TTS adapter, protected management API            | No operator playback of the published pronunciation configuration            | Explicit paid TTS-only preview, bounded ephemeral WAV, canonical/spoken text, fresh authorization; no automatic provider request                                                    |
| Evaluation                    | Existing unit/integration suites, new protected typed-model endpoint    | No acoustic baseline for this revision                                       | Versioned fictional text corpus; explicit paid read-only LLM scenario with current source validation, no tools/audio; configured-provider/native-listening acceptance still pending |

## Important boundaries

- A model's fact selection is not trusted prose. The server resolves the exact
  published source/document/version/key; numbers and qualifications come from it.
- The conservative conversation renderer intentionally limits unconstrained
  model prose. This is a safety/product tradeoff requiring real conversational
  evaluation; an arbitrary persona prompt is not an approved business policy.
- No payment, booking, discount, eligibility or identity-verification service is
  invented. Voice routing does not establish these facts. The configured SIP
  transfer capability is separate from a promised successful human connection.
- Source eligibility is current at retrieval and before speech/delivery. Already
  transmitted audio cannot be recalled; exact far-end playback is not available.
- Existing authored flow scripts and transfer configuration remain operator-owned.
  Their wording/targets require review; this task does not retrofit a financial
  backend or prove every authored script safe merely because it was published.
- Provider models, environment credentials and working transport defaults remain
  unchanged. No paid STT, TTS, LLM, call, WhatsApp or provider configuration occurs.

See `results.md`, `source-claim-policy.md`, `evaluation-runbook.md`, and the
runtime/management/WhatsApp audit notes for evidence and remaining gates.
