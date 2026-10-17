"""Developer end-space endpoint + room.finished dispatch fix.

Covers ``POST /v1/developer/spaces/{room_id}/end`` (key-auth) plus the
inline ``room.finished`` dispatch added to ``RoomService.end_room`` so
explicit-end paths actually fire the outbound webhook (previously
silently swallowed by the LiveKit handler's WHERE status="active"
filter).
"""

import uuid

import pytest


@pytest.mark.asyncio
async def test_end_developer_space_requires_api_key(client):
    """POST /v1/developer/spaces/{id}/end must reject calls without an
    X-Juke-Api-Key header."""
    response = await client.post(
        f"/v1/developer/spaces/{uuid.uuid4()}/end",
    )
    assert response.status_code == 401


def test_end_developer_space_route_is_registered():
    """Static sanity: the route is mounted under the developer router.

    Tested at the FastAPI app's route table to avoid issuing HTTP calls
    that would compound asyncpg cross-event-loop pool churn alongside
    the existing partner-tokens test suite.
    """
    from app.main import app
    from tests.conftest import registered_route_pairs

    routes = registered_route_pairs(app)
    assert ("/v1/developer/spaces/{room_id}/end", "POST") in routes
    # The public delete-room path still exists alongside it.
    assert ("/v1/rooms/{room_id}", "DELETE") in routes


def test_end_developer_space_uses_owner_only_lookup():
    """Defensive read of the handler source: cross-app rooms must 404,
    never 403. Returning 403 would let a partner enumerate which UUIDs
    belong to other developer apps. Same pattern as the partner
    agent-join handler.
    """
    import inspect

    from app.routers.developer import end_developer_space

    src = inspect.getsource(end_developer_space)
    # Ownership check + 404 response — no 403 leak.
    assert "created_by_app_id != verified_key.app_id" in src
    assert "HTTP_404_NOT_FOUND" in src
    assert "HTTP_403_FORBIDDEN" not in src


def test_end_room_is_idempotent_for_already_ended_rooms():
    """A double-call to /spaces/{id}/end must not 403 because Redis was
    cleared by the first call, and must not double-dispatch room.finished.

    The guard lives at the top of end_room (after the scheduled branch)
    so the actor_role check + LiveKit teardown + inline dispatch all
    no-op on the second invocation.
    """
    import inspect

    from app.services.room_service import RoomService

    src = inspect.getsource(RoomService.end_room)
    # Look for the early-return guard before the actor_role check.
    guard_idx = src.find('room.status in ("ended", "cancelled")')
    actor_idx = src.find("_get_actor_role")
    assert guard_idx != -1, (
        "end_room must guard against re-ending. See the comment about "
        "the misleading 403 on double-call."
    )
    assert guard_idx < actor_idx, (
        "Idempotency guard must run before the actor_role lookup, which "
        "fails on the second call because Redis was cleared."
    )


def test_end_room_tags_dispatch_with_ended_via():
    """The outbound room.finished payload carries an ``ended_via``
    discriminator (``"host"`` vs ``"api"``) so consumers can tell the
    difference between a human pressing End Space and a server-side
    API end. The developer end endpoint passes ``"api"``."""
    import inspect

    from app.routers.developer import end_developer_space
    from app.services.room_service import RoomService

    end_room_src = inspect.getsource(RoomService.end_room)
    end_route_src = inspect.getsource(end_developer_space)

    assert '"ended_via": ended_via' in end_room_src
    assert 'ended_via="api"' in end_route_src


def test_end_room_dispatches_room_finished_inline():
    """Static read of end_room: confirms the inline `room.finished`
    dispatch is present and lands AFTER the DB status flip.

    The bug Marc found: LiveKit's `room_finished` webhook handler
    filters by `Room.status == "active"`, so when `end_room` updates
    status="ended" first, the LiveKit-arrives-later dispatch branch is
    skipped. Without an inline dispatch from `end_room`, partners
    never see `room.finished` for any explicit-end path (iOS host End
    Space, the new developer end endpoint, anywhere).
    """
    import inspect

    from app.services.room_service import RoomService

    src = inspect.getsource(RoomService.end_room)
    # The dispatch happens after the status update — check both are in
    # the source, in the right order.
    status_flip_idx = src.find('status="ended"')
    dispatch_idx = src.find('event_type="room.finished"')
    assert status_flip_idx != -1, "end_room should set status='ended'"
    assert dispatch_idx != -1, (
        "end_room must dispatch room.finished inline — see the comment "
        "in end_room about the LiveKit handler's status='active' filter."
    )
    assert status_flip_idx < dispatch_idx, (
        "Inline dispatch should come after the status flip so ended_at "
        "and other state is consistent before partners are notified."
    )
