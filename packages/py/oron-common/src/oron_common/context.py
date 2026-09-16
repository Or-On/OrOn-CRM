import uuid
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class Direction(StrEnum):
    """Which side placed the call.

    BROWSER is not a third side — it is the console's mic with no PSTN leg at
    all. It exists because a test call recorded as `inbound` is indistinguishable
    from a voter's, which silently mixes rehearsals into the campaign's numbers.
    """

    INBOUND = "inbound"
    OUTBOUND = "outbound"
    BROWSER = "browser"


def new_session_id() -> uuid.UUID:
    """Fresh UUID4 — the primary key for a session (recording, API record)."""
    return uuid.uuid4()


class CallContext(BaseModel):
    """Per-call context handed from the transport layer to the agent."""

    call_id: str
    # The transport, not the carrier — carriers are swapped in the SIP trunk's
    # allowed_addresses and never reach the agent.
    provider: Literal["livekit"] = "livekit"
    direction: Direction
    from_number: str | None = None
    to_number: str | None = None
    # Bound from the dialed DID inbound, stated by the caller outbound.
    flow_id: uuid.UUID
    # Optional immutable bindings from the authenticated dispatch command.
    # Older callers may omit these; the runtime resolves their published flow.
    flow_version: int | None = Field(default=None, ge=1, strict=True)
    agent_version_id: uuid.UUID | None = None
    # Required: a call is only ever served for a known tenant — inbound the DID
    # must resolve to one, outbound the caller names one. The agent needs it to
    # fetch its flow, so it travels with the call rather than beside it.
    tenant_id: uuid.UUID
    session_id: uuid.UUID = Field(default_factory=new_session_id)
    # Chosen per call (e.g. to match the caller's gender); falls back to the
    # GEMINI_TTS_VOICE default in Settings when the transport doesn't set it.
    tts_voice: str | None = None
    # A trusted operator/contact preference, never an acoustic guess. Hebrew
    # address forms cannot be reliably made neutral in every sentence, so an
    # outbound caller may bind one form for the complete call.
    caller_gender: Literal["male", "female"] | None = None
    # Optional cross-channel provenance. Private conversation content is never
    # transported in this context: the opaque, canonical handoff is verified by
    # the persistence boundary before the voice runtime can unlock any data.
    contact_id: uuid.UUID | None = None
    source_conversation_id: uuid.UUID | None = None
    handoff_id: uuid.UUID | None = None
    raw_metadata: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def _cross_channel_references_are_complete(self) -> CallContext:
        references = (self.contact_id, self.source_conversation_id, self.handoff_id)
        if (self.source_conversation_id is not None or self.handoff_id is not None) and not all(
            value is not None for value in references
        ):
            raise ValueError(
                "contact_id, source_conversation_id and handoff_id must be supplied together"
            )
        return self
