from unittest.mock import AsyncMock

import pytest

from app.main import app
from app.middleware.auth import get_admin_user
from app.routers.admin import get_push_service
from app.schemas.push import RoomLiveNotifyResponse


@pytest.mark.asyncio
async def test_admin_notify_live_requires_admin_auth(client):
    response = await client.post(
        "/v1/admin/rooms/00000000-0000-0000-0000-000000000000/notify-live",
        json={"target": "all_active", "dry_run": True},
    )

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_admin_notify_live_dry_run_all_active(client):
    push = AsyncMock()
    push.admin_notify_room_live = AsyncMock(
        return_value=RoomLiveNotifyResponse(
            room_id="00000000-0000-0000-0000-000000000000",
            target="all_active",
            dry_run=True,
            campaign="admin_live_all_active",
            users_considered=2,
            users_eligible=2,
            users_sent=0,
            native_targets=1,
            miniapp_targets=1,
            preference_bypass=True,
        )
    )

    async def _admin_override():
        return 1

    def _push_override():
        return push

    app.dependency_overrides[get_admin_user] = _admin_override
    app.dependency_overrides[get_push_service] = _push_override
    try:
        response = await client.post(
            "/v1/admin/rooms/00000000-0000-0000-0000-000000000000/notify-live",
            json={"target": "all_active", "dry_run": True},
        )
    finally:
        app.dependency_overrides.pop(get_admin_user, None)
        app.dependency_overrides.pop(get_push_service, None)

    assert response.status_code == 200
    assert response.json()["preference_bypass"] is True
    push.admin_notify_room_live.assert_awaited_once_with(
        room_id="00000000-0000-0000-0000-000000000000",
        target="all_active",
        dry_run=True,
    )


@pytest.mark.asyncio
async def test_admin_notify_live_supports_rsvp_target(client):
    push = AsyncMock()
    push.admin_notify_room_live = AsyncMock(
        return_value=RoomLiveNotifyResponse(
            room_id="00000000-0000-0000-0000-000000000000",
            target="rsvps",
            dry_run=False,
            campaign="admin_live_rsvps",
            users_considered=1,
            users_eligible=1,
            users_sent=1,
        )
    )

    async def _admin_override():
        return 1

    def _push_override():
        return push

    app.dependency_overrides[get_admin_user] = _admin_override
    app.dependency_overrides[get_push_service] = _push_override
    try:
        response = await client.post(
            "/v1/admin/rooms/00000000-0000-0000-0000-000000000000/notify-live",
            json={"target": "rsvps", "dry_run": False},
        )
    finally:
        app.dependency_overrides.pop(get_admin_user, None)
        app.dependency_overrides.pop(get_push_service, None)

    assert response.status_code == 200
    assert response.json()["target"] == "rsvps"
    push.admin_notify_room_live.assert_awaited_once_with(
        room_id="00000000-0000-0000-0000-000000000000",
        target="rsvps",
        dry_run=False,
    )
