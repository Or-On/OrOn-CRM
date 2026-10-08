# Lifecycle audio

Generated offline using Soniox tts-rt-v2, Harper, on 2026-10-08. Five mono PCM16 WAV files at 16,000 Hz; exact text, SHA-256 and durations are retained in provenance.json. Playback never calls a synthesis provider. Missing, corrupt or overlong files must not select another voice.

Reproduce explicitly: `uv run python scripts/generate_announcements.py --allow-offline-provider --output .artifacts/harper-announcements` with SONIOX_API_KEY in the environment. Normal tests never run this command.

Format and duration are verified. Listening acceptance and real-call audibility remain NOT RUN and are required before activation.
