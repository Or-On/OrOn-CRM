from dispatcher_runtime.support_context import (
    TenantSupportProfile,
    compile_voice_runtime_prompt,
    terminology_quality_overrides,
)


def test_tenant_identity_overrides_third_party_product_context_generically() -> None:
    profile = TenantSupportProfile(
        displayName="Example Property",
        supportDisplayName="Example Property Support",
        primaryLanguage="he",
        supportedLanguages=["he", "en"],
        authorizedAffiliations=[],
    )

    prompt = compile_voice_runtime_prompt(
        profile,
        agent_prompt="Help the resident troubleshoot Google and Gmail products.",
        persona_gender="female",
    )

    assert "You represent only Example Property Support" in prompt
    assert "third-party product does not make you an employee or representative" in prompt
    assert prompt.endswith(
        "you are the support representative of Example Property Support and no other organization."
    )
    # The compiler contains no provider-name replacement. The product remains
    # valid issue context while the tenant identity remains authoritative.
    assert "Google and Gmail products" in prompt


def test_tenant_terminology_feeds_recognition_and_pronunciation() -> None:
    profile = TenantSupportProfile(
        displayName="Fictional Homes",
        supportDisplayName="Fictional Homes Support",
        primaryLanguage="he",
        terminology=[
            {
                "term": "Or Tower",
                "preferredTerm": "Or Tower Residence",
                "pronunciation": "אוֹר טָאוֶור",
                "language": "he",
            }
        ],
    )

    quality = terminology_quality_overrides(profile)

    assert quality["sttVocabulary"] == ["Or Tower", "Or Tower Residence"]
    assert quality["pronunciationDictionary"] == [
        {
            "original": "Or Tower",
            "spoken": "אוֹר טָאוֶור",
            "language": "he",
            "context": "",
            "testCases": [],
        }
    ]
