"""Cycle-close admin review flow + @jukeaudio recap cast.

Runs on in-memory SQLite (no Postgres/Neynar/Redis), mirroring
test_leaderboard.py's fixtures. ``get_admin_user`` is overridden directly
(matching tests/test_admin_push.py's pattern) rather than exercised against
a real DB-backed admin row, since the dependency hardcodes its own session
factory (``app.database.async_session``) independent of the ``get_db``
override used for the rest of the test DB.
"""

from datetime import datetime, timezone

import pytest
from jose import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app import database as database_module
from app.config import settings
from app.database import Base
from app.dependencies import get_db
from app.main import app
from app.middleware.auth import get_admin_user
from app.models.leaderboard import LeaderboardAward, LeaderboardScore
from app.models.user import User
from app.services import leaderboard_recap as recap
from app.services import leaderboard_service as svc
from tests.hypersnap_write_fakes import (
    install_system_signer,
    install_write_fakes,
    submit_error,
)

pytest.importorskip("aiosqlite")

# Strictly before "now" regardless of exact day-of-month at test-run time,
# given the repo's current point in time (mid-2026) — matches the hardcoded
# CYCLE="2026-07" convention already used in test_leaderboard.py.
CLOSED_CYCLE = "2026-06"
IN_CLOSED_CYCLE = datetime(2026, 6, 5, 10, 0, tzinfo=timezone.utc)
FUTURE_CYCLE = "2099-01"

_TABLES = [User.__table__, LeaderboardScore.__table__, LeaderboardAward.__table__]


@pytest.fixture
async def db():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all, tables=_TABLES)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


@pytest.fixture
async def api(client, db):
    async def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    try:
        yield client
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
async def admin_api(api):
    async def _admin_override():
        return 777

    app.dependency_overrides[get_admin_user] = _admin_override
    try:
        yield api
    finally:
        app.dependency_overrides.pop(get_admin_user, None)


async def _add_user(
    db, fid, *, username=None, opt_out=False, is_admin=False, is_agent=False
):
    db.add(
        User(
            fid=fid,
            signer_uuid=f"s-{fid}",
            username=username if username is not None else f"user{fid}",
            display_name=f"User {fid}",
            pfp_url=f"https://img/{fid}.png",
            leaderboard_opt_out=opt_out,
            is_admin=is_admin,
            is_agent=is_agent,
        )
    )


