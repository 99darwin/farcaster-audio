import inspect
from datetime import datetime, timedelta, timezone

import pytest
from jose import jwt

from app.config import settings
from app.dependencies import get_db
from app.main import app
from app.services.room_service import RoomService


def make_auth_header(fid: int = 12345) -> dict:
    """Create a valid JWT auth header for testing."""
    token = jwt.encode(
        {
            "fid": fid,
            "exp": int((datetime.now(timezone.utc) + timedelta(hours=72)).timestamp()),
        },
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


class _EmptyResult:
    """Minimal SQLAlchemy `Result`-shaped stub used by recordings tests.

    Public discovery endpoints (`/v1/recordings/recent`, `/v1/recordings/{id}`)
    call `db.execute(query)` then `.all()` / `.scalar_one_or_none()` against
    the rows. Returning an empty result exercises the route plumbing
    (rate-limit, schema construction, pagination envelope) without spinning
    up Postgres — which is what we want for these smoke tests.
    """

    def all(self):
        return []

    def scalar_one_or_none(self):
        return None

    def scalars(self):
        return self

    def first(self):
        return None


class _StubDbSession:
    async def execute(self, *args, **kwargs):
        return _EmptyResult()

    async def commit(self):
        return None

    async def rollback(self):
        return None

    async def close(self):
        return None


@pytest.fixture
def client_with_stub_db(client):
    """Client variant that returns an empty in-memory DB result on `.execute()`.

    Use for public recording feed tests where we only care that the route
    returns 200 + a well-formed envelope. For tests that need real data,
    set up an aiosqlite engine instead (see test_developer_keys.py).
    """

    async def _override_get_db():
        yield _StubDbSession()

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield client
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_list_rooms_unauthenticated(client):
    """GET /v1/rooms should work without auth (public endpoint)."""
    response = await client.get("/v1/rooms")
    # Should either return 200 with empty list or 401
    assert response.status_code in (200, 401)


@pytest.mark.asyncio
async def test_create_room_no_auth(client):
    """POST /v1/rooms should require authentication."""
    response = await client.post("/v1/rooms", json={"title": "Test room"})
    assert response.status_code in (401, 403)


@pytest.mark.asyncio
async def test_create_room_empty_title(client):
    """POST /v1/rooms should reject empty title."""
    headers = make_auth_header()
    response = await client.post("/v1/rooms", json={"title": ""}, headers=headers)
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_start_recording_requires_auth(client):
    """POST /v1/rooms/{id}/recording/start should require auth."""
    response = await client.post(
        "/v1/rooms/00000000-0000-0000-0000-000000000000/recording/start"
    )
    assert response.status_code in (401, 403)


@pytest.mark.asyncio
async def test_stop_recording_requires_auth(client):
    """POST /v1/rooms/{id}/recording/stop should require auth."""
    response = await client.post(
        "/v1/rooms/00000000-0000-0000-0000-000000000000/recording/stop"
    )
    assert response.status_code in (401, 403)


@pytest.mark.asyncio
async def test_user_recordings_requires_auth(client):
    """GET /v1/users/{fid}/recordings should require auth."""
    response = await client.get("/v1/users/1/recordings")
    assert response.status_code in (401, 403)


@pytest.mark.asyncio
async def test_admin_recordings_cleanup_requires_secret(client):
    """POST /v1/admin/recordings/cleanup should reject missing secret."""
    response = await client.post("/v1/admin/recordings/cleanup")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_admin_recordings_cleanup_rejects_bad_secret(client):
    """POST /v1/admin/recordings/cleanup should reject wrong secret."""
    response = await client.post(
        "/v1/admin/recordings/cleanup",
        headers={"X-Admin-Secret": "wrong-secret"},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_recent_recordings_public(client_with_stub_db):
    """GET /v1/recordings/recent should be public and return a feed envelope."""
    response = await client_with_stub_db.get("/v1/recordings/recent")
    assert response.status_code == 200
    data = response.json()
    assert "items" in data
    assert "next_cursor" in data
    assert isinstance(data["items"], list)


@pytest.mark.asyncio
async def test_recent_recordings_invalid_cursor(client):
    """GET /v1/recordings/recent should reject malformed cursor."""
    response = await client.get("/v1/recordings/recent?cursor=not-a-date")
    assert response.status_code == 400


def test_start_scheduled_room_delegates_rsvp_push_delivery_to_push_service():
    source = inspect.getsource(RoomService.start_scheduled_room)
    assert "notify_space_started_rsvps" in source
    assert "send_push(" not in source


@pytest.mark.asyncio
async def test_recording_detail_malformed_id(client):
    """GET /v1/recordings/{id} should 404 (not 500) on malformed UUID."""
    # Malformed UUID short-circuits before any DB call so this stays a
    # pure-smoke test, matching the rest of this file. The retention/404
    # paths against a real DB are exercised by integration tests.
    response = await client.get("/v1/recordings/not-a-uuid")
    assert response.status_code == 404
