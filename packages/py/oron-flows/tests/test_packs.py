import pytest
from oron_flows.packs import LANGUAGE_PACKS, build_persona, load_language_pack


def test_unknown_language_falls_back_to_english():
    assert load_language_pack("xx").code == "en"


def test_persona_interpolates_identity_and_gendered_self_reference():
    persona = build_persona(
        load_language_pack("he"),
        agent_name="נועה",
        org="ארגון",
        gender="female",
        pronunciations={},
    )
    assert "נועה" in persona and "ארגון" in persona and "אני בודקת" in persona
    assert "${" not in persona


def test_male_persona_selects_masculine_self_reference():
    persona = build_persona(
        load_language_pack("he"), agent_name="דני", org="ארגון", gender="male", pronunciations={}
    )
    assert "אני בודק," in persona


def test_every_pack_declares_the_full_contract():
    for code in ("he", "en"):
        pack = load_language_pack(code)
        assert pack.persona_template and pack.code == code
        assert "ONE question at a time" in pack.persona_template
        assert "latest point first" in pack.persona_template


def test_brand_pronunciation_comes_from_the_flow_not_the_pack():
    """A tenant's vocabulary must never be baked into a shared language pack."""
    for pack in LANGUAGE_PACKS.values():
        assert "דלונגי" not in pack.persona_template and "DELONGHI" not in pack.persona_template
    for code in ("he", "en"):
        persona = build_persona(
            load_language_pack(code),
            agent_name="a",
            org="o",
            gender="female",
            pronunciations={"DELONGHI": "דלונגי"},
        )
        assert "DELONGHI -> דלונגי" in persona


def test_no_pronunciations_leaves_no_dangling_header():
    persona = build_persona(
        load_language_pack("he"), agent_name="a", org="o", gender="female", pronunciations={}
    )
    assert "PRONUNCIATION" not in persona


def test_voice_personas_keep_model_jargon_out_and_offer_a_next_step():
    """The agent must not narrate its own machinery — but "don't volunteer it"
    is a different rule from "never admit it", and only the first is wanted."""

    for language in ("he", "en"):
        persona = build_persona(
            load_language_pack(language),
            agent_name="Noa",
            org="Or-On",
            gender="female",
            pronunciations={},
        )
        assert "Do not volunteer that you are an AI" in persona
        assert "never cite internal policies" in persona
        assert 'Never say "as an AI"' in persona
        assert "offer one\n  useful next step" in persona
        assert "Never write or spell a punctuation name" in persona


def test_hebrew_persona_stays_neutral_without_trusted_gender_context():
    persona = build_persona(
        load_language_pack("he"),
        agent_name="Noa",
        org="Or-On",
        gender="female",
        pronunciations={},
    )
    assert "Do not guess the caller's gender" in persona
    assert "Never fall back to masculine" in persona
    assert 'Say "סליחה, טעיתי"' in persona


def _persona(code: str) -> str:
    return build_persona(
        LANGUAGE_PACKS[code],
        agent_name="Noa",
        org="Or-On Support",
        gender="female",
        pronunciations={},
    )


@pytest.mark.parametrize("code", sorted(LANGUAGE_PACKS))
def test_every_persona_discloses_truthfully_when_asked(code: str) -> None:
    """Sounding natural is not permission to deny being a machine.

    The rule used to be a flat "never identify yourself as an AI", which leaves
    a caller asking "am I talking to a robot?" no truthful answer available.
    """

    persona = _persona(code)
    assert "Do not volunteer that you are an AI" in persona
    assert "answer truthfully and briefly" in persona
    assert "Never claim to be human" in persona
    assert "never deny it when asked" in persona
    assert "Never identify yourself as an AI" not in persona


@pytest.mark.parametrize("code", sorted(LANGUAGE_PACKS))
def test_no_persona_instructs_the_agent_to_pose_as_a_person(code: str) -> None:
    persona = _persona(code).lower()
    for forbidden in (
        "pretend to be human",
        "pretend you are human",
        "say you are a human",
        "you are a human employee",
        "never admit",
        "deny that you are",
    ):
        assert forbidden not in persona


@pytest.mark.parametrize("code", sorted(LANGUAGE_PACKS))
def test_no_persona_claims_a_body_or_physical_errand(code: str) -> None:
    persona = _persona(code)
    assert "never invent a" in persona
    assert "you will personally walk over" in persona


def test_the_disclosure_names_the_tenant_not_the_platform() -> None:
    persona = _persona("en")
    assert "Or-On Support's automated assistant" in persona
    assert "${org}" not in persona


def test_hebrew_defaults_to_hebrew_without_forbidding_a_switch() -> None:
    persona = _persona("he")
    assert "Hebrew is this flow's language" in persona
    assert "If the caller is speaking another language, or asks you to switch" in persona
    assert "Speak ONLY in Hebrew" not in persona
