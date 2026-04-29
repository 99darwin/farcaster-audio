"""Tests for PushService — focused on rich-content (PFP image) plumbing
through Expo push payloads.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.push_service import PushService

PFP_URL = "https://example.com/pfp.png"
TOKEN = "ExponentPushToken[abc123]"
TARGET_FID = 4242


def _make_db_with_tokens(tokens: list[str]) -> AsyncMock:
    """Build a mock AsyncSession that returns the given tokens from execute()."""
    db = AsyncMock()
    rows = [(t,) for t in tokens]

    select_result = MagicMock()
    select_result.all = MagicMock(return_value=rows)

    update_result = MagicMock()
    update_result.all = MagicMock(return_value=[])

    db.execute = AsyncMock(side_effect=[select_result, update_result])
    db.commit = AsyncMock()
    return db


def _make_mock_httpx_post(status: str = "ok") -> tuple[MagicMock, AsyncMock]:
    """Return (patch_target_class, captured_post_mock).

    The caller wires this in via `patch("app.services.push_service.httpx.AsyncClient", ...)`.
    """
    response = MagicMock()
    response.raise_for_status = MagicMock()
    response.json = MagicMock(return_value={"data": [{"status": status}]})

    post_mock = AsyncMock(return_value=response)

    client = AsyncMock()
    client.post = post_mock
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)

    client_cls = MagicMock(return_value=client)
    return client_cls, post_mock


@pytest.mark.asyncio
async def test_send_push_with_image_url_includes_rich_content():
    """When image_url is provided, payload must include richContent.image
    and mutableContent: True."""
    db = _make_db_with_tokens([TOKEN])
    redis = AsyncMock()
    service = PushService(db=db, redis=redis)

    client_cls, post_mock = _make_mock_httpx_post()

    with patch("app.services.push_service.httpx.AsyncClient", client_cls):
        await service.send_push(
            fid=TARGET_FID,
            title="New Like",
            body="Alice liked your cast",
            data={"type": "like", "url": "/cast/0xabc"},
            image_url=PFP_URL,
        )

    post_mock.assert_awaited_once()
    _, kwargs = post_mock.call_args
    payload = kwargs["json"]
    assert isinstance(payload, list)
    assert len(payload) == 1

    message = payload[0]
    assert message["to"] == TOKEN
    assert message["title"] == "New Like"
    assert message["body"] == "Alice liked your cast"
    assert message["sound"] == "default"
    assert message["richContent"] == {"image": PFP_URL}
    assert message["mutableContent"] is True


@pytest.mark.asyncio
async def test_send_push_without_image_url_omits_rich_content():
    """When image_url is None/missing, payload must NOT include richContent
    or mutableContent."""
    db = _make_db_with_tokens([TOKEN])
    redis = AsyncMock()
    service = PushService(db=db, redis=redis)

    client_cls, post_mock = _make_mock_httpx_post()

    with patch("app.services.push_service.httpx.AsyncClient", client_cls):
        await service.send_push(
            fid=TARGET_FID,
            title="New Like",
            body="Alice liked your cast",
            data={"type": "like", "url": "/cast/0xabc"},
        )

    post_mock.assert_awaited_once()
    _, kwargs = post_mock.call_args
    payload = kwargs["json"]
    message = payload[0]

    assert "richContent" not in message
    assert "mutableContent" not in message


@pytest.mark.asyncio
async def test_send_push_with_explicit_none_image_omits_rich_content():
    """Passing image_url=None explicitly should also omit the keys."""
    db = _make_db_with_tokens([TOKEN])
    redis = AsyncMock()
    service = PushService(db=db, redis=redis)

    client_cls, post_mock = _make_mock_httpx_post()

    with patch("app.services.push_service.httpx.AsyncClient", client_cls):
        await service.send_push(
            fid=TARGET_FID,
            title="Hello",
            body="World",
            data=None,
            image_url=None,
        )

    post_mock.assert_awaited_once()
    _, kwargs = post_mock.call_args
    message = kwargs["json"][0]

    assert "richContent" not in message
    assert "mutableContent" not in message


@pytest.mark.asyncio
async def test_send_push_with_image_applies_to_all_tokens():
    """Multi-device users — every message in the batch carries richContent."""
    tokens = ["ExponentPushToken[a]", "ExponentPushToken[b]"]
    db = AsyncMock()
    rows = [(t,) for t in tokens]
    select_result = MagicMock()
    select_result.all = MagicMock(return_value=rows)
    update_result = MagicMock()
    update_result.all = MagicMock(return_value=[])
    db.execute = AsyncMock(side_effect=[select_result, update_result])
    db.commit = AsyncMock()

    redis = AsyncMock()
    service = PushService(db=db, redis=redis)

    response = MagicMock()
    response.raise_for_status = MagicMock()
    response.json = MagicMock(
        return_value={"data": [{"status": "ok"}, {"status": "ok"}]}
    )
    post_mock = AsyncMock(return_value=response)
    client = AsyncMock()
    client.post = post_mock
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)

    with patch(
        "app.services.push_service.httpx.AsyncClient",
        MagicMock(return_value=client),
    ):
        await service.send_push(
            fid=TARGET_FID,
            title="t",
            body="b",
            image_url=PFP_URL,
        )

    _, kwargs = post_mock.call_args
    payload = kwargs["json"]
    assert len(payload) == 2
    for message in payload:
        assert message["richContent"] == {"image": PFP_URL}
        assert message["mutableContent"] is True


@pytest.mark.asyncio
async def test_send_push_with_http_image_url_omits_rich_content():
    """Non-https image URLs (http://) must not be passed to richContent —
    they waste NSE bandwidth and create a tracking-pixel surveillance vector
    via attacker-controlled pfp_urls in Farcaster profiles."""
    db = _make_db_with_tokens([TOKEN])
    redis = AsyncMock()
    service = PushService(db=db, redis=redis)

    client_cls, post_mock = _make_mock_httpx_post()

    with patch("app.services.push_service.httpx.AsyncClient", client_cls):
        await service.send_push(
            fid=TARGET_FID,
            title="t",
            body="b",
            image_url="http://example.com/x.jpg",
        )

    post_mock.assert_awaited_once()
    _, kwargs = post_mock.call_args
    message = kwargs["json"][0]
    assert "richContent" not in message
    assert "mutableContent" not in message


@pytest.mark.asyncio
async def test_send_push_with_localhost_image_url_omits_rich_content():
    """Internal/private hosts (localhost, 10.x, 192.168.x, etc.) must be
    rejected — they're useless for push delivery and could be used as
    SSRF-adjacent probes against Expo's NSE infrastructure."""
    db = _make_db_with_tokens([TOKEN])
    redis = AsyncMock()
    service = PushService(db=db, redis=redis)

    client_cls, post_mock = _make_mock_httpx_post()

    with patch("app.services.push_service.httpx.AsyncClient", client_cls):
        await service.send_push(
            fid=TARGET_FID,
            title="t",
            body="b",
            image_url="https://localhost/x.jpg",
        )

    post_mock.assert_awaited_once()
    _, kwargs = post_mock.call_args
    message = kwargs["json"][0]
    assert "richContent" not in message
    assert "mutableContent" not in message


@pytest.mark.asyncio
async def test_send_push_with_data_uri_image_omits_rich_content():
    """data: URIs aren't fetchable by Expo's NSE and waste payload bytes."""
    db = _make_db_with_tokens([TOKEN])
    redis = AsyncMock()
    service = PushService(db=db, redis=redis)

    client_cls, post_mock = _make_mock_httpx_post()

    with patch("app.services.push_service.httpx.AsyncClient", client_cls):
        await service.send_push(
            fid=TARGET_FID,
            title="t",
            body="b",
            image_url="data:image/png;base64,aGVsbG8=",
        )

    post_mock.assert_awaited_once()
    _, kwargs = post_mock.call_args
    message = kwargs["json"][0]
    assert "richContent" not in message
    assert "mutableContent" not in message


@pytest.mark.asyncio
async def test_send_push_with_normal_https_image_includes_rich_content():
    """Sanity check — a normal HTTPS image URL on a public host preserves
    the existing richContent behavior."""
    db = _make_db_with_tokens([TOKEN])
    redis = AsyncMock()
    service = PushService(db=db, redis=redis)

    client_cls, post_mock = _make_mock_httpx_post()

    with patch("app.services.push_service.httpx.AsyncClient", client_cls):
        await service.send_push(
            fid=TARGET_FID,
            title="t",
            body="b",
            image_url="https://i.imgur.com/x.jpg",
        )

    post_mock.assert_awaited_once()
    _, kwargs = post_mock.call_args
    message = kwargs["json"][0]
    assert message["richContent"] == {"image": "https://i.imgur.com/x.jpg"}
    assert message["mutableContent"] is True


@pytest.mark.asyncio
async def test_send_push_no_tokens_short_circuits():
    """If the user has no active tokens, no HTTP call is made."""
    db = AsyncMock()
    select_result = MagicMock()
    select_result.all = MagicMock(return_value=[])
    db.execute = AsyncMock(return_value=select_result)
    db.commit = AsyncMock()

    redis = AsyncMock()
    service = PushService(db=db, redis=redis)

    client_cls, post_mock = _make_mock_httpx_post()

    with patch("app.services.push_service.httpx.AsyncClient", client_cls):
        await service.send_push(
            fid=TARGET_FID,
            title="t",
            body="b",
            image_url=PFP_URL,
        )

    post_mock.assert_not_awaited()
