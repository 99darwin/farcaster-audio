"""Focused API, durability, retry, and ownership tests for scheduled casts."""

from datetime import datetime, timedelta, timezone
import pytest
from jose import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.clients import hypersnap
from app.clients.proto import message_pb2
from app.config import settings
from app.database import Base
from app.dependencies import get_db
from app.main import app
from app.models.scheduled_cast import ScheduledCast
from app.models.user import User
from app.services.scheduled_cast_publisher import ScheduledCastPublisher
from app.services.scheduled_cast_publisher import (
    CLAIM_LEASE_SAFETY_SECONDS,
    MAX_PUBLISH_ATTEMPTS,
    PUBLISH_ATTEMPT_TIMEOUT_SECONDS,
)
from tests.hypersnap_write_fakes import install_write_fakes, submit_error

pytest.importorskip("aiosqlite")

FID = 12345
OTHER_FID = 54321
SIGNER = "12345678-1234-4234-9234-123456789abc"


def auth_header(fid: int = FID) -> dict[str, str]:
    token = jwt.encode(
        {"fid": fid, "exp": 4_102_444_800, "source": "first_party"},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
async def scheduled_db():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(
            Base.metadata.create_all,
            tables=[User.__table__, ScheduledCast.__table__],
        )
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as db:
        db.add_all(
            [
                User(id=1, fid=FID, signer_uuid=SIGNER),
                User(
                    id=2,
                    fid=OTHER_FID,
                    signer_uuid="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                ),
            ]
        )
        await db.commit()
        yield db, factory
    await engine.dispose()


@pytest.fixture
async def scheduled_client(client, scheduled_db):
    db, _factory = scheduled_db

    async def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    try:
        yield client
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_schedule_cast_persists_all_supported_fields_without_signer(
    scheduled_client, scheduled_db, monkeypatch
):
    install_write_fakes(monkeypatch)
    scheduled_for = datetime.now(timezone.utc) + timedelta(hours=2)
    response = await scheduled_client.post(
        "/v1/feed/scheduled-casts",
        headers=auth_header(),
        json={
            "text": "listen later",
            "embeds": ["https://example.com/audio.mp3"],
            "quote": {"fid": 7, "hash": "0x" + "a" * 40},
            "channel_id": "music",
            "scheduled_for": scheduled_for.isoformat(),
        },
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload["status"] == "pending"
    assert payload["attempts"] == 0
    assert payload["quote"] == {"fid": 7, "hash": "0x" + "a" * 40}
    assert "signer" not in response.text.lower()
    db, _factory = scheduled_db
    row = (await db.execute(select(ScheduledCast))).scalar_one()
    assert row.fid == FID
    assert row.embeds == ["https://example.com/audio.mp3"]
    assert not hasattr(row, "signer_uuid")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("offset", "detail"),
    [
        (timedelta(seconds=5), "at least 30 seconds"),
        (timedelta(days=366), "more than 365 days"),
    ],
)
async def test_schedule_cast_enforces_documented_time_window(
    scheduled_client, offset, detail
):
    response = await scheduled_client.post(
        "/v1/feed/scheduled-casts",
        headers=auth_header(),
        json={
            "text": "timing",
            "scheduled_for": (datetime.now(timezone.utc) + offset).isoformat(),
        },
    )
    assert response.status_code == 400
    assert detail in response.json()["detail"]


@pytest.mark.asyncio
async def test_schedule_cast_reuses_reply_channel_validation(scheduled_client):
    response = await scheduled_client.post(
        "/v1/feed/scheduled-casts",
        headers=auth_header(),
        json={
            "text": "invalid",
            "parent": "0x" + "b" * 40,
            "channel_id": "music",
            "scheduled_for": (
                datetime.now(timezone.utc) + timedelta(hours=1)
            ).isoformat(),
        },
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "Replies cannot target a channel"


@pytest.mark.asyncio
async def test_schedule_cast_enforces_neynar_total_embed_limit(scheduled_client):
    response = await scheduled_client.post(
        "/v1/feed/scheduled-casts",
        headers=auth_header(),
        json={
            "text": "too many embeds",
            "embeds": [
                "https://example.com/one.png",
                "https://example.com/two.png",
            ],
            "quote": {"fid": 7, "hash": "0x" + "c" * 40},
            "scheduled_for": (
                datetime.now(timezone.utc) + timedelta(hours=1)
            ).isoformat(),
        },
    )
    assert response.status_code == 400
    assert "at most 2 embeds" in response.json()["detail"]


@pytest.mark.asyncio
async def test_list_and_cancel_are_owner_scoped(scheduled_client, scheduled_db):
    db, _factory = scheduled_db
    when = datetime.now(timezone.utc) + timedelta(hours=1)
    own = ScheduledCast(fid=FID, text="mine", scheduled_for=when, next_attempt_at=when)
    other = ScheduledCast(
        fid=OTHER_FID, text="theirs", scheduled_for=when, next_attempt_at=when
    )
    db.add_all([own, other])
    await db.commit()

    listed = await scheduled_client.get(
        "/v1/feed/scheduled-casts", headers=auth_header()
    )
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()["scheduled_casts"]] == [str(own.id)]
    assert "signer" not in listed.text.lower()

    forbidden = await scheduled_client.delete(
        f"/v1/feed/scheduled-casts/{other.id}", headers=auth_header()
    )
    assert forbidden.status_code == 404

    cancelled = await scheduled_client.delete(
        f"/v1/feed/scheduled-casts/{own.id}", headers=auth_header()
    )
    assert cancelled.status_code == 200
    await db.refresh(own)
    await db.refresh(other)
    assert own.status == "cancelled"
    assert other.status == "pending"

    history = await scheduled_client.get(
        "/v1/feed/scheduled-casts?include_history=true", headers=auth_header()
    )
    assert history.status_code == 200
    assert history.json()["scheduled_casts"][0]["status"] == "cancelled"
    assert history.json()["scheduled_casts"][0]["attempts"] == 0


@pytest.mark.asyncio
async def test_claimed_job_cannot_be_cancelled(scheduled_client, scheduled_db):
    db, _factory = scheduled_db
    when = datetime.now(timezone.utc) + timedelta(hours=1)
    job = ScheduledCast(
        fid=FID,
        text="claimed",
        scheduled_for=when,
        next_attempt_at=when,
        status="processing",
        attempts=1,
        lease_expires_at=datetime.now(timezone.utc) + timedelta(seconds=60),
    )
    db.add(job)
    await db.commit()

    response = await scheduled_client.delete(
        f"/v1/feed/scheduled-casts/{job.id}", headers=auth_header()
    )
    assert response.status_code == 409
    await db.refresh(job)
    assert job.status == "processing"


async def _due_job(db: AsyncSession, **overrides) -> ScheduledCast:
    now = datetime.now(timezone.utc)
    values = {
        "fid": FID,
        "text": "publish me",
        "scheduled_for": now - timedelta(minutes=1),
        "next_attempt_at": now - timedelta(minutes=1),
    }
    values.update(overrides)
    job = ScheduledCast(**values)
    db.add(job)
    await db.commit()
    return job


@pytest.fixture
def fakes(monkeypatch):
    return install_write_fakes(monkeypatch)


@pytest.mark.asyncio
async def test_publisher_signs_with_user_signer_and_publishes_once(scheduled_db, fakes):
    db, factory = scheduled_db
    job = await _due_job(db)
    publisher = ScheduledCastPublisher(factory)

    counts = await publisher.process_once()
    second_counts = await publisher.process_once()

    assert counts == {"claimed": 1, "published": 1, "retried": 0, "failed": 0}
    assert second_counts["claimed"] == 0
    assert fakes.node.attempts == 1
    data = fakes.node.bodies[0]
    assert data.fid == FID
    assert data.cast_add_body.text == "publish me"
    await db.refresh(job)
    assert job.status == "published"
    assert job.attempts == 1
    assert job.published_hash == fakes.node.hashes[0]


@pytest.mark.asyncio
async def test_message_timestamp_is_pinned_to_scheduled_for(scheduled_db, fakes):
    from app.clients.farcaster_messages import farcaster_timestamp

    db, factory = scheduled_db
    job = await _due_job(db)
    await ScheduledCastPublisher(factory).process_once()

    assert fakes.node.bodies[0].timestamp == farcaster_timestamp(job.scheduled_for)


def test_claim_lease_covers_every_bounded_attempt_in_sequential_batch():
    batch_size = 10
    publisher = ScheduledCastPublisher(
        None,  # type: ignore[arg-type] - no DB access for constructor invariant
        batch_size=batch_size,
        lease_seconds=1,
    )
    assert publisher._lease_seconds >= (  # noqa: SLF001
        batch_size * PUBLISH_ATTEMPT_TIMEOUT_SECONDS + CLAIM_LEASE_SAFETY_SECONDS
    )


@pytest.mark.asyncio
async def test_transient_retry_resubmits_same_message_and_sanitizes_error(
    scheduled_db, fakes
):
    db, factory = scheduled_db
    job = await _due_job(db)
    fakes.node.errors = [
        submit_error(503, err_code="unavailable", node_message="provider secret")
    ]
    publisher = ScheduledCastPublisher(factory)

    first = await publisher.process_once()
    await db.refresh(job)
    assert job.status == "retrying"
    assert job.last_error == "Upstream temporarily unavailable"
    assert "secret" not in job.last_error
    job.next_attempt_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    await db.commit()
    second = await publisher.process_once()

    assert first["retried"] == 1
    assert second["published"] == 1
    # Same scheduled_for timestamp → byte-identical message → same hash.
    assert fakes.node.attempted_bytes[0] == fakes.node.attempted_bytes[1]
    await db.refresh(job)
    assert job.status == "published"
    assert job.attempts == 2


@pytest.mark.asyncio
async def test_retry_after_ambiguous_success_is_duplicate_not_recast(
    scheduled_db, fakes
):
    db, factory = scheduled_db
    job = await _due_job(db)
    # The first submit landed but the response was lost; the retry is a dup.
    fakes.node.errors = [
        submit_error(None),
        submit_error(400, err_code="bad_request.duplicate"),
    ]
    publisher = ScheduledCastPublisher(factory)
    await publisher.process_once()
    await db.refresh(job)
    job.next_attempt_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    await db.commit()
    counts = await publisher.process_once()

    assert counts["published"] == 1
    await db.refresh(job)
    assert job.status == "published"
    assert job.published_hash.startswith("0x")
    assert len(job.published_hash) == 42


@pytest.mark.asyncio
async def test_mention_lookup_outage_fails_attempt_instead_of_changing_message(
    scheduled_db, fakes, monkeypatch
):
    """A flaky username lookup must not degrade @alice to text on a retry.

    Attempt 1 resolves @alice and its submit is ambiguous (landed, response
    lost). Attempt 2 cannot reach /user/by-username: it must retry without
    submitting a different message. Attempt 3 rebuilds the identical bytes,
    which the node reports as a duplicate.
    """
    db, factory = scheduled_db
    fakes.reads.usernames["alice"] = 4242
    job = await _due_job(db, text="hi @alice")
    fakes.node.errors = [
        submit_error(None),
        submit_error(400, err_code="bad_request.duplicate"),
    ]
    publisher = ScheduledCastPublisher(factory)

    async def make_due() -> None:
        await db.refresh(job)
        job.next_attempt_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await db.commit()

    await publisher.process_once()
    await make_due()

    healthy_get = fakes.reads

    async def username_outage(path, params=None, **kwargs):
        if path == "/user/by-username":
            raise hypersnap.HypersnapUpstreamError("down", path=path, status_code=503)
        return await healthy_get(path, params, **kwargs)

    monkeypatch.setattr("app.clients.hypersnap.get", username_outage)
    outage = await publisher.process_once()
    await db.refresh(job)
    assert outage["retried"] == 1
    assert job.status == "retrying"
    assert fakes.node.attempts == 1

    monkeypatch.setattr("app.clients.hypersnap.get", healthy_get)
    await make_due()
    recovered = await publisher.process_once()

    assert recovered["published"] == 1
    assert fakes.node.attempts == 2
    assert fakes.node.attempted_bytes[0] == fakes.node.attempted_bytes[1]
    await db.refresh(job)
    assert job.status == "published"
    sent = message_pb2.Message.FromString(fakes.node.attempted_bytes[0])
    assert list(sent.data.cast_add_body.mentions) == [4242]


@pytest.mark.asyncio
async def test_stale_processing_lease_is_recovered(scheduled_db, fakes):
    db, factory = scheduled_db
    past = datetime.now(timezone.utc) - timedelta(minutes=1)
    job = await _due_job(
        db,
        status="processing",
        attempts=MAX_PUBLISH_ATTEMPTS,
        lease_expires_at=past,
    )
    publisher = ScheduledCastPublisher(factory)
    counts = await publisher.process_once()

    assert counts["published"] == 1
    await db.refresh(job)
    assert job.status == "published"
    # Lease recovery retries one ambiguous idempotent request, rather than
    # consuming a new logical transient-failure attempt.
    assert job.attempts == MAX_PUBLISH_ATTEMPTS


@pytest.mark.asyncio
async def test_permanent_upstream_failure_is_not_retried(scheduled_db, fakes):
    db, factory = scheduled_db
    job = await _due_job(db)
    fakes.node.errors = [
        submit_error(400, err_code="bad_request", node_message="private detail")
    ]
    publisher = ScheduledCastPublisher(factory)
    counts = await publisher.process_once()

    assert counts["failed"] == 1
    await db.refresh(job)
    assert job.status == "failed"
    assert job.last_error == "Upstream rejected the scheduled cast"


@pytest.mark.asyncio
async def test_unlinked_signer_fails_job_without_retry(scheduled_db, monkeypatch):
    fakes = install_write_fakes(monkeypatch, linked_fids=set())
    db, factory = scheduled_db
    job = await _due_job(db)
    counts = await ScheduledCastPublisher(factory).process_once()

    assert counts["failed"] == 1
    assert fakes.node.attempts == 0
    await db.refresh(job)
    assert job.status == "failed"
    assert job.last_error == "No approved Farcaster signer is available"
