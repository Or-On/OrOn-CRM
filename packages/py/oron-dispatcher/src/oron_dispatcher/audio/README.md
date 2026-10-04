Fixed lifecycle announcements generated offline on 2026-10-03 with the installed
Microsoft Asaf Hebrew voice. Mono signed PCM16 WAV, 16,000Hz. No model or external
TTS request is required during playback.

- `busy-he.wav` (6.07s): כל הנציגים עסוקים כרגע. אנא נסו שוב בעוד כמה דקות. תודה.
- `goodbye-he.wav` (4.31s): אנחנו מסיימים כעת את השיחה. תודה ולהתראות.

The adapter validates format/duration, waits for a subscriber, uses 20ms frames,
waits for playout, and closes the room connection/audio source under bounded
deadlines. Live SIP audibility, Hebrew listening quality and cap-plus-one / active
call deployment acceptance remain mandatory after an approved deployment.

- `failure-he.wav`: אירעה תקלה בשיחה. אנא נסו שוב מאוחר יותר. תודה.
  Fixed truthful provider-failure audio; no promise of a human transfer or task.
  Generated locally using the existing OneCore Asaf token without registry changes.

- `unavailable-he.wav`: השירות אינו זמין כעת. אנא נסו שוב מאוחר יותר. תודה.
  Fixed unpublished/unavailable-agent refusal, without provider synthesis.
