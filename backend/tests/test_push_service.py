"""Tests for PushService — focused on rich-content (PFP image) plumbing
through Expo push payloads.
"""

from unittest.mock import AsyncMock, MagicMock, call, patch
from uuid import uuid4

from fastapi import HTTPException
import pytest

from app.models.room import Room
from app.services.push_service import PushService
from tests.hypersnap_fake import V2, fake_hypersnap  # noqa: F401

PFP_URL = "https://imagedelivery.net/abc/pfp/rectcrop3"
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
    assert message["data"] == {
        "type": "like",
        "url": "/cast/0xabc",
        "pfp_url": PFP_URL,
    }
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
    assert "pfp_url" not in message["data"]


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
    assert "pfp_url" not in message["data"]


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
        assert message["data"]["pfp_url"] == PFP_URL
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


@pytest.mark.parametrize(
    "url",
    [
        "https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/abc/original",
        "https://wrpcd.net/cdn-cgi/imagedelivery/x/y/rectcrop3",
        "https://i.imgur.com/x.jpg",
        "https://res.cloudinary.com/merkle-manufactory/image/upload/v1/x.png",
        "https://i.seadn.io/gae/abc",
        "https://IMAGEDELIVERY.NET/x",
    ],
)
def test_is_safe_image_url_allows_known_cdns(url):
    from app.services.push_service import _is_safe_image_url

    assert _is_safe_image_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/pfp.png",  # arbitrary host = tracking pixel
        "https://attacker.example/i.imgur.com/x.jpg",
        "https://i.imgur.com.attacker.example/x.jpg",
        "https://evilimagedelivery.net/x",
        "https://i.imgur.com:8443/x.jpg",
        "https://user@i.imgur.com/x.jpg",
        "http://i.imgur.com/x.jpg",
        "https://[::1]/x",
        # Allowlisted image proxies fetching an attacker origin.
        "https://wrpcd.net/cdn-cgi/image/fit=contain/"
        "https%3A%2F%2Fattacker.example%2Fpixel.png",
        "https://wrpcd.net/cdn-cgi/image/w=1/https%253A%252F%252Fattacker.example",
        "https://res.cloudinary.com/evil/image/fetch/attacker.example/pixel.png",
        "https://res.cloudinary.com/evil/image/upload/x.png?u=https://attacker.example",
        "https://i.imgur.com//attacker.example/x.png",
        "",
        None,
    ],
)
def test_is_safe_image_url_rejects_unlisted_hosts(url):
    """L5: an attacker-chosen pfp host would learn which fids got pushes."""
    from app.services.push_service import _is_safe_image_url

    assert not _is_safe_image_url(url)


@pytest.mark.asyncio
async def test_send_push_with_unlisted_image_host_omits_rich_content(caplog):
    db = _make_db_with_tokens([TOKEN])
    service = PushService(db=db, redis=AsyncMock())
    client_cls, post_mock = _make_mock_httpx_post()
    tracker = "https://tracker.example/pixel.png?u=victim"
    with (
        caplog.at_level("INFO"),
        patch("app.services.push_service.httpx.AsyncClient", client_cls),
    ):
        await service.send_push(fid=TARGET_FID, title="t", body="b", image_url=tracker)
    message = post_mock.call_args.kwargs["json"][0]
    assert "richContent" not in message
    assert "pfp_url" not in message["data"]
    assert "tracker.example" not in caplog.text


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


def _make_space_service() -> PushService:
    service = PushService(db=AsyncMock(), redis=AsyncMock())
    service.is_enabled = AsyncMock(return_value=True)
    service.send_push = AsyncMock()
    service._send_miniapp_notification = AsyncMock(return_value=True)
    service._mark_delivery_once = AsyncMock(return_value=True)
    service._has_native_target = AsyncMock(return_value=True)
    service._has_miniapp_target = AsyncMock(return_value=False)
    return service


