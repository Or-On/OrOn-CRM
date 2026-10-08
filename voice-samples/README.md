# Reviewed voice candidates

These are actual offline Soniox `tts-rt-v2` generations, not renamed legacy audio.
Both samples say: “היי, אני נציגת השירות. אשמח לעזור ולשלוח את הקישור בוואטסאפ.”

| File                     | Requested voice | Duration         |
| ------------------------ | --------------- | ---------------- |
| [harper.wav](harper.wav) | Harper          | 4.693375 seconds |
| [grace.wav](grace.wav)   | Grace           | 4.352 seconds    |

Both are mono, 16 kHz, PCM16 WAV. Exact hashes, generation timestamp and provider
metadata are in [provenance.json](provenance.json). Grace was available for this
generation. Harper is the canonical application voice; these samples do not
activate either voice in an operational tenant.

Human listening acceptance: **NOT RUN**. Real telephone-call acceptance:
**NOT RUN**. Format and duration checks cannot establish pronunciation quality.
Listen specifically to “וואטסאפ”, feminine first-person wording, number reading,
sentence endings and interruption recovery before approving deployment.

The five lifecycle announcements and their independent provenance are under
`packages/py/oron-dispatcher/src/oron_dispatcher/audio/`. Regenerate only through
`scripts/generate_announcements.py` with its explicit provider opt-in. Normal CI
does not contact Soniox.
