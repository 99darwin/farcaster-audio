"""Scoring math, exclusion rules, ranking, and API tests for the recognition
leaderboard. Runs on in-memory SQLite (no Postgres/Neynar/Redis)."""

import math
from datetime import datetime, timezone

import pytest
from jose import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import Base
from app.dependencies import get_db
from app.main import app
from app.models.cast_record import CastRecord
from app.models.leaderboard import LeaderboardAward, LeaderboardScore
from app.models.participant import Participant
from app.models.room import Room
from app.models.user import User
from app.models.voice_note import VoiceNote
from app.services import leaderboard_service as svc

pytest.importorskip("aiosqlite")

CYCLE = "2026-07"
IN_CYCLE = datetime(2026, 7, 5, 10, 0, tzinfo=timezone.utc)


def auth_header(fid: int) -> dict[str, str]:
    token = jwt.encode(
        {"fid": fid, "exp": 4_102_444_800, "source": "first_party"},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


class FakeFetcher:
    """Duck-typed stand-in for HypersnapEngagementFetcher."""

    def __init__(self, mapping: dict[str, set[int]] | None = None) -> None:
        self.mapping = mapping or {}

    async def distinct_engagers(self, cast_hash: str) -> set[int]:
        return set(self.mapping.get(cast_hash, set()))


_TABLES = [
    User.__table__,
    Room.__table__,
    Participant.__table__,
    CastRecord.__table__,
    LeaderboardScore.__table__,
    LeaderboardAward.__table__,
]

# The VoiceNote model uses raw Postgres JSONB columns that can't render on
# SQLite. The scoring engine only reads fid/cast_hash/created_at/deleted_at,
# so a minimal SQLite-compatible table is enough for these tests.
_VOICE_NOTES_DDL = """
CREATE TABLE voice_notes (
    id CHAR(32) PRIMARY KEY,
    fid BIGINT NOT NULL,
    duration_ms INTEGER NOT NULL,
    audio_url TEXT NOT NULL,
    audio_size INTEGER NOT NULL,
    waveform_peaks TEXT,
    transcript TEXT,
    transcript_lang VARCHAR(10),
    transcript_words TEXT,
    cast_hash VARCHAR(66),
    cast_url TEXT,
    parent_cast_hash VARCHAR(66),
    caption TEXT,
    created_at TIMESTAMP,
    deleted_at TIMESTAMP
)
"""


@pytest.fixture
async def db():
    from sqlalchemy import text

    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all, tables=_TABLES)
        await conn.execute(text(_VOICE_NOTES_DDL))
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


async def _add_user(db, fid, *, is_agent=False, opt_out=False, signer="s"):
    db.add(
        User(
            fid=fid,
            signer_uuid=f"{signer}-{fid}",
            username=f"user{fid}",
            display_name=f"User {fid}",
            pfp_url=f"https://img/{fid}.png",
            is_agent=is_agent,
            leaderboard_opt_out=opt_out,
        )
    )


async def _add_room(db, host_fid, *, minutes=20, started=IN_CYCLE, ended=True):
    room = Room(
        title="t",
        host_fid=host_fid,
        status="ended",
        started_at=started,
        ended_at=(started + _mins(minutes)) if ended else None,
    )
    db.add(room)
    await db.flush()
    return room


def _mins(m):
    from datetime import timedelta

    return timedelta(minutes=m)


async def _join(db, room_id, fid, role="listener", joined=IN_CYCLE):
    db.add(Participant(room_id=room_id, fid=fid, role=role, joined_at=joined))


# ---------------------------------------------------------------------------
# Scoring math
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_top_hosts_sqrt_of_distinct_listeners(db):
    await _add_user(db, 1)
    for f in (10, 11, 12, 13):
        await _add_user(db, f)
    room = await _add_room(db, 1)
    # Host in own participant row must be excluded; a duplicate listener fid
    # must be counted once.
    await _join(db, room.id, 1, role="host")
    for f in (10, 11, 12, 13):
        await _join(db, room.id, f)
    await db.commit()

    rows = await svc.compute_cycle_scores(db, FakeFetcher(), cycle=CYCLE)
    host = next(r for r in rows if r.category == "top_hosts")
    assert host.fid == 1
    assert math.isclose(host.score, math.sqrt(4))


@pytest.mark.asyncio
async def test_short_room_does_not_score(db):
    await _add_user(db, 1)
    await _add_user(db, 10)
    room = await _add_room(db, 1, minutes=5)  # below the 10-min floor
    await _join(db, room.id, 10)
    await db.commit()

    rows = await svc.compute_cycle_scores(db, FakeFetcher(), cycle=CYCLE)
    assert not [r for r in rows if r.category == "top_hosts"]


