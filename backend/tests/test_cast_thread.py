"""Tests for POST /v1/feed/cast/thread — sequential thread publishing."""

from unittest.mock import AsyncMock, patch

import pytest
from jose import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import Base
from app.dependencies import get_db
from app.main import app
from app.models.cast_record import CastRecord
from app.models.user import User
from app.services.farcaster_writes import Signer
from tests.hypersnap_write_fakes import (
    CHANNEL_PARENT_URLS,
    FakeReads,
    install_write_fakes,
    submit_error,
)

pytest.importorskip("aiosqlite")

FID = 12345
SIGNER = "12345678-1234-4234-9234-123456789abc"
PARENT_HASH = "0x" + "f" * 40
PARENT_AUTHOR_FID = 77
QUOTE_HASH = "0x" + "e" * 40


def auth_header(fid: int = FID) -> dict[str, str]:
    token = jwt.encode(
        {"fid": fid, "exp": 4_102_444_800, "source": "first_party"},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


def _make_engine():
    return create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )


@pytest.fixture
async def thread_db():
    engine = _make_engine()
    async with engine.begin() as conn:
        await conn.run_sync(
            Base.metadata.create_all,
            tables=[User.__table__, CastRecord.__table__],
        )
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as db:
        db.add(User(id=1, fid=FID, signer_uuid=SIGNER))
        await db.commit()
        yield db
    await engine.dispose()


@pytest.fixture
async def thread_client(client, thread_db):
    async def override_db():
        yield thread_db

    app.dependency_overrides[get_db] = override_db
    try:
        yield client
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def fakes(monkeypatch):
    reads = FakeReads(cast_authors={PARENT_HASH: PARENT_AUTHOR_FID})
    return install_write_fakes(monkeypatch, reads=reads)


def _patched_sleep():
    return patch("app.services.cast_thread.asyncio.sleep", new=AsyncMock())


async def _ledger_hashes(db: AsyncSession) -> list[str]:
    rows = (await db.execute(select(CastRecord))).scalars().all()
    return [row.cast_hash for row in rows]


@pytest.mark.asyncio
async def test_full_thread_publishes_in_order(thread_client, thread_db, fakes):
    response = await thread_client.post(
        "/v1/feed/cast/thread",
        json={
            "casts": [
                {"text": "part 1", "quote": {"fid": 99, "hash": QUOTE_HASH}},
                {"text": "part 2", "embeds": ["https://example.com/a"]},
                {"text": "part 3"},
            ],
            "channel_id": "music",
        },
        headers=auth_header(),
    )

    assert response.status_code == 201
    hashes = fakes.node.hashes
    assert len(hashes) == 3
    assert response.json() == {
        "success": True,
        "casts": [{"index": i, "hash": h} for i, h in enumerate(hashes)],
        "failed_index": None,
        "error": None,
    }

    bodies = [data.cast_add_body for data in fakes.node.bodies]
    assert all(data.fid == FID for data in fakes.node.bodies)
    # Root: no parent cast, channel applied as parent_url, quote embedded.
    assert not bodies[0].HasField("parent_cast_id")
    assert bodies[0].parent_url == CHANNEL_PARENT_URLS["music"]
    assert bodies[0].embeds[0].cast_id.fid == 99
    assert bodies[0].embeds[0].cast_id.hash == bytes.fromhex("e" * 40)
    # Each child chains off the previous segment's message hash.
    for index in (1, 2):
        parent = bodies[index].parent_cast_id
        assert parent.fid == FID
        assert "0x" + parent.hash.hex() == hashes[index - 1]
        # Channel applies to the root only.
        assert bodies[index].parent_url == ""
    assert bodies[1].embeds[0].url == "https://example.com/a"

    assert await _ledger_hashes(thread_db) == hashes


@pytest.mark.asyncio
async def test_thread_with_parent_chains_under_existing_cast(
    thread_client, thread_db, fakes
):
    response = await thread_client.post(
        "/v1/feed/cast/thread",
        json={
            "casts": [{"text": "reply 1"}, {"text": "reply 2"}],
            "parent": PARENT_HASH,
        },
        headers=auth_header(),
    )

    assert response.status_code == 201
    bodies = [data.cast_add_body for data in fakes.node.bodies]
    assert bodies[0].parent_cast_id.fid == PARENT_AUTHOR_FID
    assert bodies[0].parent_cast_id.hash == bytes.fromhex("f" * 40)
    assert "0x" + bodies[1].parent_cast_id.hash.hex() == fakes.node.hashes[0]


