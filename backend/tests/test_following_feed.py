"""Tests for shaping the following feed like X's Following timeline."""

import pytest
from fastapi import HTTPException

from app.services.following_feed import (
    MAX_UPSTREAM_PAGES,
    TOP_UP_FACTOR,
    fetch_following_page,
    shape_conversations,
)
from tests.hypersnap_fake import V2, fake_hypersnap  # noqa: F401

VIEWER_FID = 12345
FOLLOWED_FID = 7
STRANGER_FID = 99


def _hash(n: int) -> str:
    return "0x" + f"{n:040x}"


def _root(n: int, *, author_fid: int = FOLLOWED_FID) -> dict:
    return {"hash": _hash(n), "author": {"fid": author_fid}, "text": f"root {n}"}


def _reply(n: int, parent: int, *, parent_fid: int = FOLLOWED_FID) -> dict:
    return {
        "hash": _hash(n),
        "author": {"fid": FOLLOWED_FID},
        "text": f"reply {n}",
        "parent_hash": _hash(parent),
        "parent_author": {"fid": parent_fid},
    }


def _hashes(casts: list[dict]) -> list[str]:
    return [cast["hash"] for cast in casts]


def test_keeps_root_casts_and_replies_to_followed_accounts():
    casts = [_root(1), _reply(2, parent=50), _reply(3, 51, parent_fid=STRANGER_FID)]

    shaped = shape_conversations(casts, visible_parent_fids={FOLLOWED_FID})

    assert _hashes(shaped) == [_hash(1), _hash(2)]


def test_keeps_only_newest_reply_per_conversation():
    casts = [_reply(3, parent=50), _reply(2, parent=50), _root(1)]

    shaped = shape_conversations(casts, visible_parent_fids={FOLLOWED_FID})

    assert _hashes(shaped) == [_hash(3), _hash(1)]


def test_drops_root_cast_shown_above_its_reply():
    casts = [_reply(2, parent=1), _root(1)]

    shaped = shape_conversations(casts, visible_parent_fids={FOLLOWED_FID})

    assert _hashes(shaped) == [_hash(2)]


def test_hidden_reply_does_not_claim_its_conversation():
    casts = [_reply(3, 1, parent_fid=STRANGER_FID), _root(1)]

    shaped = shape_conversations(casts, visible_parent_fids={FOLLOWED_FID})

    assert _hashes(shaped) == [_hash(1)]


def test_unknown_follow_graph_keeps_every_reply():
    casts = [_reply(2, 50, parent_fid=STRANGER_FID)]

    assert shape_conversations(casts, visible_parent_fids=None) == casts


async def test_fetch_tops_up_thinned_page_from_next_upstream_page(fake_hypersnap):
    def following(params):
        if params.get("cursor") == "page-2":
            return {"casts": [_root(3), _root(4)], "next": {"cursor": "page-3"}}
        return {
            "casts": [_root(1), _reply(2, 60, parent_fid=STRANGER_FID)],
            "next": {"cursor": "page-2"},
        }

    fake_hypersnap.route(f"{V2}/feed/following", following)

    page = await fetch_following_page(
        viewer_fid=VIEWER_FID,
        limit=2,
        cursor=None,
        following_fids=[FOLLOWED_FID],
        blocked_fids=set(),
    )

    assert _hashes(page["casts"]) == [_hash(1), _hash(3), _hash(4)]
    assert page["next"]["cursor"] == "page-3"


async def test_fetch_caps_upstream_pages(fake_hypersnap):
    def following(params):
        page = int(params.get("cursor") or 0)
        return {
            "casts": [_reply(100 + page, 60 + page, parent_fid=STRANGER_FID)],
            "next": {"cursor": str(page + 1)},
        }

    fake_hypersnap.route(f"{V2}/feed/following", following)

    page = await fetch_following_page(
        viewer_fid=VIEWER_FID,
        limit=25,
        cursor=None,
        following_fids=[FOLLOWED_FID],
        blocked_fids=set(),
    )

    assert page["casts"] == []
    assert page["next"]["cursor"] == str(MAX_UPSTREAM_PAGES)
    calls = fake_hypersnap.calls_to(f"{V2}/feed/following")
    assert len(calls) == MAX_UPSTREAM_PAGES