@pytest.mark.asyncio
async def test_top_voices_concave_and_self_engagement_excluded(db):
    await _add_user(db, 1)
    db.add(
        VoiceNote(
            fid=1,
            duration_ms=5000,
            audio_url="u",
            audio_size=1,
            cast_hash="0xv1",
            created_at=IN_CYCLE,
        )
    )
    await db.commit()
    # Author (fid 1) reacts to their own note -> must not count. 3 distinct
    # others -> 1 + sqrt(3).
    fetcher = FakeFetcher({"0xv1": {1, 20, 21, 22}})
    rows = await svc.compute_cycle_scores(db, fetcher, cycle=CYCLE)
    voice = next(r for r in rows if r.category == "top_voices")
    assert math.isclose(voice.score, 1.0 + math.sqrt(3))
    assert voice.breakdown["items"][0]["engagers"] == [20, 21, 22]


@pytest.mark.asyncio
async def test_top_casters_excludes_voice_note_source(db):
    await _add_user(db, 1)
    db.add(CastRecord(fid=1, cast_hash="0xc1", source="composer", created_at=IN_CYCLE))
    db.add(
        CastRecord(fid=1, cast_hash="0xvn", source="voice_note", created_at=IN_CYCLE)
    )
    await db.commit()
    fetcher = FakeFetcher({"0xc1": {30, 31}, "0xvn": {40, 41, 42}})
    rows = await svc.compute_cycle_scores(db, fetcher, cycle=CYCLE)
    caster = next(r for r in rows if r.category == "top_casters")
    # Only the composer cast scores; the voice_note source is skipped here.
    assert math.isclose(caster.score, 1.0 + math.sqrt(2))
    assert len(caster.breakdown["items"]) == 1


@pytest.mark.asyncio
async def test_community_speaker_and_join_weights(db):
    await _add_user(db, 1)  # host of the room
    await _add_user(db, 2)  # speaker in someone else's room
    room = await _add_room(db, 1)
    await _join(db, room.id, 1, role="host")
    await _join(db, room.id, 2, role="speaker")
    await db.commit()

    rows = await svc.compute_cycle_scores(db, FakeFetcher(), cycle=CYCLE)
    community = {r.fid: r for r in rows if r.category == "community"}
    # fid 2: spoke in 1 room hosted by other (3.0) + joined 1 room (1.0) = 4.0
    assert math.isclose(community[2].score, 4.0)
    # fid 1 only participated in their OWN room — that's rewarded under
    # top_hosts, never under community (no double-dipping).
    assert 1 not in community


@pytest.mark.asyncio
async def test_out_of_cycle_data_ignored(db):
    await _add_user(db, 1)
    await _add_user(db, 10)
    room = await _add_room(db, 1, started=datetime(2026, 6, 15, tzinfo=timezone.utc))
    await _join(db, room.id, 10, joined=datetime(2026, 6, 15, tzinfo=timezone.utc))
    await db.commit()
    rows = await svc.compute_cycle_scores(db, FakeFetcher(), cycle=CYCLE)
    assert rows == []


# ---------------------------------------------------------------------------
# Exclusion rules
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_agent_and_optout_hosts_excluded(db):
    await _add_user(db, 1, is_agent=True)
    await _add_user(db, 2, opt_out=True)
    await _add_user(db, 10)
    r1 = await _add_room(db, 1)
    r2 = await _add_room(db, 2)
    await _join(db, r1.id, 10)
    await _join(db, r2.id, 10)
    await db.commit()
    rows = await svc.compute_cycle_scores(db, FakeFetcher(), cycle=CYCLE)
    assert not [r for r in rows if r.fid in (1, 2)]


@pytest.mark.asyncio
async def test_brand_fid_excluded_via_setting(db, monkeypatch):
    monkeypatch.setattr(settings, "BRAND_FID", 99)
    await _add_user(db, 99)
    await _add_user(db, 10)
    room = await _add_room(db, 99)
    await _join(db, room.id, 10)
    await db.commit()
    rows = await svc.compute_cycle_scores(db, FakeFetcher(), cycle=CYCLE)
    assert not [r for r in rows if r.fid == 99]


@pytest.mark.asyncio
async def test_brand_fid_resolved_from_signer(db, monkeypatch):
    monkeypatch.setattr(settings, "BRAND_FID", None)
    monkeypatch.setattr(settings, "JUKEAUDIO_SIGNER_UUID", "brand-signer")
    db.add(User(fid=99, signer_uuid="brand-signer", username="jukeaudio"))
    await db.commit()
    assert await svc.resolve_brand_fid(db) == 99


# ---------------------------------------------------------------------------
# Ranking
# ---------------------------------------------------------------------------


