"""Pipecat BaseTextFilter wrapping the deterministic Hebrew normalizers.

Runs FIRST in the TTS service (text_filters run before text_transforms —
verified against pipecat 1.5.0 TTSService._process_text_frame), producing clean
spelled Hebrew for the pre-spoken AggregatedTextFrame. Adds NO niqqud — that is
the Task 5 transform (vendor-text only). Stateless — the rules it applies are
tenant-agnostic TTS fixes, not configurable values."""

from __future__ import annotations

import re

from pipecat.utils.text.base_text_filter import BaseTextFilter

from oron_hebrew.normalizers import normalize_for_tts
from oron_hebrew.numbers import number_to_hebrew

_STANDALONE_DIGITS_RE = re.compile(r"\b(\d+)\b")


class HebrewNormalizeFilter(BaseTextFilter):
    async def filter(self, text: str) -> str:
        text = normalize_for_tts(text)
        # Any digits the structural rules left behind read in Hebrew (masculine
        # default; the address/time rules already handled gendered contexts).
        return _STANDALONE_DIGITS_RE.sub(lambda m: number_to_hebrew(int(m.group(1))), text)