@pytest.mark.asyncio
async def test_notify_space_started_rsvps_delivers_native_and_miniapp_and_skips_host():
    service = _make_space_service()
    service._rsvp_fids = AsyncMock(return_value=[111, 222, 333])
    service._has_miniapp_target = AsyncMock(side_effect=lambda fid: fid == 222)

    result = await service.notify_space_started_rsvps(
        room_id="room-1",
        room_uuid=uuid4(),
        title="Morning Juke",
        host_fid=111,
    )

    assert result.users_considered == 3
    assert result.users_skipped_self == 1
    assert result.users_sent == 2
    assert result.native_targets == 2
    assert result.miniapp_targets == 1
    service.send_push.assert_any_await(
        fid=222,
        title="Space is Live",
        body='"Morning Juke" is now live — join now!',
        data={"type": "space_live", "url": "/space/room-1"},
    )
    service._send_miniapp_notification.assert_awaited_once_with(
        fid=222,
        title="Space is Live",
        body='"Morning Juke" is now live — join now!',
        target_url="https://juke.audio/space/room-1",
        notification_id="space_started_rsvp:room-1:222",
    )


@pytest.mark.asyncio
async def test_notify_space_started_rsvps_respects_space_started_preference():
    service = _make_space_service()
    service._rsvp_fids = AsyncMock(return_value=[222])
    service.is_enabled = AsyncMock(return_value=False)

    result = await service.notify_space_started_rsvps(
        room_id="room-1",
        room_uuid=uuid4(),
        title="Morning Juke",
        host_fid=111,
    )

    assert result.users_skipped_preferences == 1
    assert result.users_sent == 0
    service.send_push.assert_not_awaited()
    service._send_miniapp_notification.assert_not_awaited()


@pytest.mark.asyncio
async def test_notify_space_started_rsvps_respects_miniapp_preference():
    service = _make_space_service()
    service._rsvp_fids = AsyncMock(return_value=[222])
    service._has_native_target = AsyncMock(return_value=False)
    service._has_miniapp_target = AsyncMock(return_value=True)
    service.is_enabled = AsyncMock(
        side_effect=lambda _fid, notification_type: notification_type == "space_started"
    )

    result = await service.notify_space_started_rsvps(
        room_id="room-1",
        room_uuid=uuid4(),
        title="Morning Juke",
        host_fid=111,
    )

    assert result.users_eligible == 0
    assert result.users_sent == 0
    assert result.miniapp_targets == 0
    service._send_miniapp_notification.assert_not_awaited()


@pytest.mark.asyncio
async def test_notify_space_started_rsvps_is_idempotent_per_room_campaign_user():
    service = _make_space_service()
    service._rsvp_fids = AsyncMock(return_value=[222])
    service._mark_delivery_once = AsyncMock(return_value=False)

    result = await service.notify_space_started_rsvps(
        room_id="room-1",
        room_uuid=uuid4(),
        title="Morning Juke",
        host_fid=111,
    )

    assert result.users_skipped_idempotent == 1
    assert result.users_sent == 0
    service.send_push.assert_not_awaited()


@pytest.mark.asyncio
async def test_admin_notify_all_active_bypasses_space_started_preference():
    room_uuid = uuid4()
    room = Room(id=room_uuid, title="Live Now", host_fid=111, status="active")
    db = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = room
    db.execute = AsyncMock(return_value=result)
    service = PushService(db=db, redis=AsyncMock())
    service._active_reachable_fids = AsyncMock(return_value=[222])
    service.is_enabled = AsyncMock(return_value=False)
    service._has_native_target = AsyncMock(return_value=True)
    service._has_miniapp_target = AsyncMock(return_value=True)
    service._mark_delivery_once = AsyncMock(return_value=True)
    service.send_push = AsyncMock()
    service._send_miniapp_notification = AsyncMock(return_value=True)

    response = await service.admin_notify_room_live(
        room_id=str(room_uuid),
        target="all_active",
        dry_run=False,
    )

    assert response.preference_bypass is True
    assert response.users_sent == 1
    service.is_enabled.assert_not_awaited()
    service.send_push.assert_awaited_once()
    service._send_miniapp_notification.assert_awaited_once()


@pytest.mark.asyncio
async def test_admin_notify_all_active_dry_run_does_not_mark_or_send():
    room_uuid = uuid4()
    room = Room(id=room_uuid, title="Live Now", host_fid=111, status="active")
    db = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = room
    db.execute = AsyncMock(return_value=result)
    service = PushService(db=db, redis=AsyncMock())
    service._active_reachable_fids = AsyncMock(return_value=[222, 333])
    service._has_native_target = AsyncMock(side_effect=lambda fid: fid == 222)
    service._has_miniapp_target = AsyncMock(return_value=True)
    service._mark_delivery_once = AsyncMock(return_value=True)
    service.send_push = AsyncMock()
    service._send_miniapp_notification = AsyncMock(return_value=True)

    response = await service.admin_notify_room_live(
        room_id=str(room_uuid),
        target="all_active",
        dry_run=True,
    )

    assert response.users_eligible == 2
    assert response.users_sent == 0
    assert response.native_targets == 1
    assert response.miniapp_targets == 2
    service._mark_delivery_once.assert_not_awaited()
    service.send_push.assert_not_awaited()
    service._send_miniapp_notification.assert_not_awaited()


