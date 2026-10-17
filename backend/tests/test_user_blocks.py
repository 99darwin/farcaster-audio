from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from jose import jwt

from app.config import settings
from app.dependencies import get_db, get_spam_service
from app.main import app
from app.services.room_service import RoomService
from tests.hypersnap_fake import V2, fake_hypersnap  # noqa: F401


def make_auth_header(fid: int = 12345) -> dict:
    token = jwt.encode(
        {"fid": fid, "exp": 4_102_444_800},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


class _SpamService:
    async def annotate_casts(self, _casts):
        return None


def _result(*, scalars=None, scalar_one_or_none=None):
    result = MagicMock()
    result.scalars.return_value.all.return_value = scalars or []
    result.scalar_one_or_none.return_value = scalar_one_or_none
    return result


@pytest.fixture
def db_override():
    db = MagicMock()
    db.execute = AsyncMock(return_value=_result())
    db.commit = AsyncMock()

    async def _override_db():
        yield db

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_spam_service] = lambda: _SpamService()
    try:
        yield db
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_spam_service, None)


@pytest.mark.asyncio
async def test_block_and_unblock_are_idempotent(client, db_override):
    first_block = await client.post("/v1/users/2/block", headers=make_auth_header())
    second_block = await client.post("/v1/users/2/block", headers=make_auth_header())
    first_unblock = await client.delete("/v1/users/2/block", headers=make_auth_header())
    second_unblock = await client.delete(
        "/v1/users/2/block", headers=make_auth_header()
    )

    assert first_block.status_code == 201
    assert second_block.status_code == 201
    assert first_unblock.status_code == 200
    assert second_unblock.status_code == 200
    assert db_override.commit.await_count == 4


@pytest.mark.asyncio
async def test_self_block_returns_400(client, db_override):
    response = await client.post("/v1/users/12345/block", headers=make_auth_header())

    assert response.status_code == 400
    assert db_override.commit.await_count == 0


@pytest.mark.asyncio
async def test_get_user_includes_blocked_viewer_context(
    client, db_override, fake_hypersnap
):
    db_override.execute = AsyncMock(return_value=_result(scalar_one_or_none=99))
    fake_hypersnap.route(
        f"{V2}/user/bulk",
        {"users": [{"fid": 2, "username": "blocked", "display_name": "Blocked"}]},
    )

    def link_by_id(params):
        # The viewer (12345) follows fid 2; fid 2 does not follow back, which
        # Hypersnap reports as HTTP 400 rather than 404.
        if params["fid"] == "12345" and params["target_fid"] == "2":
            return {"data": {"linkBody": {"type": "follow", "targetFid": 2}}}
        return 400, {"errCode": "not_found"}

    fake_hypersnap.route("/v1/linkById", link_by_id)

    response = await client.get("/v1/users/2", headers=make_auth_header())

    assert response.status_code == 200
    assert fake_hypersnap.calls_to(f"{V2}/user/bulk")[0].params == {"fids": "2"}
    assert response.json()["user"]["viewer_context"] == {
        "following": True,
        "followed_by": False,
        "blocked": True,
    }


@pytest.mark.asyncio
async def test_following_feed_filters_blocked_authors(
    client, db_override, fake_hypersnap
):
    db_override.execute = AsyncMock(return_value=_result(scalars=[2]))
    fake_hypersnap.route(
        f"{V2}/feed/following",
        {
            "casts": [
                {"hash": "0x1", "author": {"fid": 1}, "text": "visible"},
                {"hash": "0x2", "author": {"fid": 2}, "text": "blocked"},
            ],
            "next": {"cursor": None},
        },
    )

    response = await client.get("/v1/feed/following", headers=make_auth_header())

    assert response.status_code == 200
    casts = response.json()["casts"]
    assert [cast["author"]["fid"] for cast in casts] == [1]


async def test_following_feed_attaches_parent_cast_to_replies(
    client, db_override, fake_hypersnap
):
    parent_hash = "a" * 40
    fake_hypersnap.route(
        f"{V2}/feed/following",
        {
            "casts": [
                {
                    "hash": "b" * 40,
                    "author": {"fid": 1},
                    "text": "well hello there old friend",
                    "parent_hash": parent_hash,
                    "parent_author": {"fid": 3},
                },
            ],
            "next": {"cursor": None},
        },
    )
    fake_hypersnap.route(
        f"{V2}/cast",
        {
            "cast": {
                "hash": parent_hash,
                "author": {"fid": 3, "username": "op"},
                "text": "the original",
                "timestamp": "2026-10-16T12:00:00Z",
            }
        },
    )

    response = await client.get("/v1/feed/following", headers=make_auth_header())

    assert response.status_code == 200
    parent = response.json()["casts"][0]["parent_cast"]
    assert parent["hash"] == "0x" + parent_hash
    assert parent["author"]["username"] == "op"
    assert parent["text"] == "the original"


@pytest.mark.asyncio
async def test_blocked_user_cannot_join_blocker_hosted_room():
    db = MagicMock()
    db.execute = AsyncMock(return_value=_result(scalar_one_or_none=1))
    service = RoomService(db=db, redis=MagicMock(), livekit=MagicMock())
    service._get_room_or_404 = AsyncMock(
        return_value=SimpleNamespace(
            status="active",
            host_fid=12345,
            is_farcaster_native=False,
        )
    )

    with pytest.raises(Exception) as exc:
        await service.join_room(room_id="00000000-0000-0000-0000-000000000001", fid=2)

    assert getattr(exc.value, "status_code", None) == 403


@pytest.mark.asyncio
async def test_blocked_user_cannot_rsvp_to_blocker_hosted_room():
    db = MagicMock()
    db.execute = AsyncMock(return_value=_result(scalar_one_or_none=1))
    db.commit = AsyncMock()
    service = RoomService(db=db, redis=MagicMock(), livekit=MagicMock())
    service._get_room_or_404 = AsyncMock(
        return_value=SimpleNamespace(status="scheduled", host_fid=12345)
    )

    with pytest.raises(Exception) as exc:
        await service.register_rsvp(
            room_id="00000000-0000-0000-0000-000000000001",
            fid=2,
        )

    assert getattr(exc.value, "status_code", None) == 403
    assert db.commit.await_count == 0
