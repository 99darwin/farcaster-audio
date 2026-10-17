"""Tests for GET /v1/users/{fid}/casts — param forwarding to Hypersnap."""

from unittest.mock import AsyncMock, MagicMock

import pytest
from jose import jwt

from app.config import settings
from app.dependencies import get_db, get_spam_service
from app.main import app
from app.routers.users import USER_CASTS_MAX_PAGES
from tests.hypersnap_fake import V2, fake_hypersnap  # noqa: F401

USER_CASTS_PATH = f"{V2}/feed/user/casts"


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


def _mock_db_no_blocks():
    """Return a mock DB that reports no blocked FIDs and no bookmarks."""
    scalar_result = MagicMock()
    scalar_result.scalars.return_value.all.return_value = []
    scalar_result.scalar_one_or_none.return_value = None
    db = MagicMock()
    db.execute = AsyncMock(return_value=scalar_result)
    db.commit = AsyncMock()
    return db


@pytest.fixture
def user_casts_overrides():
    db = _mock_db_no_blocks()

    async def _override_db():
        yield db

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_spam_service] = lambda: _SpamService()
    try:
        yield db
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_spam_service, None)


@pytest.fixture
def user_casts_feed(fake_hypersnap):
    fake_hypersnap.route(
        USER_CASTS_PATH,
        {
            "casts": [
                {"hash": "a" * 40, "author": {"fid": 1}, "parent_hash": None},
                {"hash": "b" * 40, "author": {"fid": 1}, "parent_hash": "c" * 40},
            ],
            "next": {"cursor": None},
        },
    )
    return fake_hypersnap


@pytest.mark.asyncio
async def test_include_replies_false_by_default(
    client, user_casts_overrides, user_casts_feed
):
    """include_replies defaults to False; replies are dropped locally because
    Hypersnap ignores the flag."""
    response = await client.get("/v1/users/1/casts", headers=make_auth_header())

    assert response.status_code == 200
    call = user_casts_feed.calls_to(USER_CASTS_PATH)[0]
    assert call.params["include_replies"] == "false"
    assert [c["hash"] for c in response.json()["casts"]] == ["0x" + "a" * 40]


@pytest.mark.asyncio
async def test_include_replies_true_keeps_replies(
    client, user_casts_overrides, user_casts_feed
):
    response = await client.get(
        "/v1/users/1/casts?include_replies=true",
        headers=make_auth_header(),
    )

    assert response.status_code == 200
    call = user_casts_feed.calls_to(USER_CASTS_PATH)[0]
    assert call.params["include_replies"] == "true"
    hashes = [c["hash"] for c in response.json()["casts"]]
    assert hashes == ["0x" + "a" * 40, "0x" + "b" * 40]


@pytest.mark.asyncio
async def test_user_casts_returns_casts_from_hypersnap(
    client, user_casts_overrides, fake_hypersnap
):
    """Sanity check: the endpoint proxies the casts array from Hypersnap."""
    fake_hypersnap.route(
        USER_CASTS_PATH,
        {"casts": [{"hash": "0xfeed", "author": {"fid": 42}}], "next": {}},
    )
    response = await client.get("/v1/users/42/casts", headers=make_auth_header())

    assert response.status_code == 200
    body = response.json()
    assert body["casts"][0]["hash"] == "0xfeed"
    assert fake_hypersnap.calls_to(USER_CASTS_PATH)[0].params["fid"] == "42"


def _paged_user_casts(pages: dict):
    """Route handler serving ``pages`` keyed by the request's cursor."""

    def handler(params: dict[str, str]):
        return pages[params.get("cursor")]

    return handler


def _reply(hash_char: str) -> dict:
    return {"hash": hash_char * 40, "author": {"fid": 1}, "parent_hash": "f" * 40}


def _top_level(hash_char: str) -> dict:
    return {"hash": hash_char * 40, "author": {"fid": 1}, "parent_hash": None}


@pytest.mark.asyncio
async def test_all_reply_page_is_filled_from_following_pages(
    client, user_casts_overrides, fake_hypersnap
):
    """A first page of only replies must not come back empty with a cursor."""
    fake_hypersnap.route(
        USER_CASTS_PATH,
        _paged_user_casts(
            {
                None: {"casts": [_reply("a"), _reply("b")], "next": {"cursor": "p2"}},
                "p2": {
                    "casts": [_top_level("c"), _reply("d")],
                    "next": {"cursor": "p3"},
                },
                "p3": {"casts": [_top_level("e")], "next": {"cursor": "p4"}},
            }
        ),
    )

    response = await client.get("/v1/users/1/casts?limit=2", headers=make_auth_header())

    assert response.status_code == 200
    body = response.json()
    assert [c["hash"] for c in body["casts"]] == ["0x" + "c" * 40, "0x" + "e" * 40]
    assert body["next"]["cursor"] == "p4"
    calls = fake_hypersnap.calls_to(USER_CASTS_PATH)
    assert [c.params.get("cursor") for c in calls] == [None, "p2", "p3"]


@pytest.mark.asyncio
async def test_page_fill_returns_null_cursor_when_exhausted(
    client, user_casts_overrides, fake_hypersnap
):
    fake_hypersnap.route(
        USER_CASTS_PATH,
        _paged_user_casts(
            {
                None: {"casts": [_reply("a")], "next": {"cursor": "p2"}},
                "p2": {"casts": [_reply("b")], "next": {"cursor": None}},
            }
        ),
    )

    response = await client.get("/v1/users/1/casts", headers=make_auth_header())

    assert response.status_code == 200
    assert response.json() == {"casts": [], "next": {"cursor": None}}
    assert len(fake_hypersnap.calls_to(USER_CASTS_PATH)) == 2


@pytest.mark.asyncio
async def test_page_fill_stops_at_max_pages(
    client, user_casts_overrides, fake_hypersnap
):
    fake_hypersnap.route(
        USER_CASTS_PATH,
        lambda params: {
            "casts": [_reply("a")],
            "next": {"cursor": (params.get("cursor") or "") + "x"},
        },
    )

    response = await client.get("/v1/users/1/casts", headers=make_auth_header())

    assert response.status_code == 200
    assert response.json()["next"]["cursor"] == "x" * USER_CASTS_MAX_PAGES
    assert len(fake_hypersnap.calls_to(USER_CASTS_PATH)) == USER_CASTS_MAX_PAGES


@pytest.mark.asyncio
async def test_page_fill_keeps_earlier_pages_when_a_later_page_fails(
    client, user_casts_overrides, fake_hypersnap
):
    fake_hypersnap.route(
        USER_CASTS_PATH,
        _paged_user_casts(
            {
                None: {"casts": [_top_level("a")], "next": {"cursor": "p2"}},
                "p2": (503, {"message": "down"}),
            }
        ),
    )

    response = await client.get("/v1/users/1/casts", headers=make_auth_header())

    assert response.status_code == 200
    body = response.json()
    assert [c["hash"] for c in body["casts"]] == ["0x" + "a" * 40]
    assert body["next"]["cursor"] == "p2"
