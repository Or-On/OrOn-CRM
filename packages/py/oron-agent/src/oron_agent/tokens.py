from livekit import api


def mint_room_token(
    api_key: str, api_secret: str, room: str, identity: str, name: str | None = None
) -> str:
    """Return a signed LiveKit JWT granting join to `room` as `identity`."""
    grant = api.VideoGrants(room_join=True, room=room)
    token = api.AccessToken(api_key, api_secret).with_identity(identity).with_grants(grant)
    if name:
        token = token.with_name(name)
    return token.to_jwt()
