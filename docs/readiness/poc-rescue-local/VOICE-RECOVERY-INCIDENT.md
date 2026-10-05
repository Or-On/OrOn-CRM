# Interrupted voice response — 2026-10-05

## Observed incident

Or-On session `06fff647-9f6c-59ce-85e2-787dfd5c6928` was running agent v4 on
release `8e7c7d732d536c00f840416fece8f8e0a2acb71a`. At 16:42:43 UTC, Soniox
capture and synthesis sockets closed during speech. Capture reported no close
frame; synthesis reported a nonfatal connection loss. The caller disconnected
at 16:42:48.880 UTC. The available evidence does not identify whether the
underlying disconnect originated in the network or the provider.

The first transient error previously played the same recording as a terminal
failure: “אירעה תקלה בשיחה. אנא נסו שוב מאוחר יותר. תודה.” The pipeline allowed
one recovery attempt, but that recording told the caller to try later. No
successful recovery was observed before the caller left.

After disconnection, final turn callbacks raced artifact upload and staging
cleanup. Those filesystem errors happened later and did not cause the original
interruption.

## Corrected behavior

- One bounded recovery attempt discards the interrupted model and audio turn,
  resets synthesis without replay, and establishes fresh caller capture before
  playing a separate local recovery recording. No model or synthesis provider
  is needed to play the recording.
- During recovery, local input, model, output and business actions remain
  gated. A fresh local capture generation prevents delayed old transcripts from
  starting work after recovery. Durable operator ownership is unchanged and
  is checked before allowing actions or reopening gates.
- The prompt is “הייתה הפרעה קצרה בקול. אפשר לחזור על המשפט האחרון?” It does not
  claim that the next synthesis request is guaranteed to succeed. TTS opens
  its next socket only when a new turn has actual text to authenticate.
- A second outage, permanent failure or unsuccessful bounded recovery uses
  terminal failure handling. Operator takeover preserves the human call leg.
- Artifact upload and staging removal wait until pipeline cleanup has drained
  final turn callbacks. Filesystem writes retain their lock through physical
  completion even when their coroutine is cancelled. Failed draining or final
  reconstruction retains staging instead of uploading an incomplete transcript.
- Synthesis disconnect diagnostics record stage, exception type and numeric
  close codes, without close reasons, provider payloads or customer text.

## Verification

Tests use actual loopback WebSockets and the installed Pipecat worker. TCP is
aborted after partial PCM has reached downstream. The tests verify one recovery,
fresh-turn audio, no replay, concurrent capture/synthesis failures, and terminal
cleanup on a second outage. Ownership tests cover takeover and late transcripts;
lifecycle tests delay final callbacks and inspect uploaded transcript content.

Offline tests cannot establish carrier audibility or external provider
availability. A fresh real call after the exact revision is deployed is the
remaining acceptance check. No provider credentials, tenant bindings, scripts,
agent versions, paid subscriptions or customer conversations are changed by
this runtime repair.

## Additional image-runtime gap found before deployment

The locked voice SDK lazily uses NLTK for sentence splitting and for regrouping
streamed TTS tokens. Runtime images intentionally remove NLTK because its model
artifact APIs have an unresolved advisory. The previous image smoke only
imported the application, so it did not exercise that lazy path. An isolated
run with NLTK imports denied reproduced `ModuleNotFoundError` while processing
ordinary multi-sentence speech. This is separate from the observed socket loss.

The voice factory now installs application-owned sentence handling and a
per-instance token sequencer. It preserves streaming text, interruption and
audio ordering without downloading tokenizer data or restoring NLTK. Both
voice-capable image builds execute a provider-free sentence/token smoke test
after removing NLTK, including Hebrew and length-changing text transformation.
The build must fail if those runtime paths fail.
