"""Tests for the local (Hypersnap) spam heuristic, composite scoring, the
SpamService cache/DB/heuristic resolution order, and migration 032.
"""

import importlib.util
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import sqlalchemy as sa
from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext

from app.services import spam_service as spam
from app.services.spam_service import (
    LABEL_CLEAN,
    LABEL_NERFED,
    LABEL_SPAM,
    SPAM_THRESHOLD,
    SpamService,
    compute_composite,
    compute_user_score,
    has_trust_signals,
)

NOW = datetime(2026, 10, 16, tzinfo=timezone.utc)


def _iso(days_ago: float) -> str:
    return (NOW - timedelta(days=days_ago)).isoformat().replace("+00:00", "Z")


def _user(**overrides) -> dict:
    """An established, complete Hypersnap user object (shape verified live)."""
    user = {
        "object": "user",
        "fid": 500000,
        "username": "thegameworld",
        "display_name": "Rodney",
        "pfp_url": "https://imagedelivery.net/x/original",
        "registered_at": _iso(900),
        "follower_count": 1383,
        "following_count": 1310,
        "verifications": ["0xa98d65e6dc80b0954dca0111101a898fe60252e3"],
        "verified_addresses": {"eth_addresses": [], "sol_addresses": []},
    }
    user.update(overrides)
    return user


def _is_spam(user: dict) -> bool:
    return compute_composite(compute_user_score(user, now=NOW), None)[1]


# ---------------------------------------------------------------------------
# compute_user_score
# ---------------------------------------------------------------------------


def test_established_complete_profile_scores_max():
    assert compute_user_score(_user(), now=NOW) == pytest.approx(1.0)
    assert not _is_spam(_user())


def test_power_badge_short_circuits_to_full_trust():
    bare = {"fid": 1, "power_badge": True, "follower_count": 0}
    assert compute_user_score(bare, now=NOW) == 1.0


def test_fresh_empty_default_account_is_spam():
    bot = _user(
        fid=1234567,
        username="user1234567",
        pfp_url=None,
        registered_at=_iso(0),
        follower_count=0,
        following_count=0,
        verifications=[],
    )
    assert compute_user_score(bot, now=NOW) == pytest.approx(0.0)
    assert _is_spam(bot)


def test_old_default_account_with_few_followers_is_not_spam():
    """Live fid 1234567: >1y old, 2 followers, verified, default username."""
    user = _user(
        username="user1234567",
        pfp_url=None,
        registered_at=_iso(420),
        follower_count=2,
        following_count=0,
    )
    assert not _is_spam(user)


def test_brand_new_real_user_with_a_few_followers_is_not_spam():
    user = _user(registered_at=_iso(1), follower_count=3, following_count=20)
    assert not _is_spam(user)


def test_follow_farming_penalty_flips_to_spam():
    base = {"username": "user77", "pfp_url": None, "registered_at": _iso(30)}
    honest = _user(**base, follower_count=40, following_count=300)
    farmer = _user(**base, follower_count=40, following_count=4000)
    assert not _is_spam(honest)
    assert compute_user_score(farmer, now=NOW) == pytest.approx(
        compute_user_score(honest, now=NOW) * spam.FOLLOW_FARM_PENALTY
    )
    assert _is_spam(farmer)


def test_follower_signal_saturates_and_is_monotonic():
    scores = [
        compute_user_score(_user(follower_count=n, following_count=0), now=NOW)
        for n in (0, 10, 100, 1000, 1_000_000)
    ]
    assert scores == sorted(scores)
    assert scores[-1] == scores[-2] == pytest.approx(1.0)


def test_age_signal_saturates_at_one_year():
    young = compute_user_score(_user(registered_at=_iso(0)), now=NOW)
    half = compute_user_score(_user(registered_at=_iso(182.5)), now=NOW)
    year = compute_user_score(_user(registered_at=_iso(365)), now=NOW)
    old = compute_user_score(_user(registered_at=_iso(3650)), now=NOW)
    assert young < half < year == pytest.approx(old)
    assert year - young == pytest.approx(spam.AGE_WEIGHT)


def test_missing_signals_are_neutral_not_penalised():
    sparse = {"fid": 42, "follower_count": 1000}
    # follower 0.5 + age neutral 0.1 + profile neutral 0.15 → 0.75
    assert compute_user_score(sparse, now=NOW) == pytest.approx(0.75)


def test_absent_profile_keys_are_neutral_but_present_empty_ones_fail():
    absent = {"fid": 42, "follower_count": 0}
    empty = {
        "fid": 42,
        "follower_count": 0,
        "pfp_url": None,
        "username": "user42",
        "verifications": [],
    }
    assert compute_user_score(absent, now=NOW) == pytest.approx(
        spam.AGE_WEIGHT * 0.5 + spam.PROFILE_WEIGHT * 0.5
    )
    assert compute_user_score(empty, now=NOW) == pytest.approx(spam.AGE_WEIGHT * 0.5)