@pytest.mark.asyncio
async def test_unknown_parent_returns_404_and_publishes_nothing(
    thread_client, thread_db, fakes
):
    response = await thread_client.post(
        "/v1/feed/cast/thread",
        json={"casts": [{"text": "a"}, {"text": "b"}], "parent": "0x" + "1" * 40},
        headers=auth_header(),
    )

    assert response.status_code == 404
    assert fakes.node.attempts == 0


@pytest.mark.asyncio
async def test_mid_chain_permanent_failure_returns_207_with_prefix(
    thread_client, thread_db, fakes
):
    fakes.node.errors = [None, submit_error(400, err_code="bad_request")]
    response = await thread_client.post(
        "/v1/feed/cast/thread",
        json={"casts": [{"text": "a"}, {"text": "b"}, {"text": "c"}]},
        headers=auth_header(),
    )

    assert response.status_code == 207
    body = response.json()
    assert body["success"] is False
    assert body["casts"] == [{"index": 0, "hash": fakes.node.hashes[0]}]
    assert body["failed_index"] == 1
    assert body["error"] == "Upstream rejected the cast"
    # Permanent failure: no retry, and the chain stops (segment 2 never sent).
    assert fakes.node.attempts == 2
    # Only the published prefix lands in the ledger.
    assert await _ledger_hashes(thread_db) == fakes.node.hashes


@pytest.mark.asyncio
async def test_root_failure_returns_502_and_publishes_nothing(
    thread_client, thread_db, fakes
):
    fakes.node.errors = [submit_error(400, err_code="bad_request")]
    response = await thread_client.post(
        "/v1/feed/cast/thread",
        json={"casts": [{"text": "a"}, {"text": "b"}]},
        headers=auth_header(),
    )

    assert response.status_code == 502
    assert fakes.node.attempts == 1
    assert await _ledger_hashes(thread_db) == []