def _auth_header(fid: int) -> dict[str, str]:
    token = jwt.encode(
        {"fid": fid, "exp": 4_102_444_800, "source": "first_party"},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


def _point_admin_db_check_at_test_db(db, monkeypatch):
    """Redirect ``get_admin_user``'s hardcoded ``app.database.async_session``
    to a factory bound to the same in-memory engine as the ``db`` fixture
    (``StaticPool`` keeps them on one shared connection, so committed rows
    are visible across sessions). This exercises the REAL is_admin check —
    no live Postgres, no override that bypasses the authorization logic
    itself.
    """
    factory = async_sessionmaker(db.bind, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(database_module, "async_session", factory)


async def _add_score(db, fid, category, score, rank, *, cycle=CLOSED_CYCLE):
    db.add(
        LeaderboardScore(
            fid=fid,
            cycle=cycle,
            category=category,
            score=score,
            rank=rank,
            breakdown={},
            computed_at=IN_CLOSED_CYCLE,
        )
    )


# ---------------------------------------------------------------------------
# Admin-only access
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_standings_requires_admin_auth(api):
    resp = await api.get(f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_close_requires_admin_auth(api):
    resp = await api.post(
        f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}/close",
        json={"exclusions": [], "announce": False},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_standings_non_admin_user_gets_403(api, db, monkeypatch):
    await _add_user(db, 42, is_admin=False)
    await db.commit()
    _point_admin_db_check_at_test_db(db, monkeypatch)

    resp = await api.get(
        f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}", headers=_auth_header(42)
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_close_non_admin_user_gets_403(api, db, monkeypatch):
    await _add_user(db, 42, is_admin=False)
    await db.commit()
    _point_admin_db_check_at_test_db(db, monkeypatch)

    resp = await api.post(
        f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}/close",
        json={},
        headers=_auth_header(42),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_close_real_admin_user_succeeds(db, api, monkeypatch):
    """End-to-end sanity check of the real is_admin gate (not the
    dependency-override bypass used by the rest of this suite)."""
    await _add_user(db, 900, is_admin=True)
    await _add_score(db, 900, "top_hosts", 5.0, None)
    await db.commit()
    _point_admin_db_check_at_test_db(db, monkeypatch)

    resp = await api.post(
        f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}/close",
        json={},
        headers=_auth_header(900),
    )
    assert resp.status_code == 200
    assert resp.json()["awards"][0]["fid"] == 900


# ---------------------------------------------------------------------------
# GET standings
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_standings_returns_all_entries_uncapped_with_opt_out_flag(db, admin_api):
    await _add_user(db, 1)
    for fid in range(2, 26):  # 24 entries — well past the public 20-entry cap
        await _add_user(db, fid)
        await _add_score(db, fid, "top_hosts", float(fid), fid - 1)
    await db.commit()
    # Opted out *after* scoring ran — the admin view must reflect the
    # current flag, not a stale one baked into the score row.
    user1 = (await db.execute(select(User).where(User.fid == 2))).scalar_one()
    user1.leaderboard_opt_out = True
    await db.commit()

    resp = await admin_api.get(f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["cycle"] == CLOSED_CYCLE
    assert body["status"] == "open"
    hosts = next(c for c in body["categories"] if c["key"] == "top_hosts")
    assert len(hosts["entries"]) == 24
    entry2 = next(e for e in hosts["entries"] if e["fid"] == 2)
    assert entry2["opt_out"] is True
    other = next(e for e in hosts["entries"] if e["fid"] == 3)
    assert other["opt_out"] is False


@pytest.mark.asyncio
async def test_standings_surface_is_agent_flag(db, admin_api):
    """The reviewer must be able to see agent-flagged entries whose flag
    postdates the score snapshot — close drops them automatically, and the
    standings view should explain why."""
    await _add_user(db, 1, is_agent=True)
    await _add_user(db, 2)
    await _add_score(db, 1, "top_hosts", 5.0, 1)
    await _add_score(db, 2, "top_hosts", 3.0, 2)
    await db.commit()

    resp = await admin_api.get(f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}")
    hosts = next(c for c in resp.json()["categories"] if c["key"] == "top_hosts")
    flags = {e["fid"]: e["is_agent"] for e in hosts["entries"]}
    assert flags == {1: True, 2: False}


@pytest.mark.asyncio
async def test_standings_invalid_cycle_422(admin_api):
    resp = await admin_api.get("/v1/leaderboard/admin/cycle/not-a-cycle")
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_standings_status_final_after_award(db, admin_api):
    await _add_user(db, 1)
    await _add_score(db, 1, "top_hosts", 5.0, 1)
    db.add(
        LeaderboardAward(
            fid=1, cycle=CLOSED_CYCLE, category="top_hosts", rank=1, label="Top Host"
        )
    )
    await db.commit()
    resp = await admin_api.get(f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}")
    assert resp.json()["status"] == "final"


# ---------------------------------------------------------------------------
# POST close — happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_close_writes_top_3_and_flips_public_status_final(db, admin_api):
    for fid, score in [(1, 10.0), (2, 8.0), (3, 6.0), (4, 4.0), (5, 2.0)]:
        await _add_user(db, fid)
        await _add_score(db, fid, "top_hosts", score, None)
    await db.commit()

    resp = await admin_api.post(
        f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}/close",
        json={"exclusions": [], "announce": False},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["cycle"] == CLOSED_CYCLE
    assert body["announce_cast_hash"] is None
    fids_awarded = {a["fid"] for a in body["awards"]}
    assert fids_awarded == {1, 2, 3}
    ranks = {a["fid"]: a["rank"] for a in body["awards"]}
    assert ranks == {1: 1, 2: 2, 3: 3}
    labels = {a["label"] for a in body["awards"]}
    assert labels == {"Top Host"}

    # Public board flips to "final" immediately (cache busted).
    public_resp = await admin_api.get(f"/v1/leaderboard?cycle={CLOSED_CYCLE}")
    assert public_resp.json()["status"] == "final"


@pytest.mark.asyncio
async def test_close_awards_persisted_in_db(db, admin_api):
    await _add_user(db, 1)
    await _add_score(db, 1, "community", 3.0, None)
    await db.commit()

    resp = await admin_api.post(
        f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}/close",
        json={},
    )
    assert resp.status_code == 200
    stored = (
        (
            await db.execute(
                select(LeaderboardAward).where(LeaderboardAward.cycle == CLOSED_CYCLE)
            )
        )
        .scalars()
        .all()
    )
    assert len(stored) == 1
    assert stored[0].fid == 1
    assert stored[0].label == "Community"


# ---------------------------------------------------------------------------
# Exclusions re-rank
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_close_exclusions_rerank_remaining_entries(db, admin_api):
    for fid, score in [(1, 10.0), (2, 8.0), (3, 6.0), (4, 4.0)]:
        await _add_user(db, fid)
        await _add_score(db, fid, "top_voices", score, None)
    await db.commit()

    resp = await admin_api.post(
        f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}/close",
        json={"exclusions": [1], "announce": False},
    )
    assert resp.status_code == 200
    body = resp.json()
    ranks = {a["fid"]: a["rank"] for a in body["awards"]}
    # fid 1 excluded -> 2 becomes rank 1, 3 rank 2, 4 rank 3. All 3 remaining
    # scored entries qualify for "top 3".
    assert ranks == {2: 1, 3: 2, 4: 3}
    assert 1 not in ranks


@pytest.mark.asyncio
async def test_close_excludes_currently_opted_out_even_without_manual_exclusion(
    db, admin_api
):
    """A user who opted out after scoring ran must not receive an award even
    if the admin didn't explicitly list them — opt-out is honored
    everywhere, not just when manually remembered."""
    for fid, score in [(1, 10.0), (2, 8.0), (3, 6.0), (4, 4.0)]:
        await _add_user(db, fid)
        await _add_score(db, fid, "top_casters", score, None)
    user1 = (await db.execute(select(User).where(User.fid == 1))).scalar_one()
    user1.leaderboard_opt_out = True
    await db.commit()

    resp = await admin_api.post(
        f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}/close",
        json={"exclusions": [], "announce": False},
    )
    assert resp.status_code == 200
    fids_awarded = {a["fid"] for a in resp.json()["awards"]}
    assert 1 not in fids_awarded
    assert fids_awarded == {2, 3, 4}


