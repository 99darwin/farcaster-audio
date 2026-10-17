"""Regression: spaces-discovery responses must be snake_case.

The schemas (`AudioRoom`, `SpaceUser`, `AudioRoomParticipant`, ...)
carry camelCase aliases on snake_case fields to absorb upstream
Farcaster payloads via `populate_by_name=True`. FastAPI's response
serialization, however, defaults to `by_alias=True` — which would
flip every aliased field BACK to camelCase on the way out. The
frontend types are snake_case, so an aliased response yields
`undefined` for `display_name` / `pfp_url` / `listener_count` etc.
and the UI silently falls back to initials / 0 / username.

Each discovery route sets `response_model_by_alias=False`. This test
guards that — if anyone removes the flag, the assertion below fails
before the bug ships.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest
from jose import jwt

from app.config import settings
from app.main import app
from app.routers import spaces_discovery
from app.schemas.farcaster_spaces import AudioRoom


def _first_party_header(fid: int = 7777) -> dict[str, str]:
    token = jwt.encode(
        {"fid": fid, "exp": 4_102_444_800},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def _mock_spaces_service():
    """Install a mock FarcasterSpacesService on app.state that returns
    one fully-populated AudioRoom on /live."""
    room = AudioRoom.model_validate(
        {
            "id": "019e0000-0000-0000-0000-000000000001",
            "title": "Snake-case repro",
            "state": "live",
            "startedAt": "2026-06-10T20:00:00Z",
            "listenerCount": 7,
            "rootCastHash": "0xdeadbeef",
            "host": {
                "fid": 42,
                "username": "alice",
                "displayName": "Alice",
                "pfpUrl": "https://example.com/alice.png",
            },
        }
    )
    svc = AsyncMock()
    svc.list_live_rooms = AsyncMock(return_value=[room])
    previous = getattr(app.state, "farcaster_spaces_service", None)
    app.state.farcaster_spaces_service = svc
    try:
        yield svc
    finally:
        if previous is not None:
            app.state.farcaster_spaces_service = previous
        else:
            try:
                del app.state.farcaster_spaces_service
            except AttributeError:
                pass


@pytest.mark.asyncio
async def test_live_response_uses_snake_case_field_names(client, _mock_spaces_service):
    """Both outer and nested host fields must come back as snake_case.

    The frontend type `FarcasterNativeSpace` (and its `host` shape)
    keys off `display_name`, `pfp_url`, `listener_count`, etc. — if the
    response uses the camelCase aliases (`displayName`, `pfpUrl`,
    `listenerCount`), those frontend fields read `undefined` and the
    UI silently falls back to initials / 0 / username.
    """
    # Skip the enrichment branch — patch out the helper so the route
    # returns the upstream-validated payload unchanged.
    with patch.object(
        spaces_discovery, "_enrich_user_pfps", AsyncMock(return_value=None)
    ):
        resp = await client.get(
            "/v1/farcaster-spaces/live", headers=_first_party_header()
        )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert isinstance(body, list) and len(body) == 1
    room = body[0]

    # Outer field names must be snake_case.
    assert "started_at" in room
    assert "listener_count" in room
    assert "root_cast_hash" in room
    # And the camelCase aliases MUST NOT appear.
    assert "startedAt" not in room
    assert "listenerCount" not in room
    assert "rootCastHash" not in room

    # Nested host must also be snake_case.
    host = room["host"]
    assert host["display_name"] == "Alice"
    assert host["pfp_url"] == "https://example.com/alice.png"
    assert "displayName" not in host
    assert "pfpUrl" not in host
