"""Tests for the Hypersnap read adapters (WS1).

Covers hash normalization, viewer-flag hydration for casts and users,
notification aggregation, and the read paths that moved to Hypersnap
(``/notifications``, ``/user/following``, ``/reaction/cast``).
"""

from unittest.mock import AsyncMock, MagicMock

import pytest
from jose import jwt

from app.config import settings
from app.dependencies import get_db, get_spam_service
from app.main import app
from app.services.social_graph import get_following_fids
from app.services import farcaster_hydration
from app.services.farcaster_hydration import (
    VIEWER_REACTION_WINDOW,
    VIEWER_REACTIONS_CACHE_TTL_SECONDS,
    adapt_notifications,
    hydrate_cast_viewer_context,
    hydrate_user_viewer_context,
    invalidate_viewer_reactions,
    normalize_cast_hashes,
    prepare_cast_payload,
)
from app.services.leaderboard_service import HypersnapEngagementFetcher
from tests.hypersnap_fake import V2, fake_hypersnap, reactions_by_fid  # noqa: F401

VIEWER_FID = 12345
HASH_A = "a" * 40
HASH_B = "b" * 40
HASH_C = "c" * 40
REACTIONS_PATH = "/v1/reactionsByFid"
LINK_PATH = "/v1/linkById"
REACTION_BY_ID_PATH = "/v1/reactionById"
# haatz's body for a missing reaction/link (HTTP 400).
NOT_FOUND = 'status: NotFound, message: "cast not found"'