@pytest.mark.asyncio
async def test_admin_notify_rejects_invalid_room_state():
    room_uuid = uuid4()
    room = Room(id=room_uuid, title="Not Live", host_fid=111, status="scheduled")
    db = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = room
    db.execute = AsyncMock(return_value=result)
    service = PushService(db=db, redis=AsyncMock())

    with pytest.raises(HTTPException) as exc:
        await service.admin_notify_room_live(
            room_id=str(room_uuid),
            target="all_active",
            dry_run=False,
        )

    assert exc.value.status_code == 400


# ---------------------------------------------------------------------------
# handle_notification_event — probable-spam gate
# ---------------------------------------------------------------------------


def _patch_spam(is_spam_value: bool):
    """Patch SpamService inside push_service so is_spam returns the given value."""
    spam_mock = MagicMock()
    spam_mock.is_spam = AsyncMock(return_value=is_spam_value)
    return patch(
        "app.services.push_service.SpamService",
        MagicMock(return_value=spam_mock),
    )


def _spam_handler_service() -> PushService:
    service = PushService(db=AsyncMock(), redis=AsyncMock())
    service.redis.sismember = AsyncMock(return_value=True)
    service.is_enabled = AsyncMock(return_value=True)
    service.send_push = AsyncMock()
    service._resolve_pfp_url = AsyncMock(return_value=None)
    return service


@pytest.mark.asyncio
async def test_handle_event_skips_reaction_from_spam_reactor():
    service = _spam_handler_service()
    payload = {
        "data": {
            "reaction_type": "like",
            "user": {"fid": 9001, "display_name": "Spammer"},
            "cast": {"hash": "0xabc", "text": "hi", "author": {"fid": TARGET_FID}},
        }
    }

    with _patch_spam(True):
        await service.handle_notification_event("reaction.created", payload)

    service.send_push.assert_not_awaited()


@pytest.mark.asyncio
async def test_handle_event_skips_reply_from_spam_author():
    service = _spam_handler_service()
    payload = {
        "data": {
            "hash": "0xreply",
            "text": "spammy reply",
            "author": {"fid": 9001, "display_name": "Spammer"},
            "parent_author": {"fid": TARGET_FID},
            "parent_hash": "0xparent",
            "thread_hash": "0xparent",
            "mentioned_profiles": [],
        }
    }

    with _patch_spam(True):
        await service.handle_notification_event("cast.created", payload)

    service.send_push.assert_not_awaited()


@pytest.mark.asyncio
async def test_handle_event_skips_mention_from_spam_author():
    service = _spam_handler_service()
    payload = {
        "data": {
            "hash": "0xcast",
            "text": "hey @victim",
            "author": {"fid": 9001, "display_name": "Spammer"},
            "parent_author": {"fid": None},
            "mentioned_profiles": [{"fid": TARGET_FID}],
        }
    }

    with _patch_spam(True):
        await service.handle_notification_event("cast.created", payload)

    service.send_push.assert_not_awaited()


@pytest.mark.asyncio
async def test_handle_event_skips_follow_from_spam_follower():
    service = _spam_handler_service()
    payload = {
        "data": {
            "user": {"fid": TARGET_FID},
            "follower": {"fid": 9001, "display_name": "Spammer"},
        }
    }

    with _patch_spam(True):
        await service.handle_notification_event("follow.created", payload)

    service.send_push.assert_not_awaited()


@pytest.mark.asyncio
async def test_handle_event_delivers_when_actor_not_spam():
    service = _spam_handler_service()
    payload = {
        "data": {
            "reaction_type": "like",
            "user": {"fid": 9001, "display_name": "Real User"},
            "cast": {"hash": "0xabc", "text": "hi", "author": {"fid": TARGET_FID}},
        }
    }

    with _patch_spam(False):
        await service.handle_notification_event("reaction.created", payload)

    service.send_push.assert_awaited_once()


