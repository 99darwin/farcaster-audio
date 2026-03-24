import pytest
from unittest.mock import patch, AsyncMock, MagicMock

import httpx


@pytest.mark.asyncio
async def test_get_auth_url(client):
    response = await client.get("/v1/auth/neynar-auth-url")
    assert response.status_code == 200
    data = response.json()
    assert "authorization_url" in data
    assert "neynar.com" in data["authorization_url"]


@pytest.mark.asyncio
async def test_login_invalid_signer(client):
    """Login should fail with invalid signer."""
    with patch(
        "app.routers.auth.verify_neynar_signer",
        new_callable=AsyncMock,
        side_effect=httpx.HTTPStatusError("Invalid", request=None, response=MagicMock(status_code=401)),
    ):
        response = await client.post(
            "/v1/auth/login",
            json={
                "signer_uuid": "invalid-signer",
                "fid": 12345,
            },
        )
        assert response.status_code in (401, 500)


@pytest.mark.asyncio
async def test_login_missing_fields(client):
    """Login should fail with missing required fields."""
    response = await client.post("/v1/auth/login", json={})
    assert response.status_code == 422  # Validation error


@pytest.mark.asyncio
async def test_protected_endpoint_no_token(client):
    """Protected endpoints should return 401 without token."""
    response = await client.post("/v1/rooms", json={"title": "test"})
    assert response.status_code in (401, 403)


@pytest.mark.asyncio
async def test_protected_endpoint_invalid_token(client):
    """Protected endpoints should return 401 with invalid token."""
    response = await client.post(
        "/v1/rooms",
        json={"title": "test"},
        headers={"Authorization": "Bearer invalid-token"},
    )
    assert response.status_code in (401, 403)
