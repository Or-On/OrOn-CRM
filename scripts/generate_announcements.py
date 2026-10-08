"""Explicit offline Soniox generation; never called by tests or runtime startup."""

import argparse
import hashlib
import io
import json
import os
import wave
from datetime import UTC, datetime
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
TEXTS = {
    "busy": "כל הנציגים עסוקים כרגע. אנא נסו שוב בעוד כמה דקות. תודה.",
    "goodbye": "אנחנו מסיימים כעת את השיחה. תודה ולהתראות.",
    "failure": "אירעה תקלה בשיחה. אנא נסו שוב מאוחר יותר. תודה.",
    "unavailable": "השירות אינו זמין כעת. אנא נסו שוב מאוחר יותר. תודה.",
    "recovery": "הייתה הפרעה קצרה בקול. אפשר לחזור על המשפט האחרון?",
}


def validate_wav(data: bytes) -> float:
    with wave.open(io.BytesIO(data)) as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16000, 1, 2):
            raise ValueError("Expected mono 16kHz PCM16")
        duration = wav.getnframes() / wav.getframerate()
        if not 0 < duration <= 8 or len(wav.readframes(wav.getnframes())) != wav.getnframes() * 2:
            raise ValueError("Truncated or overlong announcement")
        return duration


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-offline-provider", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--comparison-samples", action="store_true")
    args = parser.parse_args()
    if not args.allow_offline_provider:
        parser.error("Explicit --allow-offline-provider is required")
    key = os.environ.get("SONIOX_API_KEY")
    if args.env_file:
        from dotenv import dotenv_values

        key = dotenv_values(args.env_file).get("SONIOX_API_KEY")
    if not key:
        parser.error("SONIOX_API_KEY is unavailable")
    policy = json.loads((ROOT / "db/contracts/agent-runtime-policy.v1.json").read_text("utf-8"))
    voice = policy["voice"]
    args.output.mkdir(parents=True, exist_ok=True)
    with httpx.Client(timeout=45, headers={"Authorization": f"Bearer {key}"}) as client:
        response = client.get("https://api.soniox.com/v1/tts-models")
        response.raise_for_status()
        models = response.json()["models"]
        model = next((item for item in models if item["id"] == voice["model"]), None)
        if not model:
            raise RuntimeError("Canonical TTS model unavailable")
        voices = {item["id"] for item in model.get("voices", [])}
        if voice["voice"] not in voices:
            raise RuntimeError("Canonical Harper voice not in provider model metadata")
        artifacts = []
        comparison = "היי, אני נציגת השירות. אשמח לעזור ולשלוח את הקישור בוואטסאפ."
        selections = (
            [
                (name.lower(), name, comparison)
                for name in (voice["voice"], "Grace")
                if name in voices
            ]
            if args.comparison_samples
            else [(name, voice["voice"], text) for name, text in TEXTS.items()]
        )
        for name, selected_voice, text in selections:
            result = client.post(
                "https://tts-rt.soniox.com/tts",
                json={
                    "model": voice["model"],
                    "voice": selected_voice,
                    "language": "he",
                    "audio_format": "pcm_s16le",
                    "sample_rate": 16000,
                    "text": text,
                },
            )
            result.raise_for_status()
            # Raw PCM avoids streaming WAV headers with unknown RIFF lengths.
            if not result.content or len(result.content) % 2:
                raise ValueError("Invalid PCM payload")
            buffer = io.BytesIO()
            with wave.open(buffer, "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(16000)
                output.writeframes(result.content)
            data = buffer.getvalue()
            seconds = validate_wav(data)
            filename = f"{name}.wav" if args.comparison_samples else f"{name}-he.wav"
            (args.output / filename).write_bytes(data)
            artifacts.append(
                {
                    "file": filename,
                    "voice": selected_voice,
                    "text": text,
                    "seconds": seconds,
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
            )
        manifest = {
            "provider": "soniox",
            "model": voice["model"],
            "voice": voice["voice"],
            "generatedAt": datetime.now(UTC).isoformat(),
            "listeningAccepted": False,
            "artifacts": artifacts,
            "graceAvailable": "Grace" in voices,
        }
        (args.output / "provenance.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", "utf-8"
        )
        print(json.dumps({"generated": len(artifacts), "listeningAccepted": False}))


if __name__ == "__main__":
    main()