def make_auth_header(fid: int = VIEWER_FID) -> dict:
    token = jwt.encode(
        {"fid": fid, "exp": 4_102_444_800},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# normalize_cast_hashes
# ---------------------------------------------------------------------------


def test_normalize_prefixes_bare_hashes_at_any_depth():
    payload = {
        "casts": [
            {
                "hash": HASH_A,
                "parent_hash": HASH_B,
                "thread_hash": "0x" + HASH_C,
                "embeds": [{"cast": {"hash": HASH_C}}],
                "author": {"custody_address": "d" * 40},
            }
        ]
    }

    normalize_cast_hashes(payload)

    cast = payload["casts"][0]
    assert cast["hash"] == "0x" + HASH_A
    assert cast["parent_hash"] == "0x" + HASH_B
    assert cast["thread_hash"] == "0x" + HASH_C
    assert cast["embeds"][0]["cast"]["hash"] == "0x" + HASH_C
    # Only cast-hash keys are touched, never other 40-hex values.
    assert cast["author"]["custody_address"] == "d" * 40


def test_normalize_leaves_non_hash_values_alone():
    payload = {"hash": "not-a-hash", "parent_hash": None, "thread_hash": "abc"}

    normalize_cast_hashes(payload)

    assert payload == {"hash": "not-a-hash", "parent_hash": None, "thread_hash": "abc"}


# ---------------------------------------------------------------------------
# Cast viewer context
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cast_viewer_context_from_viewer_reactions(fake_hypersnap):
    def reactions(params):
        if params["reaction_type"] == "Like":
            # Hub hashes may come back upper-cased; matching is case-insensitive.
            return reactions_by_fid(["0x" + HASH_A.upper()])
        return reactions_by_fid(["0x" + HASH_B])

    fake_hypersnap.route(REACTIONS_PATH, reactions)
    payload = {
        "casts": [
            {"hash": HASH_A, "author": {}, "viewer_context": {"bookmarked": True}},
            {"hash": HASH_B, "author": {}},
            {"hash": HASH_C, "author": {}},
        ]
    }

    await prepare_cast_payload(payload, VIEWER_FID)

    contexts = [cast["viewer_context"] for cast in payload["casts"]]
    assert contexts == [
        {"bookmarked": True, "liked": True, "recasted": False},
        {"liked": False, "recasted": True},
        {"liked": False, "recasted": False},
    ]
    calls = fake_hypersnap.calls_to(REACTIONS_PATH)
    assert sorted(call.params["reaction_type"] for call in calls) == [
        "Like",
        "Recast",
    ]
    for call in calls:
        assert call.params["fid"] == str(VIEWER_FID)
        assert call.params["pageSize"] == str(VIEWER_REACTION_WINDOW)
        assert call.params["reverse"] == "true"


@pytest.mark.asyncio
async def test_cast_viewer_context_leaves_flag_unset_when_lookup_fails(
    fake_hypersnap,
):
    def reactions(params):
        if params["reaction_type"] == "Like":
            return 503, {"message": "down"}
        return reactions_by_fid(["0x" + HASH_A])

    fake_hypersnap.route(REACTIONS_PATH, reactions)
    payload = {"casts": [{"hash": "0x" + HASH_A, "author": {}}]}

    await hydrate_cast_viewer_context(payload, VIEWER_FID)

    assert payload["casts"][0]["viewer_context"] == {"recasted": True}


@pytest.mark.asyncio
async def test_cast_viewer_context_skips_lookup_without_casts(fake_hypersnap):
    await hydrate_cast_viewer_context({"casts": []}, VIEWER_FID)

    assert fake_hypersnap.calls == []


# A saturated window whose oldest reaction is 2025-10-03T00:00:00Z.
OLDEST_REACTION_FARCASTER_TS = 150_000_000
CAST_BEFORE_WINDOW = "2025-01-01T00:00:00.000Z"
CAST_INSIDE_WINDOW = "2026-01-01T00:00:00.000Z"


def saturated_reactions(target_hashes: list[str]) -> dict:
    """A full ``/v1/reactionsByFid`` page: ``target_hashes`` plus filler."""
    filler = [f"0x{index:040x}" for index in range(VIEWER_REACTION_WINDOW)]
    hashes = (target_hashes + filler)[:VIEWER_REACTION_WINDOW]
    return {
        "messages": [
            {
                "data": {
                    "timestamp": OLDEST_REACTION_FARCASTER_TS
                    + (VIEWER_REACTION_WINDOW - index),
                    "reactionBody": {"targetCastId": {"fid": 1, "hash": h}},
                }
            }
            for index, h in enumerate(hashes)
        ],
        "nextPageToken": "more",
    }


def _cast(hash_hex: str, timestamp: str, author_fid: int = 7) -> dict:
    return {
        "hash": "0x" + hash_hex,
        "timestamp": timestamp,
        "author": {"fid": author_fid},
    }


@pytest.mark.asyncio
async def test_saturated_window_answers_newer_casts_without_lookups(fake_hypersnap):
    fake_hypersnap.route(REACTIONS_PATH, lambda _: saturated_reactions([]))
    payload = {"casts": [_cast(HASH_A, CAST_INSIDE_WINDOW)]}

    await hydrate_cast_viewer_context(payload, VIEWER_FID)

    assert payload["casts"][0]["viewer_context"] == {
        "liked": False,
        "recasted": False,
    }
    assert fake_hypersnap.calls_to(REACTION_BY_ID_PATH) == []


@pytest.mark.asyncio
async def test_saturated_window_resolves_older_casts_exactly(fake_hypersnap):
    """A cast older than the window is not assumed unliked: reactionById
    answers it (400 NotFound -> False, as haatz does)."""
    fake_hypersnap.route(REACTIONS_PATH, lambda _: saturated_reactions([]))

    def reaction_by_id(params):
        if params["reaction_type"] == "Like":
            return {"data": {"type": "MESSAGE_TYPE_REACTION_ADD"}}
        return 400, {"error": "Failed to get reaction", "error_detail": NOT_FOUND}

    fake_hypersnap.route(REACTION_BY_ID_PATH, reaction_by_id)
    payload = {"casts": [_cast(HASH_A, CAST_BEFORE_WINDOW, author_fid=99)]}

    await hydrate_cast_viewer_context(payload, VIEWER_FID)

    assert payload["casts"][0]["viewer_context"] == {
        "liked": True,
        "recasted": False,
    }
    calls = fake_hypersnap.calls_to(REACTION_BY_ID_PATH)
    assert {c.params["reaction_type"] for c in calls} == {"Like", "Recast"}
    for call in calls:
        assert call.params["fid"] == str(VIEWER_FID)
        assert call.params["target_fid"] == "99"
        assert call.params["target_hash"] == "0x" + HASH_A


@pytest.mark.asyncio
async def test_saturated_window_leaves_older_casts_unset_past_lookup_cap(
    fake_hypersnap, monkeypatch
):
    monkeypatch.setattr(farcaster_hydration, "MAX_EXACT_REACTION_LOOKUPS", 1)
    fake_hypersnap.route(REACTIONS_PATH, lambda _: saturated_reactions([]))
    fake_hypersnap.route(REACTION_BY_ID_PATH, (400, {"error_detail": NOT_FOUND}))
    payload = {
        "casts": [
            _cast(HASH_A, CAST_BEFORE_WINDOW),
            _cast(HASH_B, CAST_BEFORE_WINDOW),
            # No timestamp: nothing outside the window can be proven either.
            {"hash": "0x" + HASH_C, "author": {"fid": 7}},
        ]
    }

    await hydrate_cast_viewer_context(payload, VIEWER_FID)

    contexts = [cast["viewer_context"] for cast in payload["casts"]]
    assert contexts == [{"liked": False}, {}, {}]
    assert len(fake_hypersnap.calls_to(REACTION_BY_ID_PATH)) == 1


@pytest.mark.asyncio
async def test_saturated_window_still_reports_in_window_reactions_on_old_casts(
    fake_hypersnap,
):
    fake_hypersnap.route(REACTIONS_PATH, lambda _: saturated_reactions(["0x" + HASH_A]))
    fake_hypersnap.route(REACTION_BY_ID_PATH, (400, {"error_detail": NOT_FOUND}))
    payload = {"casts": [_cast(HASH_A, CAST_BEFORE_WINDOW)]}

    await hydrate_cast_viewer_context(payload, VIEWER_FID)

    assert payload["casts"][0]["viewer_context"] == {
        "liked": True,
        "recasted": True,
    }
    assert fake_hypersnap.calls_to(REACTION_BY_ID_PATH) == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure",
    [
        (503, {"message": "down"}),
        # A validation 400 is not "no such reaction".
        (400, "Invalid query parameters: unknown variant"),
    ],
)
async def test_exact_lookup_failure_leaves_flag_unset(fake_hypersnap, failure):
    fake_hypersnap.route(REACTIONS_PATH, lambda _: saturated_reactions([]))
    fake_hypersnap.route(REACTION_BY_ID_PATH, failure)
    payload = {"casts": [_cast(HASH_A, CAST_BEFORE_WINDOW)]}

    await hydrate_cast_viewer_context(payload, VIEWER_FID)

    assert payload["casts"][0]["viewer_context"] == {}


