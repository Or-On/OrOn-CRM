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
    output = await BusinessClaimGuardFilter().filter(claim)

    assert output == (
        "אין לי גישה למערכת המנויים או אפשרות לפתוח קריאת שירות בשיחה הזאת. "
        "אפשר להעביר את הפרטים לנציג אנושי?"
    )


@pytest.mark.asyncio
async def test_general_troubleshooting_guidance_is_preserved():
    text = "נתק את הממיר מהחשמל וחבר אותו מחדש. האם התקלה נפתרה?"

    assert await BusinessClaimGuardFilter().filter(text) == text