@pytest.mark.asyncio
async def test_nested_reply_notifies_immediate_parent_and_original_poster():
    service = _spam_handler_service()
    service._resolve_thread_root_author_fid = AsyncMock(return_value=111)
    payload = {
        "data": {
            "hash": "0xdeep",
            "text": "following up",
            "author": {"fid": 333, "display_name": "Carol"},
            "parent_author": {"fid": 222},
            "parent_hash": "0xmiddle",
            "thread_hash": "0xroot",
            "mentioned_profiles": [],
        }
    }

    with _patch_spam(False):
        await service.handle_notification_event("cast.created", payload)

    service._resolve_thread_root_author_fid.assert_awaited_once_with("0xroot")
    service.send_push.assert_has_awaits(
        [
            call(
                fid=222,
                title="New Reply",
                body="Carol: following up",
                data={
                    "type": "reply",
                    "url": "/cast/0xdeep?contextHash=0xroot",
                    "cast_hash": "0xdeep",
                    "thread_hash": "0xroot",
                    "focus_hash": "0xdeep",
                },
                image_url=None,
            ),
            call(
                fid=111,
                title="New Reply",
                body="Carol: following up",
                data={
                    "type": "reply",
                    "url": "/cast/0xdeep?contextHash=0xroot",
                    "cast_hash": "0xdeep",
                    "thread_hash": "0xroot",
                    "focus_hash": "0xdeep",
                },
                image_url=None,
            ),
        ]
    )


@pytest.mark.asyncio
async def test_direct_root_reply_does_not_lookup_or_double_notify():
    service = _spam_handler_service()
    service._resolve_thread_root_author_fid = AsyncMock(return_value=111)
    payload = {
        "data": {
            "hash": "0xreply",
            "text": "hello",
            "author": {"fid": 333, "display_name": "Carol"},
            "parent_author": {"fid": 111},
            "parent_hash": "0xroot",
            "thread_hash": "0xroot",
            "mentioned_profiles": [{"fid": 111}],
        }
    }

    with _patch_spam(False):
        await service.handle_notification_event("cast.created", payload)

    service._resolve_thread_root_author_fid.assert_not_awaited()
    service.send_push.assert_awaited_once()
    assert service.send_push.await_args.kwargs["fid"] == 111


@pytest.mark.asyncio
async def test_thread_root_author_cache_avoids_neynar_lookup():
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=b"111")
    service = PushService(db=AsyncMock(), redis=redis)

    assert await service._resolve_thread_root_author_fid("0xroot") == 111
    redis.get.assert_awaited_once()


@pytest.mark.asyncio
async def test_thread_root_author_resolves_from_hypersnap_and_caches(
    fake_hypersnap,
):
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=None)
    service = PushService(db=AsyncMock(), redis=redis)
    fake_hypersnap.route(f"{V2}/cast", {"cast": {"author": {"fid": 111}}})

    assert await service._resolve_thread_root_author_fid("0xroot") == 111

    calls = fake_hypersnap.calls_to(f"{V2}/cast")
    assert [call.params for call in calls] == [{"identifier": "0xroot", "type": "hash"}]
    redis.set.assert_awaited_once_with(
        "push:thread-root-author:0xroot",
        "111",
        ex=60 * 60 * 24 * 7,
    )


@pytest.mark.asyncio
async def test_thread_root_author_upstream_failure_returns_none(fake_hypersnap):
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=None)
    service = PushService(db=AsyncMock(), redis=redis)
    fake_hypersnap.route(f"{V2}/cast", (503, {"message": "down"}))

    assert await service._resolve_thread_root_author_fid("0xroot") is None
    redis.set.assert_not_awaited()


@pytest.mark.asyncio
async def test_resolve_pfp_url_reads_hypersnap_user_bulk(fake_hypersnap):
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=None)
    service = PushService(db=AsyncMock(), redis=redis)
    fake_hypersnap.route(f"{V2}/user/bulk", {"users": [{"fid": 7, "pfp_url": PFP_URL}]})

    assert await service._resolve_pfp_url(7) == PFP_URL
    assert fake_hypersnap.calls_to(f"{V2}/user/bulk")[0].params == {"fids": "7"}
