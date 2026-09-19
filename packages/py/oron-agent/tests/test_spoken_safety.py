import pytest
from oron_agent.spoken_safety import BusinessClaimGuardFilter


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "claim",
    [
        "מצאתי את פרטי המנוי שלך.",
        "אני רואה שהממיר שלך מדגם מסוים.",
        "אצטרך את מספר תעודת הזהות שלך כדי לבדוק את המנוי.",
        "אפתח עבורך קריאת שירות ואשלח הודעת ווטסאפ.",
        "תיאמתי טכנאי למחר.",
    ],
)
async def test_unverified_business_claims_are_suppressed(claim):
    output = await BusinessClaimGuardFilter(lambda: "he").filter(claim)

    assert (
        output
        == "אין לי גישה מאומתת למערכת הזאת בשיחה הנוכחית, ולכן אי אפשר לאשר מכאן שבוצעה פעולה."
    )


@pytest.mark.asyncio
async def test_general_troubleshooting_guidance_is_preserved():
    text = "נתק את הממיר מהחשמל וחבר אותו מחדש. האם התקלה נפתרה?"

    assert await BusinessClaimGuardFilter().filter(text) == text


@pytest.mark.asyncio
async def test_identity_collection_is_allowed_only_while_the_backend_gate_is_active():
    request = "אצטרך את מספר תעודת הזהות שלך כדי להשלים את האימות."

    assert await BusinessClaimGuardFilter(lambda: "he", lambda: True).filter(request) == request
    assert await BusinessClaimGuardFilter(lambda: "he", lambda: False).filter(request) != request


@pytest.mark.asyncio
async def test_perfect_tense_unverified_action_claim_is_suppressed():
    output = await BusinessClaimGuardFilter(lambda: "en").filter(
        "Private reasoning: I have refunded your payment secret-token."
    )

    assert output == (
        "I don't have verified access to that system in this call, so I can't confirm that action."
    )


@pytest.mark.asyncio
async def test_ticket_claim_is_allowed_only_after_a_verified_receipt():
    claim = "פתחתי עבורך קריאת שירות מספר T-2026-12345678."

    assert await BusinessClaimGuardFilter(lambda: "he").filter(claim) != claim
    assert await BusinessClaimGuardFilter(lambda: "he", None, lambda: True).filter(claim) == claim