@pytest.mark.parametrize(
    "keep",
    [
        ("username", "follower_count"),
        ("follower_count",),
        ("pfp_url", "follower_count", "registered_at"),
        ("username", "verifications", "follower_count"),
    ],
)
def test_sparse_object_never_yields_a_verdict(keep):
    # 3-day-old account with pfp, custom username and a verification, no
    # followers yet: not spam from the full object. A sparse subset of it
    # (webhook stub) would score lower, so it must produce no verdict at all
    # rather than cache a spam flag under the same trust:{fid} key.
    full = _user(registered_at=_iso(3), follower_count=0, following_count=0)
    assert not _is_spam(full)
    sparse = {"fid": full["fid"], **{key: full[key] for key in keep}}
    assert spam._score_user(sparse) is None
    assert SpamService._verdict(None, spam._score_user(sparse)) is None


def test_verified_addresses_counts_as_verification():
    a = _user(verifications=[], verified_addresses={"eth_addresses": ["0xabc"]})
    b = _user(verifications=[], verified_addresses={"eth_addresses": []})
    assert compute_user_score(a, now=NOW) > compute_user_score(b, now=NOW)


@pytest.mark.parametrize("username", ["user99", "!99", "fid-99", "FID99"])
def test_default_usernames_lose_profile_credit(username):
    assert compute_user_score(_user(username=username), now=NOW) == pytest.approx(
        1.0 - spam.PROFILE_WEIGHT / 3
    )


def test_garbage_fields_do_not_raise():
    user = {
        "fid": 7,
        "follower_count": "lots",
        "following_count": -5,
        "registered_at": "not-a-date",
        "verified_addresses": "nope",
    }
    assert not has_trust_signals(user)
    assert 0.0 <= compute_user_score(user, now=NOW) <= 1.0


def test_has_trust_signals():
    assert not has_trust_signals(None)
    assert not has_trust_signals({"fid": 1, "username": "x"})
    assert not has_trust_signals({"fid": 1, "follower_count": 0})
    assert not has_trust_signals({"fid": 1, "registered_at": _iso(1)})
    assert has_trust_signals({"fid": 1, "power_badge": True})
    assert has_trust_signals(_user())
    assert has_trust_signals(_user(pfp_url=None, verifications=[]))
    assert not has_trust_signals(_user(follower_count=True))


@pytest.mark.parametrize(
    "missing",
    ["follower_count", "registered_at", "pfp_url", "username", "verifications"],
)
def test_has_trust_signals_requires_every_scored_field(missing):
    user = _user()
    user.pop(missing)
    if missing == "verifications":
        user.pop("verified_addresses")
    assert not has_trust_signals(user)


# ---------------------------------------------------------------------------
# compute_composite thresholds
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("label", [LABEL_SPAM, LABEL_NERFED])
def test_warpcast_hard_block_beats_perfect_score(label):
    assert compute_composite(1.0, label) == (0.0, True)


def test_clean_label_rescues_low_score():
    composite, is_spam = compute_composite(0.0, LABEL_CLEAN)
    assert composite == pytest.approx(spam.WARPCAST_WEIGHT)
    assert not is_spam


def test_label_only_rows():
    assert compute_composite(None, LABEL_CLEAN) == (1.0, False)
    assert compute_composite(None, None) == (0.5, False)


def test_threshold_boundary_without_label():
    # composite = 0.65 * s + 0.175 ; boundary at s = (T - 0.175) / 0.65
    boundary = (SPAM_THRESHOLD - spam.WARPCAST_WEIGHT * 0.5) / spam.SCORE_WEIGHT
    assert compute_composite(boundary + 1e-6, None)[1] is False
    assert compute_composite(boundary - 1e-6, None)[1] is True


def test_composite_clamps_out_of_range_scores():
    assert compute_composite(5.0, None) == compute_composite(1.0, None)
    assert compute_composite(-5.0, None) == compute_composite(0.0, None)


# ---------------------------------------------------------------------------
# SpamService resolution order (cache → DB row → heuristic)
# ---------------------------------------------------------------------------


def _db_returning(row) -> AsyncMock:
    result = MagicMock()
    result.scalar_one_or_none = MagicMock(return_value=row)
    scalars = MagicMock()
    scalars.all = MagicMock(return_value=[row] if row else [])
    result.scalars = MagicMock(return_value=scalars)
    db = AsyncMock()
    db.execute = AsyncMock(return_value=result)
    return db


def _redis(cached: dict | None = None) -> MagicMock:
    redis = MagicMock()
    redis.get = AsyncMock(return_value=json.dumps(cached) if cached else None)
    redis.mget = AsyncMock(side_effect=lambda keys: [None] * len(keys))
    redis.setex = AsyncMock()
    pipe = MagicMock()
    pipe.execute = AsyncMock()
    redis.pipeline = MagicMock(return_value=pipe)
    return redis


@pytest.fixture(autouse=True)
def _spam_enabled():
    with patch.object(spam.settings, "SPAM_FILTER_ENABLED", True):
        yield


BOT = {
    "fid": 1234567,
    "username": "user1234567",
    "registered_at": datetime.now(timezone.utc).isoformat(),
    "follower_count": 0,
    "following_count": 0,
    "pfp_url": None,
    "verifications": [],
}


