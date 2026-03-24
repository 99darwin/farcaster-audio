import pytest


@pytest.mark.asyncio
async def test_webhook_no_auth(client):
    """Webhook without valid signature should fail."""
    response = await client.post(
        "/v1/webhooks/livekit",
        content=b"{}",
        headers={"Content-Type": "application/json"},
    )
    # Should fail signature verification
    assert response.status_code in (400, 401, 500)
