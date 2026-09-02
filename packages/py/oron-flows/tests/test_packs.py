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
