"""How a flow sounds, authored with the flow rather than deployed with the fleet.

Voice is a property of the script, not of the machine: two flows on one
deployment can want different vendors, different voices, and — until it is
measured — different answers on whether to point Hebrew before synthesis. This
is the middle level the console was missing, between a per-call experiment and
an environment variable that moves every tenant at once.

Every field is optional and means "whatever is deployed". Precedence is
deployment default < flow < per-call override, so an experiment from the
console still wins for the length of one call.
"""

from enum import StrEnum

from pydantic import BaseModel, Field

# Both vendors take a rate multiplier, over different ranges: Soniox 0.7–1.3,
# Gemini 0.25–2.0. Bounded by the narrower one so a flow keeps a legal value
# when it switches provider — a number the vendor rejects is a silent failure
# on the one path nobody is watching.
SPEED_MIN, SPEED_MAX = 0.7, 1.3


class TtsProvider(StrEnum):
    SONIOX = "soniox"
    GEMINI = "gemini"


class FlowVoice(BaseModel):
    tts_provider: TtsProvider | None = None
    tts_voice: str | None = None
    """The vendor's own voice name. Vendor-specific — "Leda" is not a Soniox
    voice — so it travels with the provider that understands it."""
    tts_niqqud: bool | None = None
    """Point Hebrew before sending it to the vendor. A per-flow answer because
    it is a per-vendor, per-voice question that no measurement has settled."""
    tts_speed: float | None = Field(default=None, ge=SPEED_MIN, le=SPEED_MAX)
    """Rate multiplier; 1.0 is the vendor's own pace. Hebrew read at an English
    cadence sounds slow, and the right number is a property of the language and
    the voice, so the flow is where it belongs."""
