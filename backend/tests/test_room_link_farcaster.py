"""Tests for ``POST /v1/rooms/link-farcaster`` and native-room guards.

Native rooms are spawned by sync-enabled users directly on
``client.farcaster.xyz`` — the Warpcast bearer never crosses the
wire. The Juke backend records a mapping (this endpoint) so discovery
and future cross-cutting features can reference the upstream room id.

The lifecycle endpoints (``/join``, ``/leave``, ``/recording/start``,
``/recording/stop``) are walled off for native rooms with explicit
4xx/5xx responses — defense-in-depth in case a buggy client forgets
to branch on ``is_farcaster_native`` in the response payload.
"""

from __future__ import annotations

import inspect
import uuid
from datetime import datetime, timezone

import pytest
from jose import jwt
from sqlalchemy.exc import IntegrityError

from app.config import settings
from app.dependencies import get_db
from app.main import app
from app.models.room import Room
from app.models.user import User
from app.schemas.farcaster_spaces import AudioRoom
from app.services.room_service import RoomService

TEST_FID = 8888
LINKED_FARCASTER_FID = TEST_FID
VALID_FCSP_UUID = "11111111-2222-3333-4444-555555555555"


# ---------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------


def _first_party_header(fid: int = TEST_FID) -> dict[str, str]:
    token = jwt.encode(
        {"fid": fid, "exp": 4_102_444_800},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


def _partner_header(fid: int = TEST_FID) -> dict[str, str]:
    token = jwt.encode(
        {"fid": fid, "exp": 4_102_444_800, "source": "partner"},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------
# In-memory DB fake — mirrors test_farcaster_sync.py
# ---------------------------------------------------------------------


def _make_user(
    fid: int = TEST_FID,
    *,
    sync_enabled: bool = True,
    farcaster_fid: int | None = LINKED_FARCASTER_FID,
) -> User:
    return User(
        fid=fid,
        signer_uuid="test-signer-" + str(fid),
        username="tester",
        display_name="Tester",
        pfp_url=None,
        custody_address=None,
        is_admin=False,
        is_agent=False,
        developer_access_status="none",
        farcaster_fid=farcaster_fid,
        farcaster_sync_enabled=sync_enabled,
        farcaster_sync_linked_at=(datetime.now(timezone.utc) if sync_enabled else None),
    )


class _FakeRow:
    """Mimic a SQLAlchemy ``Row`` for the ``select(User.col, User.col)`` path
    used by the router-side sync gate.
    """

    def __init__(self, **fields):
        self.__dict__.update(fields)


class _FakeResult:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value

    def first(self):
        return self._value


class _FakeAsyncSession:
    """Minimal ``AsyncSession`` stand-in.

    Holds one User row (keyed by JWT fid) and any Room rows added via
    ``add()``. ``execute`` answers the three queries the link endpoint
    + service issue:

      * ``select(User.farcaster_sync_enabled, User.farcaster_fid).where
        (User.fid == fid)`` — returns a ``_FakeRow`` with both
        attributes populated (or ``None`` when the user is missing).
      * ``select(User).where(User.fid == fid)`` — the service's
        ``_get_user`` helper. Returns the row directly.
      * ``select(Room).where(...)`` — idempotency check. Returns the
        configured ``_existing_room`` (defaults to ``None``).
    """

    def __init__(
        self,
        user: User | None,
        existing_room: Room | None = None,
    ):
        self._user = user
        self._existing_room = existing_room
        self.added_rooms: list[Room] = []
        self.commit_count = 0

    async def execute(self, stmt):
        # Inspect the SELECT to figure out which model it's hitting.
        # Cheaper than wiring a real selectable matcher and good enough
        # for these tests.
        compiled = str(stmt)

        if "FROM rooms" in compiled:
            return _FakeResult(self._existing_room)

        if "FROM users" in compiled:
            if self._user is None:
                return _FakeResult(None)
            # ``select(User)`` produces a SELECT of every users.* column
            # starting with ``users.id`` — that's the service path.
            # The endpoint-side gate selects only two columns and
            # never names ``users.id``.
            if "users.id" in compiled:
                return _FakeResult(self._user)
            return _FakeResult(
                _FakeRow(
                    farcaster_sync_enabled=self._user.farcaster_sync_enabled,
                    farcaster_fid=self._user.farcaster_fid,
                )
            )

        return _FakeResult(None)

    def add(self, obj):
        if isinstance(obj, Room):
            # Simulate the DB assigning the PK on flush.
            if obj.id is None:
                obj.id = uuid.uuid4()
            self.added_rooms.append(obj)

    async def commit(self):
        self.commit_count += 1

    async def refresh(self, _obj):
        return None

    async def flush(self):
        return None

    async def rollback(self):
        return None


@pytest.fixture
def fake_db():
    """Sync-enabled user, no pre-existing native room row."""
    session = _FakeAsyncSession(_make_user())

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        yield session
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def fake_db_sync_disabled():
    """User exists but never opted in to Farcaster sync."""
    session = _FakeAsyncSession(_make_user(sync_enabled=False, farcaster_fid=None))

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        yield session
    finally:
        app.dependency_overrides.pop(get_db, None)


# ---------------------------------------------------------------------
# Upstream Farcaster spaces fake
# ---------------------------------------------------------------------


class _FakeSpacesService:
    def __init__(self, room: AudioRoom | None):
        self.room = room
        self.calls: list[str] = []

    async def get_room(self, room_id: str) -> AudioRoom | None:
        self.calls.append(room_id)
        return self.room


def _upstream_room(
    *,
    host_fid: int = TEST_FID,
    state: str = "live",
    title: str | None = "Native room test",
    scheduled_at: datetime | None = None,
) -> AudioRoom:
    return AudioRoom.model_validate(
        {
            "id": VALID_FCSP_UUID,
            "title": title,
            "host": {"fid": host_fid, "username": "host"},
            "state": state,
            "scheduledAt": scheduled_at.isoformat() if scheduled_at else None,
        }
    )


@pytest.fixture
def upstream():
    fake = _FakeSpacesService(_upstream_room())
    previous = getattr(app.state, "farcaster_spaces_service", None)
    app.state.farcaster_spaces_service = fake
    try:
        yield fake
    finally:
        app.state.farcaster_spaces_service = previous


# ---------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_link_creates_native_room(client, fake_db, upstream):
    resp = await client.post(
        "/v1/rooms/link-farcaster",
        json={
            "farcaster_room_id": VALID_FCSP_UUID,
            "title": "Native room test",
        },
        headers=_first_party_header(),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["is_farcaster_native"] is True
    assert body["farcaster_room_id"] == VALID_FCSP_UUID
    assert body["title"] == "Native room test"
    # ``host_fid`` is the Juke session FID (FK to users.fid). The
    # self-attested Warpcast FID is stashed in metadata_ instead so
    # the FK constraint stays valid even when the upstream Warpcast
    # FID has no corresponding Juke user row.
    assert body["host_fid"] == TEST_FID
    # Active by default — no scheduled_at in the request.
    assert body["status"] == "active"

    # Persisted via add()/commit() pair.
    assert len(fake_db.added_rooms) == 1
    row = fake_db.added_rooms[0]
    assert row.is_farcaster_native is True
    assert row.farcaster_room_id == VALID_FCSP_UUID
    assert row.host_fid == TEST_FID
    assert row.metadata_["farcaster_host_fid"] == LINKED_FARCASTER_FID
    assert row.livekit_room_id is None


@pytest.mark.asyncio
async def test_link_with_scheduled_at_creates_scheduled_room(client, fake_db, upstream):
    scheduled = datetime(2099, 6, 1, 12, 0, tzinfo=timezone.utc)
    upstream.room = _upstream_room(state="scheduled", scheduled_at=scheduled)
    resp = await client.post(
        "/v1/rooms/link-farcaster",
        json={
            "farcaster_room_id": VALID_FCSP_UUID,
            "title": "Future native room",
            "scheduled_at": scheduled.isoformat(),
        },
        headers=_first_party_header(),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "scheduled"
    assert body["is_farcaster_native"] is True


# ---------------------------------------------------------------------
# Authorization
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_link_requires_sync_enabled(client, fake_db_sync_disabled):
    """A user without Farcaster sync opted in must be rejected with 403."""
    resp = await client.post(
        "/v1/rooms/link-farcaster",
        json={
            "farcaster_room_id": VALID_FCSP_UUID,
            "title": "No-sync user",
        },
        headers=_first_party_header(),
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Farcaster sync not enabled"
    # No row was persisted.
    assert fake_db_sync_disabled.added_rooms == []


@pytest.mark.asyncio
async def test_link_rejects_partner_jwt(client, fake_db):
    """Partner-minted JWTs can't create rooms on a user's behalf —
    same precedent as B3's farcaster-sync link/revoke endpoints."""
    resp = await client.post(
        "/v1/rooms/link-farcaster",
        json={
            "farcaster_room_id": VALID_FCSP_UUID,
            "title": "Partner-attributed",
        },
        headers=_partner_header(),
    )
    assert resp.status_code == 401
    assert fake_db.added_rooms == []


@pytest.mark.asyncio
async def test_link_requires_auth(client, fake_db):
    resp = await client.post(
        "/v1/rooms/link-farcaster",
        json={
            "farcaster_room_id": VALID_FCSP_UUID,
            "title": "No auth",
        },
    )
    assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad_uuid",
    [
        "not-a-uuid",
        "11111111-2222-3333-4444-55555555555",  # 11 hex (one short)
        "11111111-2222-3333-4444-5555555555555",  # 13 hex
        "11111111222233334444555555555555",  # missing dashes
        "11111111-2222-3333-4444-55555555555Z",  # non-hex char
        "11111111-2222-3333-4444-555555555555-extra",
        "",
    ],
)
async def test_link_rejects_invalid_uuid(client, fake_db, bad_uuid):
    resp = await client.post(
        "/v1/rooms/link-farcaster",
        json={"farcaster_room_id": bad_uuid, "title": "Test"},
        headers=_first_party_header(),
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_link_rejects_uppercase_uuid(client, fake_db):
    """Farcaster issues lowercase UUIDs; uppercase is a hint that the
    client is normalizing wrong. Reject so we don't store both casings
    as different rows."""
    # Use a UUID containing alpha chars so case actually matters.
    uppercase_uuid = "AABBCCDD-EEFF-AABB-CCDD-EEFFAABBCCDD"
    resp = await client.post(
        "/v1/rooms/link-farcaster",
        json={
            "farcaster_room_id": uppercase_uuid,
            "title": "Test",
        },
        headers=_first_party_header(),
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_link_rejects_extra_fields(client, fake_db):
    """The schema is locked down with ``extra='forbid'`` so a future
    regression can't accidentally accept (and log) the Warpcast
    bearer."""
    resp = await client.post(
        "/v1/rooms/link-farcaster",
        json={
            "farcaster_room_id": VALID_FCSP_UUID,
            "title": "Test",
            "warpcast_bearer": "secret",
        },
        headers=_first_party_header(),
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_link_rejects_empty_title(client, fake_db):
    resp = await client.post(
        "/v1/rooms/link-farcaster",
        json={"farcaster_room_id": VALID_FCSP_UUID, "title": ""},
        headers=_first_party_header(),
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_link_idempotent_returns_existing_row(upstream):
    """Re-linking the same upstream UUID must return the existing row,
    not insert a duplicate — even if the caller is a different Juke
    user. Native rooms have exactly one upstream owner on Farcaster's
    side."""
    existing = Room(
        id=uuid.uuid4(),
        title="Already linked",
        host_fid=TEST_FID,
        status="active",
        started_at=datetime.now(timezone.utc),
        recording=False,
        allow_agents=False,
        is_farcaster_native=True,
        farcaster_room_id=VALID_FCSP_UUID,
        metadata_={"farcaster_host_fid": LINKED_FARCASTER_FID},
    )
    session = _FakeAsyncSession(_make_user(), existing_room=existing)

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        from httpx import ASGITransport, AsyncClient
        from unittest.mock import AsyncMock, MagicMock

        # The endpoint's redis rate-limit + the service's discovery
        # publish both touch redis; install a minimal mock.
        mock_redis = AsyncMock()
        mock_pipeline = MagicMock()
        mock_pipeline.incr = MagicMock()
        mock_pipeline.expire = MagicMock()
        mock_pipeline.execute = AsyncMock(return_value=[1, True])
        mock_redis.pipeline = MagicMock(return_value=mock_pipeline)
        # Empty participant hash for the live-counts read on existing rows.
        mock_redis.hgetall = AsyncMock(return_value={})
        app.state.redis = mock_redis

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            resp = await ac.post(
                "/v1/rooms/link-farcaster",
                json={
                    "farcaster_room_id": VALID_FCSP_UUID,
                    "title": "Different title (ignored)",
                },
                headers=_first_party_header(),
            )

        assert resp.status_code == 201, resp.text
        body = resp.json()
        # Returned row is the existing one (its id/title), not a new insert.
        assert body["id"] == str(existing.id)
        assert body["title"] == "Already linked"
        # No additional rows were persisted.
        assert session.added_rooms == []
    finally:
        app.dependency_overrides.pop(get_db, None)


# ---------------------------------------------------------------------
# SECURITY (M5): upstream host verification
# ---------------------------------------------------------------------


def _link_body(title: str = "Client title") -> dict:
    return {"farcaster_room_id": VALID_FCSP_UUID, "title": title}


@pytest.mark.asyncio
async def test_link_rejects_caller_who_is_not_upstream_host(client, fake_db, upstream):
    upstream.room = _upstream_room(host_fid=TEST_FID + 1)
    resp = await client.post(
        "/v1/rooms/link-farcaster",
        json=_link_body(),
        headers=_first_party_header(),
    )
    assert resp.status_code == 403
    assert upstream.calls == [VALID_FCSP_UUID]
    assert fake_db.added_rooms == []


@pytest.mark.asyncio
async def test_link_404_when_upstream_space_missing(client, fake_db, upstream):
    upstream.room = None
    resp = await client.post(
        "/v1/rooms/link-farcaster",
        json=_link_body(),
        headers=_first_party_header(),
    )
    assert resp.status_code == 404
    assert fake_db.added_rooms == []


@pytest.mark.asyncio
async def test_link_503_without_upstream_service(client, fake_db):
    previous = getattr(app.state, "farcaster_spaces_service", None)
    app.state.farcaster_spaces_service = None
    try:
        resp = await client.post(
            "/v1/rooms/link-farcaster",
            json=_link_body(),
            headers=_first_party_header(),
        )
    finally:
        app.state.farcaster_spaces_service = previous
    assert resp.status_code == 503
    assert fake_db.added_rooms == []


@pytest.mark.asyncio
async def test_link_rejects_ended_upstream_space(client, fake_db, upstream):
    upstream.room = _upstream_room(state="ended")
    resp = await client.post(
        "/v1/rooms/link-farcaster",
        json=_link_body(),
        headers=_first_party_header(),
    )
    assert resp.status_code == 409
    assert fake_db.added_rooms == []


@pytest.mark.asyncio
async def test_link_takes_title_and_schedule_from_upstream(client, fake_db, upstream):
    upstream.room = _upstream_room(title="Upstream title", state="live")
    resp = await client.post(
        "/v1/rooms/link-farcaster",
        json={
            **_link_body("Spoofed title"),
            # Client claims scheduled; upstream says live -> active.
            "scheduled_at": datetime(2099, 1, 1, tzinfo=timezone.utc).isoformat(),
        },
        headers=_first_party_header(),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["title"] == "Upstream title"
    assert body["status"] == "active"


@pytest.mark.asyncio
async def test_link_reattributes_row_planted_by_another_user(client, upstream):
    """A pre-fix claimant's row is handed back to the verified host."""
    squatter_fid = TEST_FID + 99
    planted = Room(
        id=uuid.uuid4(),
        title="Squatted",
        host_fid=squatter_fid,
        status="active",
        started_at=datetime.now(timezone.utc),
        recording=False,
        allow_agents=False,
        is_farcaster_native=True,
        farcaster_room_id=VALID_FCSP_UUID,
        metadata_={"farcaster_host_fid": squatter_fid},
    )
    session = _FakeAsyncSession(_make_user(), existing_room=planted)

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        resp = await client.post(
            "/v1/rooms/link-farcaster",
            json=_link_body(),
            headers=_first_party_header(),
        )
    finally:
        app.dependency_overrides.pop(get_db, None)

    assert resp.status_code == 201, resp.text
    assert resp.json()["host_fid"] == TEST_FID
    assert planted.host_fid == TEST_FID
    assert planted.metadata_["farcaster_host_fid"] == TEST_FID
    assert session.added_rooms == []


@pytest.mark.asyncio
async def test_squatter_cannot_receive_existing_row(client, upstream):
    """Dedupe no longer hands the real host's row to a non-host caller."""
    real_host_row = Room(
        id=uuid.uuid4(),
        title="Real",
        host_fid=TEST_FID + 1,
        status="active",
        started_at=datetime.now(timezone.utc),
        recording=False,
        allow_agents=False,
        is_farcaster_native=True,
        farcaster_room_id=VALID_FCSP_UUID,
        metadata_={},
    )
    upstream.room = _upstream_room(host_fid=TEST_FID + 1)
    session = _FakeAsyncSession(_make_user(), existing_room=real_host_row)

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        resp = await client.post(
            "/v1/rooms/link-farcaster",
            json=_link_body(),
            headers=_first_party_header(),
        )
    finally:
        app.dependency_overrides.pop(get_db, None)

    assert resp.status_code == 403
    assert real_host_row.host_fid == TEST_FID + 1


class _RacingSession(_FakeAsyncSession):
    """First insert loses the unique-index race to a concurrent link."""

    def __init__(self, user: User, winner: Room):
        super().__init__(user)
        self._winner = winner
        self.rolled_back = False
        self.user_loads_after_rollback = 0

    async def execute(self, stmt):
        if self.rolled_back and "users.id" in str(stmt):
            self.user_loads_after_rollback += 1
        return await super().execute(stmt)

    async def commit(self):
        if not self.rolled_back and self.added_rooms:
            raise IntegrityError("INSERT", {}, Exception("duplicate key"))
        await super().commit()

    async def rollback(self):
        self.rolled_back = True
        self._existing_room = self._winner


@pytest.mark.asyncio
async def test_link_integrity_race_returns_winner_and_reloads_host(client, upstream):
    winner = Room(
        id=uuid.uuid4(),
        title="Winner",
        host_fid=TEST_FID,
        status="active",
        started_at=datetime.now(timezone.utc),
        recording=False,
        allow_agents=False,
        is_farcaster_native=True,
        farcaster_room_id=VALID_FCSP_UUID,
        metadata_={"farcaster_host_fid": TEST_FID},
    )
    session = _RacingSession(_make_user(), winner)

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        resp = await client.post(
            "/v1/rooms/link-farcaster",
            json=_link_body(),
            headers=_first_party_header(),
        )
    finally:
        app.dependency_overrides.pop(get_db, None)

    assert resp.status_code == 201, resp.text
    assert resp.json()["id"] == str(winner.id)
    # rollback() expires loaded rows, so the host must be re-fetched.
    assert session.user_loads_after_rollback >= 1


# ---------------------------------------------------------------------
# Native-room guards on lifecycle endpoints — source-level invariants
# ---------------------------------------------------------------------
#
# The actual 4xx/5xx response paths go through ``RoomService`` which
# requires a live DB + Redis to exercise end-to-end. To keep this test
# file independent of the integration infra, we assert the *guard
# itself* is present by inspecting the method source. This mirrors the
# pattern in ``test_developer_end_space.py``.


def test_join_room_guards_native_with_400():
    src = inspect.getsource(RoomService.join_room)
    assert "is_farcaster_native" in src
    assert "client.farcaster.xyz" in src
    assert "status_code=400" in src


def test_leave_room_guards_native_with_400():
    src = inspect.getsource(RoomService.leave_room)
    assert "is_farcaster_native" in src
    assert "client.farcaster.xyz" in src
    assert "status_code=400" in src


def test_start_recording_routes_native_through_agent_dispatcher():
    """Phase-4 part 1 flipped 501 -> recording-agent dispatch."""
    src = inspect.getsource(RoomService.start_recording)
    assert "is_farcaster_native" in src
    assert "_start_native_recording" in src
    # The agent path must NOT 501 — that was the pre-Phase-4 stub.
    assert "501" not in src


def test_stop_recording_routes_native_through_agent_dispatcher():
    """Phase-4 part 1 flipped 501 -> recording-agent finalize."""
    src = inspect.getsource(RoomService.stop_recording)
    assert "is_farcaster_native" in src
    assert "_stop_native_recording" in src
    assert "501" not in src


def test_native_recording_dispatcher_uses_agent_pool():
    """The dispatcher must reserve an agent FID, join, then spawn."""
    src = inspect.getsource(RoomService._start_native_recording)
    assert "pick_available_recording_agent" in src
    assert "join_room_as_listener" in src
    assert "recording_agent.start_recording" in src
    # Releases the agent on every error branch so a flaky mint or
    # spawn doesn't permanently sideline an FID.
    assert "release_recording_agent" in src


def test_native_recording_stop_releases_agent_and_persists_url():
    # Stop logic lives in the shared finalizer; the host-stop path delegates to it.
    src_stop = inspect.getsource(RoomService._stop_native_recording)
    src_finalize = inspect.getsource(RoomService._finalize_native_recording_stop)
    assert "_finalize_native_recording_stop" in src_stop
    assert "recording_agent.stop_recording" in src_finalize
    assert "release_recording_agent" in src_finalize
    assert "recording_url" in src_finalize


def test_create_room_skips_livekit_for_native_rooms():
    """``link_farcaster_room`` is the only entry point that sets
    ``is_farcaster_native=True``; it must never call into LiveKit."""
    src = inspect.getsource(RoomService.link_farcaster_room)
    # No LiveKit allocation calls; ``livekit_room_id=None`` is the
    # only legitimate mention of "livekit" in the body.
    assert "self.livekit." not in src
    assert "livekit_room_id=None" in src
    # And the row it persists has the flag set.
    assert "is_farcaster_native=True" in src


def test_link_farcaster_room_uses_juke_fid_for_host_fk():
    """``rooms.host_fid`` has a hard FK to ``users.fid``. The native
    link path must use the **Juke** session FID (always a valid
    user row) and stash the self-attested Warpcast FID in
    ``metadata_`` — using the Warpcast FID directly would 500 for
    any user whose Warpcast FID isn't also a Juke user."""
    src = inspect.getsource(RoomService.link_farcaster_room)
    assert "host_fid=fid" in src
    assert "farcaster_host_fid" in src


# ---------------------------------------------------------------------
# Serialization: RoomResponse always includes the new fields
# ---------------------------------------------------------------------


def test_room_response_includes_native_fields():
    """The serialization schema exposes both fields with safe defaults
    so existing GET /v1/rooms/{id} consumers continue to deserialize
    cleanly."""
    from app.schemas.room import RoomResponse
    from app.schemas.auth import UserResponse

    response = RoomResponse(
        id=str(uuid.uuid4()),
        title="t",
        host_fid=1,
        host=UserResponse(fid=1, username="u", display_name="U"),
        status="active",
        started_at="2026-05-30T00:00:00+00:00",
    )
    dumped = response.model_dump()
    assert "farcaster_room_id" in dumped
    assert "is_farcaster_native" in dumped
    assert dumped["farcaster_room_id"] is None
    assert dumped["is_farcaster_native"] is False


def test_room_response_serializes_set_native_fields():
    from app.schemas.room import RoomResponse
    from app.schemas.auth import UserResponse

    response = RoomResponse(
        id=str(uuid.uuid4()),
        title="t",
        host_fid=1,
        host=UserResponse(fid=1, username="u", display_name="U"),
        status="active",
        started_at="2026-05-30T00:00:00+00:00",
        farcaster_room_id=VALID_FCSP_UUID,
        is_farcaster_native=True,
    )
    dumped = response.model_dump()
    assert dumped["farcaster_room_id"] == VALID_FCSP_UUID
    assert dumped["is_farcaster_native"] is True