def test_assign_ranks_ties_share_rank():
    rows = [
        svc.ScoreRow(1, "top_hosts", 10.0),
        svc.ScoreRow(2, "top_hosts", 10.0),
        svc.ScoreRow(3, "top_hosts", 5.0),
        svc.ScoreRow(4, "top_hosts", 1.0),
    ]
    svc.assign_ranks(rows)
    ranks = {r.fid: r.rank for r in rows}
    assert ranks == {1: 1, 2: 1, 3: 3, 4: 4}


# ---------------------------------------------------------------------------
# Persistence / recompute
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_recompute_delete_then_insert(db):
    await _add_user(db, 1)
    await _add_user(db, 10)
    room = await _add_room(db, 1)
    await _join(db, room.id, 10)
    await db.commit()

    factory = async_sessionmaker(db.bind, class_=AsyncSession, expire_on_commit=False)
    n = await svc.recompute_cycle(factory, None, cycle=CYCLE, fetcher=FakeFetcher())
    assert n >= 1
    stored = (
        (
            await db.execute(
                select(LeaderboardScore).where(LeaderboardScore.cycle == CYCLE)
            )
        )
        .scalars()
        .all()
    )
    assert any(s.category == "top_hosts" and s.fid == 1 for s in stored)
    # Re-running must not duplicate rows.
    await svc.recompute_cycle(factory, None, cycle=CYCLE, fetcher=FakeFetcher())
    stored2 = (
        (
            await db.execute(
                select(LeaderboardScore).where(LeaderboardScore.cycle == CYCLE)
            )
        )
        .scalars()
        .all()
    )
    assert len(stored2) == len(stored)


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