@pytest.mark.asyncio
async def test_close_excludes_agent_flagged_after_scoring(db, admin_api):
    """A fid flagged is_agent after the last nightly pass still has a stale
    score row — close must re-check the flag (like the public board does)
    so a bot never receives a permanent award or a recap mention."""
    await _add_user(db, 1, is_agent=True)
    for fid, score in [(2, 8.0), (3, 6.0), (4, 4.0)]:
        await _add_user(db, fid)
    for fid, score in [(1, 10.0), (2, 8.0), (3, 6.0), (4, 4.0)]:
        await _add_score(db, fid, "top_hosts", score, None)
    await db.commit()

    resp = await admin_api.post(
        f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}/close",
        json={"exclusions": [], "announce": False},
    )
    assert resp.status_code == 200
    ranks = {a["fid"]: a["rank"] for a in resp.json()["awards"]}
    assert ranks == {2: 1, 3: 2, 4: 3}


@pytest.mark.asyncio
async def test_close_excludes_brand_fid(db, admin_api, monkeypatch):
    from app.config import settings as app_settings

    monkeypatch.setattr(app_settings, "BRAND_FID", 99)
    await _add_user(db, 99)
    await _add_user(db, 2)
    await _add_score(db, 99, "top_casters", 10.0, None)
    await _add_score(db, 2, "top_casters", 5.0, None)
    await db.commit()

    resp = await admin_api.post(
        f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}/close",
        json={"exclusions": [], "announce": False},
    )
    assert resp.status_code == 200
    ranks = {a["fid"]: a["rank"] for a in resp.json()["awards"]}
    assert ranks == {2: 1}