@pytest.mark.asyncio
async def test_root_signer_rejection_returns_403(thread_client, thread_db, fakes):
    fakes.node.errors = [
        submit_error(
            400,
            err_code="bad_request.validation_failure",
            node_message="invalid signer",
        )
    ]
    response = await thread_client.post(
        "/v1/feed/cast/thread",
        json={"casts": [{"text": "a"}, {"text": "b"}]},
        headers=auth_header(),
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "signer_not_linked"
    assert await _ledger_hashes(thread_db) == []


@pytest.mark.asyncio
async def test_unlinked_signer_returns_403_before_publishing(
    thread_client, thread_db, monkeypatch
):
    fakes = install_write_fakes(monkeypatch, linked_fids=set())
    response = await thread_client.post(
        "/v1/feed/cast/thread",
        json={"casts": [{"text": "a"}, {"text": "b"}]},
        headers=auth_header(),
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "signer_not_linked"
    assert fakes.node.attempts == 0


@pytest.mark.asyncio
async def test_transient_429_resubmits_identical_message(
    thread_client, thread_db, fakes
):
    fakes.node.errors = [None, submit_error(429)]
    with _patched_sleep() as sleep_mock:
        response = await thread_client.post(
            "/v1/feed/cast/thread",
            json={"casts": [{"text": "a"}, {"text": "b"}]},
            headers=auth_header(),
        )

    assert response.status_code == 201
    assert fakes.node.attempts == 3
    # The retry resubmits the exact same signed bytes (same hash), so a
    # submit that actually landed is reported as a duplicate, not re-cast.
    attempted = fakes.node.attempted_bytes
    assert attempted[1] == attempted[2]
    assert attempted[0] != attempted[1]
    sleep_mock.assert_awaited_once_with(0.5)
    assert await _ledger_hashes(thread_db) == fakes.node.hashes


@pytest.mark.asyncio
async def test_duplicate_on_retry_counts_as_published(thread_client, thread_db, fakes):
    fakes.node.errors = [
        submit_error(None),
        submit_error(400, err_code="bad_request.duplicate"),
        None,
    ]
    with _patched_sleep():
        response = await thread_client.post(
            "/v1/feed/cast/thread",
            json={"casts": [{"text": "a"}, {"text": "b"}]},
            headers=auth_header(),
        )

    assert response.status_code == 201
    hashes = [entry["hash"] for entry in response.json()["casts"]]
    assert len(hashes) == 2
    assert await _ledger_hashes(thread_db) == hashes


@pytest.mark.asyncio
async def test_transient_retries_exhaust_then_207(thread_client, thread_db, fakes):
    fakes.node.errors = [None, submit_error(503), submit_error(503), submit_error(503)]
    with _patched_sleep() as sleep_mock:
        response = await thread_client.post(
            "/v1/feed/cast/thread",
            json={"casts": [{"text": "a"}, {"text": "b"}]},
            headers=auth_header(),
        )

    assert response.status_code == 207
    body = response.json()
    assert body["failed_index"] == 1
    assert body["casts"] == [{"index": 0, "hash": fakes.node.hashes[0]}]
    assert body["error"] == "Upstream temporarily unavailable"
    # 1 root attempt + 3 attempts (initial + 2 retries) for segment 1.
    assert fakes.node.attempts == 4
    assert [c.args for c in sleep_mock.await_args_list] == [(0.5,), (1.0,)]
    assert await _ledger_hashes(thread_db) == fakes.node.hashes


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        # Fewer than 2 segments.
        {"casts": [{"text": "solo"}]},
        # More than 10 segments.
        {"casts": [{"text": f"part {i}"} for i in range(11)]},
        # Quote on a non-first segment.
        {
            "casts": [
                {"text": "a"},
                {"text": "b", "quote": {"fid": 1, "hash": PARENT_HASH}},
            ]
        },
        # parent and channel_id are mutually exclusive.
        {
            "casts": [{"text": "a"}, {"text": "b"}],
            "parent": PARENT_HASH,
            "channel_id": "music",
        },
        # A segment with no content at all.
        {"casts": [{"text": "a"}, {"text": "   "}]},
        # More than 4 URL embeds in one segment (schema cap).
        {
            "casts": [
                {"text": "a"},
                {
                    "text": "b",
                    "embeds": [f"https://example.com/{i}" for i in range(5)],
                },
            ]
        },
        # parent must be exactly a 20-byte (40 hex char) cast hash.
        {"casts": [{"text": "a"}, {"text": "b"}], "parent": "0x" + "f" * 39},
    ],
)
async def test_validation_errors_return_422(thread_client, fakes, body):
    response = await thread_client.post(
        "/v1/feed/cast/thread",
        json=body,
        headers=auth_header(),
    )

    assert response.status_code == 422
    assert fakes.node.attempts == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "segment",
    [
        # Protocol cap: 2 embeds including a quote (Pro 4-embed casts are
        # not supported on the Hypersnap write path).
        {
            "text": "b",
            "embeds": ["https://example.com/1", "https://example.com/2"],
            "quote": {"fid": 99, "hash": QUOTE_HASH},
        },
        {"text": "b", "embeds": [f"https://example.com/{i}" for i in range(3)]},
        # Embed URL over 256 bytes.
        {"text": "b", "embeds": ["https://example.com/" + "a" * 250]},
        # Text over 1024 bytes.
        {"text": "é" * 513},
    ],
)
async def test_protocol_limits_reject_whole_thread_before_publishing(
    thread_client, thread_db, fakes, segment
):
    response = await thread_client.post(
        "/v1/feed/cast/thread",
        json={"casts": [segment, {"text": "c"}]},
        headers=auth_header(),
    )

    assert response.status_code == 400
    assert fakes.node.attempts == 0
    assert await _ledger_hashes(thread_db) == []


@pytest.mark.asyncio
async def test_invalid_later_segment_publishes_nothing(thread_client, thread_db, fakes):
    response = await thread_client.post(
        "/v1/feed/cast/thread",
        json={
            "casts": [
                {"text": "fine"},
                {"text": "b", "embeds": [f"https://example.com/{i}" for i in range(3)]},
            ]
        },
        headers=auth_header(),
    )

    assert response.status_code == 400
    assert fakes.node.attempts == 0


@pytest.mark.asyncio
async def test_unknown_channel_returns_400(thread_client, thread_db, fakes):
    response = await thread_client.post(
        "/v1/feed/cast/thread",
        json={"casts": [{"text": "a"}, {"text": "b"}], "channel_id": "nope"},
        headers=auth_header(),
    )

    assert response.status_code == 400
    assert fakes.node.attempts == 0


@pytest.mark.asyncio
async def test_embeds_only_segment_is_accepted(thread_client, thread_db, fakes):
    response = await thread_client.post(
        "/v1/feed/cast/thread",
        json={
            "casts": [
                {"text": "a"},
                {"text": "   ", "embeds": ["https://example.com/pic.png"]},
            ]
        },
        headers=auth_header(),
    )

    assert response.status_code == 201
    second = fakes.node.bodies[1].cast_add_body
    assert [embed.url for embed in second.embeds] == ["https://example.com/pic.png"]


