import jwt
from oron_agent.tokens import mint_room_token


def test_token_grants_room_join():
    token = mint_room_token("APIkey", "secretsecretsecret", room="r1", identity="agent-1")
    claims = jwt.decode(
        token, "secretsecretsecret", algorithms=["HS256"], options={"verify_aud": False}
    )
    assert claims["sub"] == "agent-1"
    assert claims["video"]["room"] == "r1"
    assert claims["video"]["roomJoin"] is True