@pytest.mark.asyncio
async def test_close_empty_cycle_422_and_does_not_mark_final(db, admin_api):
    """Zero qualifying entries must refuse to close: awards are the only
    "final" marker, so writing nothing would leave status "open" forever
    and let a re-close return 200 instead of 409."""
    resp = await admin_api.post(
        f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}/close",
        json={"exclusions": [], "announce": False},
    )
    assert resp.status_code == 422

    standings = await admin_api.get(f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}")
    assert standings.json()["status"] == "open"


@pytest.mark.asyncio
async def test_close_all_candidates_excluded_422(db, admin_api):
    await _add_user(db, 1)
    await _add_score(db, 1, "top_hosts", 5.0, None)
    await db.commit()

    resp = await admin_api.post(
        f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}/close",
        json={"exclusions": [1], "announce": False},
    )
    assert resp.status_code == 422
    stored = (
        (
            await db.execute(
                select(LeaderboardAward).where(LeaderboardAward.cycle == CLOSED_CYCLE)
            )
        )
        .scalars()
        .all()
    )
    assert stored == []


# ---------------------------------------------------------------------------
# Tie handling
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_close_ties_can_award_more_than_three(db, admin_api):
    for fid, score in [(1, 10.0), (2, 10.0), (3, 10.0), (4, 5.0), (5, 1.0)]:
        await _add_user(db, fid)
        await _add_score(db, fid, "top_hosts", score, None)
    await db.commit()

    resp = await admin_api.post(
        f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}/close",
        json={"exclusions": [], "announce": False},
    )
    body = resp.json()
    fids_awarded = {a["fid"] for a in body["awards"]}
    # 1, 2, 3 tie for rank 1 (all <= 3); fid 4 is rank 4, excluded.
    assert fids_awarded == {1, 2, 3}
    assert all(a["rank"] == 1 for a in body["awards"])


# ---------------------------------------------------------------------------
# Idempotency / validation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_close_twice_returns_409(db, admin_api):
    await _add_user(db, 1)
    await _add_score(db, 1, "top_hosts", 5.0, None)
    await db.commit()

    first = await admin_api.post(
        f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}/close", json={}
    )
    assert first.status_code == 200
    second = await admin_api.post(
        f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}/close", json={}
    )
    assert second.status_code == 409