async def test_fetch_shows_replies_to_the_viewer(fake_hypersnap):
    fake_hypersnap.route(
        f"{V2}/feed/following",
        {"casts": [_reply(2, 60, parent_fid=VIEWER_FID)], "next": {"cursor": None}},
    )

    page = await fetch_following_page(
        viewer_fid=VIEWER_FID,
        limit=25,
        cursor=None,
        following_fids=[FOLLOWED_FID],
        blocked_fids=set(),
    )

    assert _hashes(page["casts"]) == [_hash(2)]


async def test_fetch_filters_blocked_authors(fake_hypersnap):
    fake_hypersnap.route(
        f"{V2}/feed/following",
        {
            "casts": [_root(1), _root(2, author_fid=STRANGER_FID)],
            "next": {"cursor": None},
        },
    )

    page = await fetch_following_page(
        viewer_fid=VIEWER_FID,
        limit=25,
        cursor=None,
        following_fids=[FOLLOWED_FID],
        blocked_fids={STRANGER_FID},
    )

    assert _hashes(page["casts"]) == [_hash(1)]


async def test_fetch_keeps_gathered_casts_when_a_later_page_fails(fake_hypersnap):
    def following(params):
        if params.get("cursor") == "page-2":
            return 503, {"message": "down"}
        return {"casts": [_root(1)], "next": {"cursor": "page-2"}}

    fake_hypersnap.route(f"{V2}/feed/following", following)

    page = await fetch_following_page(
        viewer_fid=VIEWER_FID,
        limit=25,
        cursor=None,
        following_fids=[FOLLOWED_FID],
        blocked_fids=set(),
    )

    assert _hashes(page["casts"]) == [_hash(1)]
    assert page["next"]["cursor"] == "page-2"


async def test_fetch_first_page_failure_is_sanitized(fake_hypersnap):
    fake_hypersnap.route(f"{V2}/feed/following", (503, {"message": "down"}))

    with pytest.raises(HTTPException) as exc:
        await fetch_following_page(
            viewer_fid=VIEWER_FID,
            limit=25,
            cursor=None,
            following_fids=[FOLLOWED_FID],
            blocked_fids=set(),
        )

    assert exc.value.status_code == 502


async def test_fetch_tops_up_only_the_shortfall(fake_hypersnap):
    def following(params):
        if params.get("cursor") == "page-2":
            return {"casts": [_root(n) for n in range(10, 20)], "next": {"cursor": "x"}}
        casts = [_root(n) for n in range(1, 9)]
        casts += [
            _reply(9, 60, parent_fid=STRANGER_FID),
            _reply(8, 61, parent_fid=STRANGER_FID),
        ]
        return {"casts": casts, "next": {"cursor": "page-2"}}

    fake_hypersnap.route(f"{V2}/feed/following", following)

    await fetch_following_page(
        viewer_fid=VIEWER_FID,
        limit=10,
        cursor=None,
        following_fids=[FOLLOWED_FID],
        blocked_fids=set(),
    )

    calls = fake_hypersnap.calls_to(f"{V2}/feed/following")
    assert [int(call.params["limit"]) for call in calls] == [10, TOP_UP_FACTOR * 2]


async def test_fetch_stops_on_repeated_cursor_without_duplicates(fake_hypersnap):
    fake_hypersnap.route(
        f"{V2}/feed/following",
        {"casts": [_root(1)], "next": {"cursor": "stuck"}},
    )

    page = await fetch_following_page(
        viewer_fid=VIEWER_FID,
        limit=25,
        cursor="stuck",
        following_fids=[FOLLOWED_FID],
        blocked_fids=set(),
    )

    assert _hashes(page["casts"]) == [_hash(1)]
    assert len(fake_hypersnap.calls_to(f"{V2}/feed/following")) == 1


async def test_fetch_hides_replies_to_followed_but_blocked_accounts(fake_hypersnap):
    fake_hypersnap.route(
        f"{V2}/feed/following",
        {"casts": [_reply(2, 60, parent_fid=STRANGER_FID)], "next": {"cursor": None}},
    )

    page = await fetch_following_page(
        viewer_fid=VIEWER_FID,
        limit=25,
        cursor=None,
        following_fids=[FOLLOWED_FID, STRANGER_FID],
        blocked_fids={STRANGER_FID},
    )

    assert page["casts"] == []