class _DictRedis:
    """Minimal async Redis stand-in for the reaction-window cache."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.ttls: dict[str, int] = {}

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, ex=None):
        self.store[key] = value
        self.ttls[key] = ex

    async def delete(self, *keys):
        for key in keys:
            self.store.pop(key, None)


@pytest.mark.asyncio
async def test_reaction_windows_are_cached_per_viewer_and_invalidated(
    fake_hypersnap,
):
    fake_hypersnap.route(REACTIONS_PATH, lambda _: reactions_by_fid(["0x" + HASH_A]))
    redis = _DictRedis()

    for _ in range(2):
        payload = {"casts": [{"hash": "0x" + HASH_A, "author": {}}]}
        await hydrate_cast_viewer_context(payload, VIEWER_FID, redis=redis)
        assert payload["casts"][0]["viewer_context"] == {
            "liked": True,
            "recasted": True,
        }

    assert len(fake_hypersnap.calls_to(REACTIONS_PATH)) == 2  # Like + Recast once
    assert set(redis.ttls.values()) == {VIEWER_REACTIONS_CACHE_TTL_SECONDS}
    assert all(str(VIEWER_FID) in key for key in redis.store)

    await invalidate_viewer_reactions(redis, VIEWER_FID)
    assert redis.store == {}
    await hydrate_cast_viewer_context(
        {"casts": [{"hash": "0x" + HASH_A, "author": {}}]}, VIEWER_FID, redis=redis
    )
    assert len(fake_hypersnap.calls_to(REACTIONS_PATH)) == 4


@pytest.mark.asyncio
async def test_failed_reaction_window_is_not_cached(fake_hypersnap):
    fake_hypersnap.route(REACTIONS_PATH, (503, {"message": "down"}))
    redis = _DictRedis()

    await hydrate_cast_viewer_context(
        {"casts": [{"hash": "0x" + HASH_A, "author": {}}]}, VIEWER_FID, redis=redis
    )

    assert redis.store == {}


@pytest.mark.asyncio
async def test_corrupt_cache_entry_falls_back_to_hypersnap(fake_hypersnap):
    fake_hypersnap.route(REACTIONS_PATH, lambda _: reactions_by_fid(["0x" + HASH_A]))
    redis = _DictRedis()
    redis.store = {
        f"viewer_reactions:{VIEWER_FID}:Like": "not json",
        f"viewer_reactions:{VIEWER_FID}:Recast": '{"hashes": []}',
    }
    payload = {"casts": [{"hash": "0x" + HASH_A, "author": {}}]}

    await hydrate_cast_viewer_context(payload, VIEWER_FID, redis=redis)

    assert payload["casts"][0]["viewer_context"] == {"liked": True, "recasted": True}
    assert len(fake_hypersnap.calls_to(REACTIONS_PATH)) == 2


# ---------------------------------------------------------------------------
# User viewer context
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_user_viewer_context_treats_400_and_404_as_not_following(
    fake_hypersnap,
):
    def link_by_id(params):
        if params["fid"] == str(VIEWER_FID):
            return 400, {"errCode": "not_found"}
        return 404, {"message": "not found"}

    fake_hypersnap.route(LINK_PATH, link_by_id)
    user = {"fid": 7}

    await hydrate_user_viewer_context(user, VIEWER_FID)

    assert user["viewer_context"] == {"following": False, "followed_by": False}
    calls = fake_hypersnap.calls_to(LINK_PATH)
    assert {(c.params["fid"], c.params["target_fid"]) for c in calls} == {
        (str(VIEWER_FID), "7"),
        ("7", str(VIEWER_FID)),
    }
    assert all(c.params["link_type"] == "follow" for c in calls)


@pytest.mark.asyncio
async def test_user_viewer_context_unset_on_upstream_error(fake_hypersnap):
    def link_by_id(params):
        if params["fid"] == str(VIEWER_FID):
            return {"data": {"linkBody": {"type": "follow"}}}
        return 503, {"message": "down"}

    fake_hypersnap.route(LINK_PATH, link_by_id)
    user = {"fid": 7, "viewer_context": {"blocked": False}}

    await hydrate_user_viewer_context(user, VIEWER_FID)

    assert user["viewer_context"] == {"blocked": False, "following": True}


@pytest.mark.asyncio
async def test_user_viewer_context_skips_self(fake_hypersnap):
    user = {"fid": VIEWER_FID}

    await hydrate_user_viewer_context(user, VIEWER_FID)

    assert "viewer_context" not in user
    assert fake_hypersnap.calls == []


# ---------------------------------------------------------------------------
# adapt_notifications
# ---------------------------------------------------------------------------


def _row(ntype, fid, timestamp, cast_hash=None):
    row = {"type": ntype, "user": {"fid": fid}, "timestamp": timestamp}
    if cast_hash is not None:
        row["cast"] = {"hash": cast_hash, "author": {"fid": 9}}
    return row


def test_adapt_notifications_groups_reactions_and_follows():
    rows = [
        _row("likes", 1, "t5", HASH_A),
        _row("follows", 2, "t4"),
        _row("likes", 3, "t3", HASH_A),
        _row("likes", 1, "t2", HASH_A),  # duplicate actor is dropped
        _row("recasts", 4, "t2", HASH_A),
        _row("follows", 5, "t1"),
        {"type": "reply", "timestamp": "t0", "cast": {"hash": HASH_B}},
    ]

    adapted = adapt_notifications(rows)

    assert [n["type"] for n in adapted] == ["likes", "follows", "recasts", "reply"]
    likes, follows, recasts, reply = adapted
    assert likes["object"] == "notification"
    assert likes["most_recent_timestamp"] == "t5"
    assert likes["cast"] == {"hash": HASH_A, "author": {"fid": 9}}
    assert [r["user"]["fid"] for r in likes["reactions"]] == [1, 3]
    assert likes["count"] == 2
    assert [f["user"]["fid"] for f in follows["follows"]] == [2, 5]
    assert follows["count"] == 2
    assert recasts["count"] == 1
    assert reply["most_recent_timestamp"] == "t0"


def test_adapt_notifications_passes_through_aggregated_rows():
    row = {
        "type": "likes",
        "reactions": [{"user": {"fid": 1}}],
        "count": 1,
        "most_recent_timestamp": "t1",
    }

    assert adapt_notifications([row, "junk"]) == [row]


# ---------------------------------------------------------------------------
# /v1/notifications router
# ---------------------------------------------------------------------------


class _SpamService:
    async def is_spam(self, _fid, _score=None):
        return False

    async def annotate_casts(self, _casts):
        return None


@pytest.fixture
def notification_overrides():
    scalar_result = MagicMock()
    scalar_result.scalars.return_value.all.return_value = []
    db = MagicMock()
    db.execute = AsyncMock(return_value=scalar_result)

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
async def test_notifications_router_reads_hypersnap_and_aggregates(
    client, notification_overrides, fake_hypersnap
):
    fake_hypersnap.route(
        f"{V2}/notifications",
        {
            "notifications": [
                _row("likes", 1, "t2", HASH_A),
                _row("likes", 2, "t1", HASH_A),
            ],
            "next": {"cursor": "n2"},
        },
    )
    fake_hypersnap.route(
        REACTIONS_PATH,
        lambda params: reactions_by_fid(
            ["0x" + HASH_A] if params["reaction_type"] == "Like" else []
        ),
    )

    response = await client.get(
        "/v1/notifications?limit=10", headers=make_auth_header()
    )

    assert response.status_code == 200
    body = response.json()
    assert body["next"] == {"cursor": "n2"}
    (likes,) = body["notifications"]
    assert likes["count"] == 2
    assert likes["cast"]["hash"] == "0x" + HASH_A
    assert likes["cast"]["viewer_context"] == {
        "liked": True,
        "recasted": False,
        "bookmarked": False,
    }
    call = fake_hypersnap.calls_to(f"{V2}/notifications")[0]
    assert call.params == {"fid": str(VIEWER_FID), "limit": "10"}


@pytest.mark.asyncio
async def test_notifications_router_maps_upstream_5xx_to_502(
    client, notification_overrides, fake_hypersnap
):
    fake_hypersnap.route(f"{V2}/notifications", (500, {"message": "boom"}))

    response = await client.get("/v1/notifications", headers=make_auth_header())

    assert response.status_code == 502


# ---------------------------------------------------------------------------
# following lookup (/user/following)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_following_fids_paginate_hypersnap_user_following(fake_hypersnap):
    def following(params):
        if params.get("cursor") == "page-2":
            return {"users": [{"user": {"fid": 3}}], "next": {"cursor": None}}
        return {"users": [{"fid": 1}, {"fid": 2}], "next": {"cursor": "page-2"}}

    fake_hypersnap.route(f"{V2}/user/following", following)
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=None)

    fids = await get_following_fids(redis, VIEWER_FID)

    assert fids == [1, 2, 3]
    calls = fake_hypersnap.calls_to(f"{V2}/user/following")
    assert calls[0].params == {"fid": str(VIEWER_FID), "limit": "100"}
    assert calls[1].params["cursor"] == "page-2"
    redis.set.assert_awaited_once()


@pytest.mark.asyncio
async def test_following_fids_keep_partial_result_on_failure(fake_hypersnap):
    def following(params):
        if params.get("cursor") == "page-2":
            return 503, {"message": "down"}
        return {"users": [{"fid": 1}], "next": {"cursor": "page-2"}}

    fake_hypersnap.route(f"{V2}/user/following", following)
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=None)

    assert await get_following_fids(redis, VIEWER_FID) == [1]


# ---------------------------------------------------------------------------
# Leaderboard engagement fetcher (/reaction/cast + /cast/conversation)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_engagement_fetcher_queries_likes_and_recasts_separately(
    fake_hypersnap,
):
    def reactions(params):
        fids = {"likes": [1, 2], "recasts": [2, 3]}[params["types"]]
        return {
            "reactions": [{"user": {"fid": fid}} for fid in fids],
            "next": {"cursor": None},
        }

    fake_hypersnap.route(f"{V2}/reaction/cast", reactions)
    fake_hypersnap.route(
        f"{V2}/cast/conversation",
        {
            "conversation": {
                "cast": {
                    "hash": HASH_A,
                    "author": {"fid": 9},
                    "direct_replies": [{"author": {"fid": 4}}],
                }
            }
        },
    )
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=None)

    engagers = await HypersnapEngagementFetcher(redis).distinct_engagers("0x" + HASH_A)

    assert {1, 2, 3, 4} <= engagers
    types = [c.params["types"] for c in fake_hypersnap.calls_to(f"{V2}/reaction/cast")]
    assert types == ["likes", "recasts"]
    redis.set.assert_awaited_once()


@pytest.mark.asyncio
async def test_engagement_fetcher_does_not_cache_failures(fake_hypersnap):
    fake_hypersnap.route(f"{V2}/reaction/cast", (503, {"message": "down"}))
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=None)

    engagers = await HypersnapEngagementFetcher(redis).distinct_engagers("0x" + HASH_A)

    assert engagers == set()
    redis.set.assert_not_awaited()