async def test_is_spam_scores_user_object_when_no_row_and_caches():
    redis = _redis()
    svc = SpamService(_db_returning(None), redis)
    assert await svc.is_spam(BOT["fid"], BOT) is True
    redis.setex.assert_awaited_once()
    assert json.loads(redis.setex.await_args.args[2])["is_spam"] is True


async def test_is_spam_prefers_cache():
    db = _db_returning(None)
    svc = SpamService(db, _redis({"is_spam": False}))
    assert await svc.is_spam(BOT["fid"], BOT) is False
    db.execute.assert_not_awaited()


async def test_is_spam_db_row_wins_over_heuristic():
    row = MagicMock(composite=1.0, is_spam=False)
    svc = SpamService(_db_returning(row), _redis())
    assert await svc.is_spam(BOT["fid"], BOT) is False


async def test_is_spam_without_signals_is_false_and_not_cached():
    redis = _redis()
    svc = SpamService(_db_returning(None), redis)
    assert await svc.is_spam(99, {"fid": 99, "username": "x"}) is False
    assert await svc.is_spam(99) is False
    redis.setex.assert_not_awaited()


async def test_sparse_bot_stub_is_not_flagged_or_cached():
    # A webhook stub of an obvious bot carries too little to be decisive; it
    # must not pin a verdict that a later full object would disagree with.
    stub = {key: BOT[key] for key in ("fid", "username", "follower_count")}
    redis = _redis()
    svc = SpamService(_db_returning(None), redis)
    assert await svc.is_spam(stub["fid"], stub) is False
    await svc.annotate_users([dict(stub)])
    redis.setex.assert_not_awaited()
    redis.pipeline.return_value.setex.assert_not_called()


async def test_is_spam_disabled_short_circuits():
    with patch.object(spam.settings, "SPAM_FILTER_ENABLED", False):
        svc = SpamService(AsyncMock(), _redis())
        assert await svc.is_spam(BOT["fid"], BOT) is False


async def test_annotate_casts_uses_author_objects():
    redis = _redis()
    svc = SpamService(_db_returning(None), redis)
    good = _user(fid=3, follower_count=1_000_000)
    casts = [{"author": dict(BOT)}, {"author": good}, {"author": {"fid": 5}}]
    await svc.annotate_casts(casts)
    assert [c["author"]["is_spam"] for c in casts] == [True, False, False]
    # fid 5 had no signals → not cached
    assert redis.pipeline.return_value.setex.call_count == 2


async def test_filter_users_drops_spam():
    svc = SpamService(_db_returning(None), _redis())
    good = _user(fid=3, follower_count=5000)
    assert await svc.filter_users([dict(BOT), good]) == [good]


# ---------------------------------------------------------------------------
# Migration 032: neynar_score -> score + source
# ---------------------------------------------------------------------------

MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "alembic"
    / "versions"
    / "032_trust_scores_score_source.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("migration_032", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run(conn, fn) -> None:
    with Operations.context(MigrationContext.configure(conn)):
        fn()


def test_migration_revision_chain():
    module = _load_migration()
    assert (module.revision, module.down_revision) == ("032_trust_score_source", "031")


def test_migration_preserves_neynar_scores_and_round_trips():
    module = _load_migration()
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(
            sa.text(
                "CREATE TABLE trust_scores (fid BIGINT PRIMARY KEY, "
                "neynar_score FLOAT, warpcast_label SMALLINT, "
                "composite FLOAT NOT NULL, is_spam BOOLEAN NOT NULL)"
            )
        )
        conn.execute(
            sa.text(
                "INSERT INTO trust_scores VALUES "
                "(1, 0.92, NULL, 0.77, 0), (2, NULL, 0, 0.0, 1)"
            )
        )

        _run(conn, module.upgrade)
        rows = conn.execute(
            sa.text("SELECT fid, score, source FROM trust_scores ORDER BY fid")
        ).all()
        assert rows == [(1, 0.92, "neynar"), (2, None, None)]

        conn.execute(
            sa.text(
                "INSERT INTO trust_scores (fid, score, source, composite, is_spam) "
                "VALUES (3, 0.1, 'heuristic', 0.24, 1)"
            )
        )

        _run(conn, module.downgrade)
        columns = {c["name"] for c in sa.inspect(conn).get_columns("trust_scores")}
        assert "neynar_score" in columns
        assert not {"score", "source"} & columns
        rows = conn.execute(
            sa.text("SELECT fid, neynar_score FROM trust_scores ORDER BY fid")
        ).all()
        # Legacy Neynar data survives; heuristic scores are not Neynar scores.
        assert rows == [(1, 0.92), (2, None), (3, None)]


# ---------------------------------------------------------------------------
# push_service hands the actor object (not a Neynar score) to SpamService
# ---------------------------------------------------------------------------


def test_push_extract_actor_returns_user_object():
    from app.services.push_service import _extract_actor

    actor = {"fid": 9001, "follower_count": 0}
    payload = {"data": {"user": actor}}
    assert _extract_actor("reaction.created", payload) == (9001, actor)
    assert _extract_actor("unknown", payload) == (None, None)