@pytest.fixture
async def api(client, db):
    async def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    try:
        yield client
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_public_leaderboard_shape_and_categories(api, db):
    await _add_user(db, 1)
    db.add(
        LeaderboardScore(
            fid=1,
            cycle=CYCLE,
            category="top_hosts",
            score=5.0,
            rank=1,
            breakdown={},
            computed_at=IN_CYCLE,
        )
    )
    await db.commit()

    resp = await api.get(f"/v1/leaderboard?cycle={CYCLE}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["cycle"] == CYCLE
    assert body["status"] == "provisional"
    assert [c["key"] for c in body["categories"]] == [
        "top_hosts",
        "top_voices",
        "top_casters",
        "community",
    ]
    hosts = next(c for c in body["categories"] if c["key"] == "top_hosts")
    assert hosts["entries"][0]["fid"] == 1
    assert hosts["entries"][0]["username"] == "user1"
    assert hosts["entries"][0]["rank"] == 1
    # No sensitive fields leak.
    assert "signer_uuid" not in hosts["entries"][0]


@pytest.mark.asyncio
async def test_public_status_final_when_awards_exist(api, db):
    await _add_user(db, 1)
    db.add(
        LeaderboardAward(
            fid=1, cycle=CYCLE, category="top_hosts", rank=1, label="Top Host"
        )
    )
    await db.commit()
    resp = await api.get(f"/v1/leaderboard?cycle={CYCLE}")
    assert resp.json()["status"] == "final"


@pytest.mark.asyncio
async def test_public_excludes_agent_and_optout(api, db):
    await _add_user(db, 1, is_agent=True)
    await _add_user(db, 2, opt_out=True)
    await _add_user(db, 3)
    for fid in (1, 2, 3):
        db.add(
            LeaderboardScore(
                fid=fid,
                cycle=CYCLE,
                category="top_hosts",
                score=5.0,
                rank=1,
                breakdown={},
                computed_at=IN_CYCLE,
            )
        )
    await db.commit()
    resp = await api.get(f"/v1/leaderboard?cycle={CYCLE}")
    hosts = next(c for c in resp.json()["categories"] if c["key"] == "top_hosts")
    assert [e["fid"] for e in hosts["entries"]] == [3]


@pytest.mark.asyncio
async def test_cycle_validation_422(api):
    resp = await api.get("/v1/leaderboard?cycle=not-a-cycle")
    assert resp.status_code == 422
    resp2 = await api.get("/v1/leaderboard?cycle=2026-13")
    assert resp2.status_code == 422


@pytest.mark.asyncio
async def test_public_includes_scored_fid_without_user_row(api, db):
    """cast_records fids carry no FK to users; a scored creator without a
    local user row must still appear (with null display fields) instead of
    silently burning a rank slot."""
    db.add(
        LeaderboardScore(
            fid=42,
            cycle=CYCLE,
            category="top_casters",
            score=2.0,
            rank=1,
            breakdown={},
            computed_at=IN_CYCLE,
        )
    )
    await db.commit()
    resp = await api.get(f"/v1/leaderboard?cycle={CYCLE}")
    casters = next(c for c in resp.json()["categories"] if c["key"] == "top_casters")
    assert casters["entries"][0]["fid"] == 42
    assert casters["entries"][0]["username"] is None


@pytest.mark.asyncio
async def test_cycle_out_of_window_422(api):
    """Cycles outside [MIN_CYCLE, current month] are rejected so the
    unauthenticated cached endpoint can't be cache-bypassed by iterating
    the ~120k syntactically valid YYYY-MM strings."""
    resp_future = await api.get("/v1/leaderboard?cycle=2031-01")
    assert resp_future.status_code == 422
    resp_prelaunch = await api.get("/v1/leaderboard?cycle=2020-05")
    assert resp_prelaunch.status_code == 422


@pytest.mark.asyncio
async def test_public_cache_hit_skips_db(api, db):
    """A cached payload is returned verbatim without touching stored scores."""
    cached = (
        '{"cycle":"%s","status":"final","computed_at":null,"categories":[]}' % CYCLE
    )
    app.state.redis.get.return_value = cached
    resp = await api.get(f"/v1/leaderboard?cycle={CYCLE}")
    app.state.redis.get.return_value = None  # reset for other tests
    assert resp.status_code == 200
    assert resp.json()["status"] == "final"
    assert resp.json()["categories"] == []


@pytest.mark.asyncio
async def test_me_standing_and_missing_category(api, db):
    await _add_user(db, 7)
    db.add(
        LeaderboardScore(
            fid=7,
            cycle=CYCLE,
            category="top_voices",
            score=3.2,
            rank=4,
            breakdown={},
            computed_at=IN_CYCLE,
        )
    )
    await db.commit()
    resp = await api.get(f"/v1/leaderboard/me?cycle={CYCLE}", headers=auth_header(7))
    assert resp.status_code == 200
    body = resp.json()
    assert body["opt_out"] is False
    cats = {c["key"]: c for c in body["categories"]}
    assert cats["top_voices"]["rank"] == 4
    assert math.isclose(cats["top_voices"]["score"], 3.2)
    # A category with no row reports null rank / 0 score.
    assert cats["top_hosts"]["rank"] is None
    assert cats["top_hosts"]["score"] == 0.0


@pytest.mark.asyncio
async def test_opt_out_roundtrip(api, db):
    await _add_user(db, 8)
    await db.commit()
    resp = await api.put(
        "/v1/leaderboard/opt-out", json={"opt_out": True}, headers=auth_header(8)
    )
    assert resp.status_code == 200
    assert resp.json() == {"opt_out": True}
    user = (await db.execute(select(User).where(User.fid == 8))).scalar_one()
    assert user.leaderboard_opt_out is True
    # Reflected in /me.
    me = await api.get("/v1/leaderboard/me", headers=auth_header(8))
    assert me.json()["opt_out"] is True


@pytest.mark.asyncio
async def test_awards_endpoint(api, db):
    await _add_user(db, 5)
    db.add(
        LeaderboardAward(
            fid=5, cycle="2026-06", category="top_hosts", rank=1, label="Top Host"
        )
    )
    await db.commit()
    resp = await api.get("/v1/leaderboard/awards/5")
    assert resp.status_code == 200
    body = resp.json()
    assert body["fid"] == 5
    assert body["awards"][0] == {
        "cycle": "2026-06",
        "category": "top_hosts",
        "label": "Top Host",
        "rank": 1,
    }


@pytest.mark.asyncio
async def test_awards_empty_for_unknown_fid(api, db):
    resp = await api.get("/v1/leaderboard/awards/9999")
    assert resp.status_code == 200
    assert resp.json() == {"fid": 9999, "awards": []}


@pytest.mark.asyncio
async def test_awards_hidden_when_opted_out(api, db):
    """Opt-out is retroactive for the public awards endpoint."""
    await _add_user(db, 6, opt_out=True)
    db.add(
        LeaderboardAward(
            fid=6, cycle="2026-06", category="top_hosts", rank=1, label="Top Host"
        )
    )
    await db.commit()
    resp = await api.get("/v1/leaderboard/awards/6")
    assert resp.status_code == 200
    assert resp.json() == {"fid": 6, "awards": []}


@pytest.mark.asyncio
async def test_opt_out_rejects_partner_jwt(api, db):
    """Partner-minted JWTs must not toggle a user's privacy preference."""
    await _add_user(db, 9)
    await db.commit()
    token = jwt.encode(
        {"fid": 9, "exp": 4_102_444_800, "source": "partner"},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    resp = await api.put(
        "/v1/leaderboard/opt-out",
        json={"opt_out": True},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 401
    user = (await db.execute(select(User).where(User.fid == 9))).scalar_one()
    assert user.leaderboard_opt_out is False