@pytest.mark.asyncio
async def test_thread_mentions_share_one_lookup_budget(thread_client, thread_db, fakes):
    fakes.reads.usernames = {"alice": 501}
    response = await thread_client.post(
        "/v1/feed/cast/thread",
        json={"casts": [{"text": "hi @alice"}, {"text": "and @alice again"}]},
        headers=auth_header(),
    )

    assert response.status_code == 201
    bodies = [data.cast_add_body for data in fakes.node.bodies]
    assert list(bodies[0].mentions) == [501]
    assert list(bodies[1].mentions) == [501]
    lookups = [call for call in fakes.reads.calls if call[0] == "/user/by-username"]
    assert len(lookups) == 1


@pytest.mark.asyncio
async def test_network_error_is_transient_and_retried(thread_client, thread_db, fakes):
    fakes.node.errors = [None, submit_error(None)]
    with _patched_sleep() as sleep_mock:
        response = await thread_client.post(
            "/v1/feed/cast/thread",
            json={"casts": [{"text": "a"}, {"text": "b"}]},
            headers=auth_header(),
        )

    assert response.status_code == 201
    assert fakes.node.attempts == 3
    sleep_mock.assert_awaited_once_with(0.5)
    assert await _ledger_hashes(thread_db) == fakes.node.hashes


@pytest.mark.asyncio
async def test_thread_requires_auth(thread_client):
    response = await thread_client.post(
        "/v1/feed/cast/thread",
        json={"casts": [{"text": "a"}, {"text": "b"}]},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_thread_rate_limit_returns_429(thread_client, thread_db, fakes):
    from app.routers.feed import THREAD_RATE_LIMIT_PER_MIN

    # The conftest redis mock's pipeline reports the counter value; simulate a
    # caller who already exhausted this minute's window.
    app.state.redis.pipeline.return_value.execute = AsyncMock(
        return_value=[THREAD_RATE_LIMIT_PER_MIN + 1, True]
    )
    response = await thread_client.post(
        "/v1/feed/cast/thread",
        json={"casts": [{"text": "a"}, {"text": "b"}]},
        headers=auth_header(),
    )

    assert response.status_code == 429
    assert response.headers["Retry-After"] == "60"
    assert fakes.node.attempts == 0
    assert await _ledger_hashes(thread_db) == []


def _test_signer() -> Signer:
    return Signer(fid=FID, private_key=b"\x01" * 32)


@pytest.mark.asyncio
async def test_publish_thread_budget_exhausted_before_root(thread_db, fakes):
    from app.services.cast_thread import (
        BUDGET_EXHAUSTED_MESSAGE,
        ThreadSegmentInput,
        publish_thread,
    )

    outcome = await publish_thread(
        thread_db,
        signer=_test_signer(),
        segments=[ThreadSegmentInput(text="a"), ThreadSegmentInput(text="b")],
        budget_seconds=0.0,
    )

    assert outcome.hashes == []
    assert outcome.failed_index == 0
    assert outcome.error == BUDGET_EXHAUSTED_MESSAGE
    assert fakes.node.attempts == 0
    assert await _ledger_hashes(thread_db) == []


@pytest.mark.asyncio
async def test_publish_thread_budget_stops_mid_chain(thread_db, fakes):
    from itertools import count

    from app.services.cast_thread import (
        BUDGET_EXHAUSTED_MESSAGE,
        ThreadSegmentInput,
        publish_thread,
    )

    # Each monotonic() call advances 100s: start=0 (deadline=150), segment 0
    # checks at t=100 and publishes, segment 1 checks at t=200 and is refused.
    clock = count(start=0, step=100)
    with patch(
        "app.services.cast_thread.time.monotonic", side_effect=lambda: next(clock)
    ):
        outcome = await publish_thread(
            thread_db,
            signer=_test_signer(),
            segments=[ThreadSegmentInput(text="a"), ThreadSegmentInput(text="b")],
            budget_seconds=150.0,
        )

    assert outcome.hashes == fakes.node.hashes
    assert len(outcome.hashes) == 1
    assert outcome.failed_index == 1
    assert outcome.error == BUDGET_EXHAUSTED_MESSAGE
    assert await _ledger_hashes(thread_db) == outcome.hashes
