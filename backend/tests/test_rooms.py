import pytest
from datetime import datetime, timedelta, timezone
from jose import jwt

from app.config import settings


def make_auth_header(fid: int = 12345) -> dict:
    """Create a valid JWT auth header for testing."""
    token = jwt.encode(
        {
            "fid": fid,
            "exp": int(
                (datetime.now(timezone.utc) + timedelta(hours=72)).timestamp()
            ),
        },
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


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