@pytest.mark.asyncio
async def test_close_current_cycle_422(admin_api):
    current = svc.current_cycle()
    resp = await admin_api.post(f"/v1/leaderboard/admin/cycle/{current}/close", json={})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_close_future_cycle_422(admin_api):
    resp = await admin_api.post(
        f"/v1/leaderboard/admin/cycle/{FUTURE_CYCLE}/close", json={}
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_close_malformed_cycle_422(admin_api):
    resp = await admin_api.post(
        "/v1/leaderboard/admin/cycle/not-a-cycle/close", json={}
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Announce / recap cast
# ---------------------------------------------------------------------------


BRAND_FID = 999


@pytest.mark.asyncio
async def test_close_announce_success_includes_cast_hash(db, admin_api, monkeypatch):
    await _add_user(db, 1, username="alice")
    await _add_score(db, 1, "top_hosts", 5.0, None)
    await db.commit()

    install_system_signer(monkeypatch, brand_fid=BRAND_FID)
    fakes = install_write_fakes(monkeypatch)

    resp = await admin_api.post(
        f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}/close",
        json={"exclusions": [], "announce": True},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["announce_cast_hash"] == fakes.node.hashes[0]
    assert fakes.node.attempts == 1
    data = fakes.node.bodies[0]
    assert data.fid == BRAND_FID
    # The @alice mention becomes a protocol mention of her FID (no lookup).
    assert list(data.cast_add_body.mentions) == [1]
    assert "@alice" not in data.cast_add_body.text
    assert [e.url for e in data.cast_add_body.embeds] == [recap.LEADERBOARD_URL]
    assert not [c for c in fakes.reads.calls if c[0] == "/user/by-username"]


@pytest.mark.asyncio
async def test_close_announce_failure_does_not_roll_back_awards(
    db, admin_api, monkeypatch
):
    await _add_user(db, 1, username="alice")
    await _add_score(db, 1, "top_hosts", 5.0, None)
    await db.commit()

    install_system_signer(monkeypatch, brand_fid=BRAND_FID)
    fakes = install_write_fakes(monkeypatch)
    fakes.node.errors = [submit_error(503)]

    resp = await admin_api.post(
        f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}/close",
        json={"exclusions": [], "announce": True},
    )
    # The close itself must succeed and awards must still be committed —
    # only the announce is best-effort.
    assert resp.status_code == 200
    body = resp.json()
    assert body["announce_cast_hash"] is None
    assert len(body["awards"]) == 1

    stored = (
        (
            await db.execute(
                select(LeaderboardAward).where(LeaderboardAward.cycle == CLOSED_CYCLE)
            )
        )
        .scalars()
        .all()
    )
    assert len(stored) == 1


@pytest.mark.asyncio
async def test_close_announce_false_never_submits(db, admin_api, monkeypatch):
    await _add_user(db, 1, username="alice")
    await _add_score(db, 1, "top_hosts", 5.0, None)
    await db.commit()

    install_system_signer(monkeypatch, brand_fid=BRAND_FID)
    fakes = install_write_fakes(monkeypatch)

    resp = await admin_api.post(
        f"/v1/leaderboard/admin/cycle/{CLOSED_CYCLE}/close",
        json={"exclusions": [], "announce": False},
    )
    assert resp.status_code == 200
    assert resp.json()["announce_cast_hash"] is None
    assert fakes.node.attempts == 0


# ---------------------------------------------------------------------------
# Recap text composition (unit-level, no HTTP)
# ---------------------------------------------------------------------------


def test_recap_text_respects_byte_limit_by_dropping_categories():
    winners = [
        (f"Category {i}", [f"user_with_a_pretty_long_handle_{i}_{j}" for j in range(5)])
        for i in range(10)
    ]
    text = recap._compose_text(winners)  # noqa: SLF001
    assert len(text.encode("utf-8")) <= recap.CAST_BYTE_LIMIT


def test_recap_text_includes_short_category_lines_untruncated():
    winners = [("Top Host", ["alice", "bob"]), ("Community", ["carol"])]
    text = recap._compose_text(winners)  # noqa: SLF001
    assert "Top Host: @alice, @bob" in text
    assert "Community: @carol" in text
    assert len(text.encode("utf-8")) <= recap.CAST_BYTE_LIMIT


def test_recap_text_single_oversized_category_trims_mentions_not_everything():
    """A single category whose mention list alone busts the byte budget
    (e.g. a large rank tie) must trim trailing mentions, not degrade to a
    winnerless header-only cast. The top-ranked mention survives."""
    winners = [("Top Host", [f"user_with_a_rather_long_handle_{i}" for i in range(40)])]
    text = recap._compose_text(winners)  # noqa: SLF001
    assert len(text.encode("utf-8")) <= recap.CAST_BYTE_LIMIT
    assert "@user_with_a_rather_long_handle_0" in text


@pytest.mark.asyncio
async def test_post_recap_cast_skips_when_signer_not_configured(monkeypatch):
    monkeypatch.setattr(recap.farcaster_writes.settings, "BRAND_FID", None)
    result = await recap.post_recap_cast(
        None,
        [{"fid": 1, "category": "top_hosts", "label": "Top Host", "rank": 1}],
        cycle=CLOSED_CYCLE,
    )
    assert result is None


@pytest.mark.asyncio
async def test_post_recap_cast_returns_none_for_no_awards(db):
    result = await recap.post_recap_cast(db, [], cycle=CLOSED_CYCLE)
    assert result is None
