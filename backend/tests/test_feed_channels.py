from unittest.mock import AsyncMock, MagicMock

import pytest
from jose import jwt

from app.config import settings
from app.dependencies import get_db, get_spam_service
from app.main import app
from tests.hypersnap_fake import V2, fake_hypersnap  # noqa: F401
from tests.hypersnap_write_fakes import CHANNEL_PARENT_URLS, install_write_fakes


def make_auth_header(fid: int = 12345) -> dict:
    token = jwt.encode(
        {"fid": fid, "exp": 4_102_444_800},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


def _mock_db_returning_signer(
    signer_uuid: str = "12345678-1234-4234-9234-123456789abc",
):
    scalar_result = MagicMock()
    scalar_result.scalar_one_or_none = MagicMock(return_value=signer_uuid)
    scalar_result.scalars.return_value.all.return_value = []
    db = MagicMock()
    db.execute = AsyncMock(return_value=scalar_result)
    db.commit = AsyncMock()
    return db


async def _override_db():
    yield _mock_db_returning_signer()


class _SpamService:
    def __init__(self):
        self.annotated = []

    async def annotate_casts(self, casts):
        self.annotated.append(casts)


@pytest.fixture
def feed_overrides():
    spam = _SpamService()
    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_spam_service] = lambda: spam
    try:
        yield spam
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_spam_service, None)


@pytest.mark.asyncio
async def test_channel_feed_reads_hypersnap_channel_ids(
    client, feed_overrides, fake_hypersnap
):
    fake_hypersnap.route(
        f"{V2}/feed/channels",
        {"casts": [{"hash": "0xabc"}], "next": {"cursor": "next"}},
    )
    response = await client.get(
        "/v1/feed/channel/neynar?limit=10&cursor=abc",
        headers=make_auth_header(),
    )

    assert response.status_code == 200
    feed_calls = fake_hypersnap.calls_to(f"{V2}/feed/channels")
    # No viewer_fid upstream: Hypersnap has none, flags are hydrated locally.
    assert feed_calls[0].params == {
        "channel_ids": "neynar",
        "limit": "10",
        "cursor": "abc",
    }
    assert feed_overrides.annotated == [[{"hash": "0xabc"}]]
    assert response.json()["next"] == {"cursor": "next"}


@pytest.mark.asyncio
async def test_channel_search_reads_hypersnap_channel_search(
    client, feed_overrides, fake_hypersnap
):
    fake_hypersnap.route(
        f"{V2}/channel/search",
        {
            "channels": [
                {
                    "id": "base",
                    "name": "Base",
                    "description": "Base builders",
                    "image_url": "https://example.com/base.png",
                    "follower_count": 12345,
                }
            ]
        },
    )
    response = await client.get(
        "/v1/feed/channels/search?q=ba&limit=8",
        headers=make_auth_header(),
    )

    assert response.status_code == 200
    assert fake_hypersnap.calls[0].path == f"{V2}/channel/search"
    assert fake_hypersnap.calls[0].params == {"q": "ba", "limit": "8"}
    assert response.json() == {
        "channels": [
            {
                "id": "base",
                "name": "Base",
                "description": "Base builders",
                "image_url": "https://example.com/base.png",
                "follower_count": 12345,
            }
        ]
    }


@pytest.mark.asyncio
async def test_channel_search_maps_hypersnap_member_count(
    client, feed_overrides, fake_hypersnap
):
    """Hypersnap reports member_count and no image_url/follower_count."""
    fake_hypersnap.route(
        f"{V2}/channel/search",
        {
            "channels": [
                {"object": "channel", "id": "base", "name": "Base", "member_count": 7}
            ],
            "next": {},
        },
    )
    response = await client.get(
        "/v1/feed/channels/search?q=ba", headers=make_auth_header()
    )

    assert response.status_code == 200
    channel = response.json()["channels"][0]
    assert channel["follower_count"] == 7
    assert channel["image_url"] is None


@pytest.mark.asyncio
async def test_channel_feed_upstream_5xx_maps_to_502(
    client, feed_overrides, fake_hypersnap
):
    fake_hypersnap.route(f"{V2}/feed/channels", (500, {"message": "boom"}))
    response = await client.get("/v1/feed/channel/neynar", headers=make_auth_header())

    assert response.status_code == 502
    assert response.json() == {"detail": "Upstream service error"}


@pytest.mark.asyncio
async def test_create_cast_sends_channel_parent_url_for_top_level_cast(
    client, feed_overrides, monkeypatch
):
    fakes = install_write_fakes(monkeypatch)
    response = await client.post(
        "/v1/feed/cast",
        json={"text": "gm", "channel_id": "neynar"},
        headers=make_auth_header(),
    )

    assert response.status_code == 200
    body = fakes.node.bodies[0].cast_add_body
    assert body.parent_url == CHANNEL_PARENT_URLS["neynar"]
    assert not body.HasField("parent_cast_id")
    assert response.json()["cast"]["hash"] == fakes.node.hashes[0]


@pytest.mark.asyncio
async def test_channel_lookup_is_cached(client, feed_overrides, monkeypatch):
    fakes = install_write_fakes(monkeypatch)
    for _ in range(2):
        response = await client.post(
            "/v1/feed/cast",
            json={"text": "gm", "channel_id": "neynar"},
            headers=make_auth_header(),
        )
        assert response.status_code == 200

    channel_calls = [call for call in fakes.reads.calls if call[0] == "/channel"]
    assert channel_calls == [("/channel", {"id": "neynar"})]


@pytest.mark.asyncio
async def test_create_cast_rejects_reply_with_channel_id(
    client, feed_overrides, monkeypatch
):
    fakes = install_write_fakes(monkeypatch)
    response = await client.post(
        "/v1/feed/cast",
        json={
            "text": "reply",
            "parent": "0x" + "a" * 40,
            "channel_id": "neynar",
        },
        headers=make_auth_header(),
    )

    assert response.status_code == 400
    assert fakes.node.attempts == 0


@pytest.mark.asyncio
async def test_create_quote_cast_can_target_channel(
    client, feed_overrides, monkeypatch
):
    fakes = install_write_fakes(monkeypatch)
    response = await client.post(
        "/v1/feed/cast",
        json={
            "text": "quoted",
            "channel_id": "neynar",
            "quote": {"fid": 3, "hash": "0x" + "b" * 40},
        },
        headers=make_auth_header(),
    )

    assert response.status_code == 200
    body = fakes.node.bodies[0].cast_add_body
    assert body.parent_url == CHANNEL_PARENT_URLS["neynar"]
    assert body.embeds[0].cast_id.fid == 3
    assert body.embeds[0].cast_id.hash == bytes.fromhex("b" * 40)
