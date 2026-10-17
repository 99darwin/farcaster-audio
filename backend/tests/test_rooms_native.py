"""Tests for ``POST /v1/rooms/native`` — backend-orchestrated
Farcaster-native room creation.

Differs from the C3 ``POST /v1/rooms/link-farcaster`` flow in that the
upstream room is minted server-side via Juke's service-FID bearer.
The Mini App custody-signing path is dead (Warpcast doesn't expose a
sign-as-custody primitive), so every Farcaster-native space goes
through this endpoint now.

The tests cover:

  * Happy path — Juke row persisted with prefixed metadata.
  * Service FID is the upstream caller — title and bearer mint via
    ``JUKE_FARCASTER_FID``.
  * Username prefix logic — short / overlong / missing username, plus
    the 200-char upstream title cap.
  * Auth gating — partner JWTs rejected.
  * scheduled_at branch — row reflects ``scheduled`` status.
  * Upstream failure — 502, no Juke row created (rollback).
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from jose import jwt

from app.config import settings
from app.dependencies import get_db
from app.main import app
from app.models.room import Room
from app.models.user import User
from app.routers.rooms import _build_upstream_title

TEST_FID = 7777


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
# In-memory DB fake — mirrors test_room_link_farcaster.py
# ---------------------------------------------------------------------


def _make_user(
    fid: int = TEST_FID,
    *,
    username: str | None = "alice",
    display_name: str | None = "Alice Liddell",
    pfp_url: str | None = None,
) -> User:
    return User(
        fid=fid,
        signer_uuid="test-signer-" + str(fid),
        username=username,
        display_name=display_name,
        pfp_url=pfp_url,
        custody_address=None,
        is_admin=False,
        is_agent=False,
        developer_access_status="none",
        farcaster_fid=None,
        farcaster_sync_enabled=False,
        farcaster_sync_linked_at=None,
    )


class _FakeRow:
    """Stand-in for a SQLAlchemy ``Row`` (tuple-of-columns) result."""

    def __init__(self, **fields: Any):
        self.__dict__.update(fields)


class _FakeResult:
    def __init__(self, value: Any):
        self._value = value

    def scalar_one_or_none(self) -> Any:
        return self._value

    def first(self) -> Any:
        return self._value


class _FakeAsyncSession:
    """Minimal ``AsyncSession`` stand-in for the native-create endpoint.

    The endpoint issues two ``SELECT`` reads against ``users``:

      * ``select(User.username, User.display_name).where(User.fid == fid)``
      * ``select(User.fid, User.username, User.display_name, User.pfp_url,
                 User.custody_address).where(User.fid == fid)``

    Both return a ``_FakeRow`` populated from the seeded ``User`` row.
    No other tables are touched.

    The end-native-room tests also need a SELECT against ``rooms`` —
    ``select(Room).where(Room.id == room_uuid)`` — to look up the row.
    When ``seeded_room`` is provided it's returned via
    ``scalar_one_or_none()``; otherwise the lookup returns ``None``
    (404 path).
    """

    def __init__(self, user: User | None, *, seeded_room: Room | None = None):
        self._user = user
        self._seeded_room = seeded_room
        self.added_rooms: list[Room] = []
        self.commit_count = 0

    async def execute(self, stmt):
        compiled = str(stmt)
        if "FROM rooms" in compiled:
            # The router issues either a full ``select(Room)`` (the
            # end-native endpoint reads the full row) or a column-only
            # ``select(Room.is_farcaster_native)`` (the DELETE guard
            # peeks just the boolean). A single-column SELECT renders
            # exactly one ``rooms.<col>`` token in the SELECT list —
            # use that to disambiguate.
            select_clause = compiled.split("FROM")[0]
            if (
                select_clause.count("rooms.") == 1
                and "is_farcaster_native" in select_clause
            ):
                return _FakeResult(
                    self._seeded_room.is_farcaster_native if self._seeded_room else None
                )
            return _FakeResult(self._seeded_room)
        if "FROM users" in compiled:
            if self._user is None:
                return _FakeResult(None)
            return _FakeResult(
                _FakeRow(
                    fid=self._user.fid,
                    username=self._user.username,
                    display_name=self._user.display_name,
                    pfp_url=self._user.pfp_url,
                    custody_address=self._user.custody_address,
                )
            )
        return _FakeResult(None)

    def add(self, obj) -> None:
        if isinstance(obj, Room):
            if obj.id is None:
                obj.id = uuid.uuid4()
            self.added_rooms.append(obj)

    async def commit(self) -> None:
        self.commit_count += 1

    async def refresh(self, _obj) -> None:
        return None

    async def flush(self) -> None:
        return None

    async def rollback(self) -> None:
        return None


# ---------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------


@pytest.fixture
def fake_db():
    session = _FakeAsyncSession(_make_user())

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        yield session
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def fake_db_no_username():
    session = _FakeAsyncSession(_make_user(username=None))

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        yield session
    finally:
        app.dependency_overrides.pop(get_db, None)


def _make_fake_upstream_room(*, room_id: str = "fc-room-uuid-from-upstream"):
    """Build a stand-in for the parsed ``AudioRoom`` returned by
    ``FarcasterSpacesService.create_audio_room``.

    The endpoint only reads ``.id`` off the returned object, so a thin
    namespace-style object suffices and we don't need to import the
    full schema here.
    """

    class _FakeAudioRoom:
        id = room_id

    return _FakeAudioRoom()


@pytest.fixture
def fake_spaces_service():
    """Install a mocked FarcasterSpacesService on ``app.state`` and
    return the mock so tests can assert on ``create_audio_room``
    calls / behavior.
    """
    mock_service = AsyncMock()
    mock_service.create_audio_room = AsyncMock(return_value=_make_fake_upstream_room())
    previous = getattr(app.state, "farcaster_spaces_service", None)
    app.state.farcaster_spaces_service = mock_service
    try:
        yield mock_service
    finally:
        if previous is not None:
            app.state.farcaster_spaces_service = previous
        else:
            # The conftest client fixture sets app.state.redis but not
            # the spaces service; clear it back out so a subsequent
            # test that *does* rely on the lifespan-installed instance
            # isn't poisoned by this mock.
            try:
                del app.state.farcaster_spaces_service
            except AttributeError:
                pass


# ---------------------------------------------------------------------
# Title-prefix unit tests — exercise the helper directly so the edge
# cases are documented at the per-input level (lots of edge cases here
# would otherwise need their own integration test each).
# ---------------------------------------------------------------------


class TestBuildUpstreamTitle:
    def test_short_username_prefixes_cleanly(self):
        assert (
            _build_upstream_title(username="alice", user_title="My Show")
            == "@alice: My Show"
        )

    def test_emoji_username_passes_through(self):
        # Farcaster usernames can be ASCII-only in practice, but the
        # helper has no business filtering — that's a username-set
        # concern. Make sure we don't crash on non-ASCII.
        out = _build_upstream_title(
            username="alice", user_title="Talking about 🎙️ stuff"
        )
        assert out.startswith("@alice: ")
        assert "🎙️" in out

    def test_overlong_total_truncates_user_title(self):
        long_title = "x" * 500
        out = _build_upstream_title(username="alice", user_title=long_title)
        assert len(out) == 200
        assert out.startswith("@alice: ")
        # Rest of the budget is filled with the user's title.
        assert out[len("@alice: ") :] == "x" * (200 - len("@alice: "))

    def test_overlong_username_truncates_prefix(self):
        long_username = "a" * 200
        out = _build_upstream_title(username=long_username, user_title="Topic")
        # Username portion of the prefix is capped to fit in 50 chars
        # (3 chars reserved for ``@`` + ``: ``).
        # Resulting prefix is ``@`` + 47 chars + ``: `` = 50 chars.
        prefix_end = out.index(": ") + 2
        assert prefix_end == 50
        assert out.startswith("@")
        assert out[prefix_end - 2 :].startswith(": ")
        # Total stays under cap.
        assert len(out) <= 200

    def test_strips_username_whitespace(self):
        out = _build_upstream_title(username="  alice  ", user_title="Hi")
        assert out == "@alice: Hi"


# ---------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_native_persists_room(client, fake_db, fake_spaces_service):
    resp = await client.post(
        "/v1/rooms/native",
        json={"title": "My Show"},
        headers=_first_party_header(),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["is_farcaster_native"] is True
    assert body["farcaster_room_id"] == "fc-room-uuid-from-upstream"
    # The Juke ``Room.title`` is the un-prefixed user-facing title.
    assert body["title"] == "My Show"
    assert body["host_fid"] == TEST_FID
    assert body["status"] == "active"

    # One row persisted via add()/commit().
    assert len(fake_db.added_rooms) == 1
    row = fake_db.added_rooms[0]
    assert row.is_farcaster_native is True
    assert row.farcaster_room_id == "fc-room-uuid-from-upstream"
    assert row.host_fid == TEST_FID
    assert row.title == "My Show"
    assert row.metadata_["farcaster_upstream_title"] == "@alice: My Show"
    assert row.metadata_["farcaster_host_username"] == "alice"
    assert row.livekit_room_id is None
    assert row.allow_agents is False


@pytest.mark.asyncio
async def test_create_native_never_returns_host_custody_address(
    client, fake_db, fake_spaces_service
):
    """L11a: room payloads must not publish the host's custody address."""
    fake_db._user.custody_address = "0x" + "ab" * 20
    resp = await client.post(
        "/v1/rooms/native",
        json={"title": "My Show"},
        headers=_first_party_header(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["host"]["custody_address"] is None
    assert "ab" * 20 not in resp.text


@pytest.mark.asyncio
async def test_room_service_response_omits_host_custody_address():
    """L11a: the shared RoomService response builder drops custody_address."""
    from unittest.mock import MagicMock

    from app.services.room_service import RoomService

    service = RoomService(MagicMock(), MagicMock(), MagicMock())
    host = _make_user()
    host.custody_address = "0x" + "cd" * 20
    room = Room(
        id=uuid.uuid4(),
        title="Show",
        host_fid=host.fid,
        status="active",
        started_at=datetime.now(timezone.utc),
        recording=False,
        allow_agents=False,
        is_farcaster_native=False,
    )
    response = await service._build_room_response(room, host, 1, 0)
    assert response.host.custody_address is None
    assert response.host.fid == host.fid


def test_developer_native_room_response_omits_host_custody_address():
    """L11a: the developer API's native room builder drops custody_address."""
    from app.routers.developer import _native_room_response

    host = _make_user()
    host.custody_address = "0x" + "ef" * 20
    room = Room(
        id=uuid.uuid4(),
        title="Show",
        host_fid=host.fid,
        status="active",
        started_at=datetime.now(timezone.utc),
        recording=False,
        allow_agents=False,
        is_farcaster_native=True,
        farcaster_room_id="fc-room",
    )
    response = _native_room_response(room, host)
    assert response.host.custody_address is None
    assert response.host.fid == host.fid


@pytest.mark.asyncio
async def test_create_native_uses_service_fid_for_upstream(
    client, fake_db, fake_spaces_service
):
    """The upstream POST is dispatched via the service-FID bearer path,
    which routes through ``create_audio_room`` (no caller-supplied
    bearer)."""
    resp = await client.post(
        "/v1/rooms/native",
        json={"title": "Service FID check"},
        headers=_first_party_header(),
    )
    assert resp.status_code == 201, resp.text
    fake_spaces_service.create_audio_room.assert_awaited_once()
    call = fake_spaces_service.create_audio_room.await_args
    # Bearer is NOT a kwarg — the service-FID-bearer path is the whole
    # point of this endpoint (vs. the developer-bot bearer path).
    assert "bearer" not in call.kwargs
    # And the metadata records which service FID owns the upstream
    # row for future end/update ops.
    row = fake_db.added_rooms[0]
    assert row.metadata_["farcaster_service_fid"] == settings.JUKE_FARCASTER_FID


@pytest.mark.asyncio
async def test_create_native_prefixes_username_in_upstream_title(
    client, fake_db, fake_spaces_service
):
    """Upstream title is always ``@{username}: {user_title}``. The
    in-Juke ``Room.title`` stays un-prefixed."""
    resp = await client.post(
        "/v1/rooms/native",
        json={"title": "Topic of the day"},
        headers=_first_party_header(),
    )
    assert resp.status_code == 201, resp.text
    fake_spaces_service.create_audio_room.assert_awaited_once()
    call = fake_spaces_service.create_audio_room.await_args
    assert call.kwargs["title"] == "@alice: Topic of the day"


@pytest.mark.asyncio
async def test_create_native_truncates_overlong_title(
    client, fake_db, fake_spaces_service
):
    """Upstream title is capped at 200 chars total (including the
    ``@{username}: `` prefix)."""
    # Schema caps the user-supplied title at 200, so use the schema
    # max plus a long username via a dedicated fixture.
    long_user_title = "x" * 200
    resp = await client.post(
        "/v1/rooms/native",
        json={"title": long_user_title},
        headers=_first_party_header(),
    )
    assert resp.status_code == 201, resp.text
    call = fake_spaces_service.create_audio_room.await_args
    upstream_title = call.kwargs["title"]
    assert len(upstream_title) <= 200
    assert upstream_title.startswith("@alice: ")


@pytest.mark.asyncio
async def test_create_native_requires_username_set(
    client, fake_db_no_username, fake_spaces_service
):
    resp = await client.post(
        "/v1/rooms/native",
        json={"title": "No username"},
        headers=_first_party_header(),
    )
    assert resp.status_code == 400
    assert "username" in resp.json()["detail"].lower()
    # No upstream call, no Juke row created.
    fake_spaces_service.create_audio_room.assert_not_awaited()
    assert fake_db_no_username.added_rooms == []


@pytest.mark.asyncio
async def test_create_native_rejects_partner_jwt(client, fake_db, fake_spaces_service):
    """Partner-minted JWTs must not be able to spawn rooms on a user's
    behalf — same precedent as ``link-farcaster``."""
    resp = await client.post(
        "/v1/rooms/native",
        json={"title": "Partner-spawned"},
        headers=_partner_header(),
    )
    assert resp.status_code == 401
    # No upstream call, no Juke row.
    fake_spaces_service.create_audio_room.assert_not_awaited()
    assert fake_db.added_rooms == []


@pytest.mark.asyncio
async def test_create_native_includes_metadata(client, fake_db, fake_spaces_service):
    """All three operational metadata fields land on the row."""
    resp = await client.post(
        "/v1/rooms/native",
        json={
            "title": "Metadata check",
            "description": "An optional description.",
        },
        headers=_first_party_header(),
    )
    assert resp.status_code == 201, resp.text
    row = fake_db.added_rooms[0]
    assert row.metadata_["farcaster_host_username"] == "alice"
    assert row.metadata_["farcaster_upstream_title"] == "@alice: Metadata check"
    assert row.metadata_["farcaster_service_fid"] == settings.JUKE_FARCASTER_FID
    # Description survives onto the metadata blob too (so non-native
    # readers don't lose context).
    assert row.metadata_["description"] == "An optional description."


@pytest.mark.asyncio
async def test_create_native_scheduled(client, fake_db, fake_spaces_service):
    """A request with ``scheduled_at`` produces a scheduled row and
    forwards the schedule to the upstream call."""
    scheduled = datetime.now(tz=timezone.utc) + timedelta(hours=2)
    resp = await client.post(
        "/v1/rooms/native",
        json={
            "title": "Future show",
            "scheduled_at": scheduled.isoformat(),
        },
        headers=_first_party_header(),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "scheduled"
    # Service was called with the datetime (the service is responsible
    # for converting to ms — verified in the service's own tests).
    call = fake_spaces_service.create_audio_room.await_args
    assert call.kwargs["scheduled_at"] is not None
    assert isinstance(call.kwargs["scheduled_at"], datetime)


@pytest.mark.asyncio
async def test_create_native_upstream_failure(client, fake_db, fake_spaces_service):
    """Upstream failure surfaces as a 502 with no Juke row created."""
    import httpx

    fake_spaces_service.create_audio_room.side_effect = httpx.ConnectError(
        "upstream gone"
    )
    resp = await client.post(
        "/v1/rooms/native",
        json={"title": "Doomed"},
        headers=_first_party_header(),
    )
    assert resp.status_code == 502
    assert "Couldn't create on Farcaster" in resp.json()["detail"]
    # Rollback semantics — nothing committed.
    assert fake_db.added_rooms == []
    assert fake_db.commit_count == 0


# ---------------------------------------------------------------------
# User-FID JFS bearer path — caller signs the upstream Authorization
# themselves; the room is hosted by their FID directly (no service-FID
# title prefix, no post-create stage-invite dance).
# ---------------------------------------------------------------------


def _make_jfs_bearer(fid: int, *, sig: str = "deadbeef") -> str:
    """Build a minimal JFS Bearer string for tests.

    The router only decodes the header to extract the ``fid`` claim and
    cross-check it against the Juke JWT; signature verification is
    delegated to ``client.farcaster.xyz`` upstream (and is mocked away
    in this test suite). So we synthesize a header.payload.sig string
    where only the header is meaningful.
    """
    import base64 as _b64

    def _b64url(obj: Any) -> str:
        raw = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        return _b64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    now = int(datetime.now(tz=timezone.utc).timestamp())
    header = {"fid": fid, "type": "app_key", "key": "0x" + "ab" * 32}
    payload = {
        "audience": "https://client.farcaster.xyz",
        "timestamp": now,
        "exp": now + 300,
    }
    return f"{_b64url(header)}.{_b64url(payload)}.{sig}"


@pytest.mark.asyncio
async def test_create_native_user_bearer_forwarded_verbatim(
    client, fake_db, fake_spaces_service
):
    """When a user JFS bearer is supplied, ``create_audio_room`` is
    called with ``as_user_bearer`` set to that exact string — the
    upstream room ends up hosted by the user's FID, not the service
    FID."""
    bearer = _make_jfs_bearer(TEST_FID)
    resp = await client.post(
        "/v1/rooms/native",
        json={"title": "User-hosted", "user_jfs_bearer": bearer},
        headers=_first_party_header(),
    )
    assert resp.status_code == 201, resp.text
    call = fake_spaces_service.create_audio_room.await_args
    assert call.kwargs["as_user_bearer"] == bearer


@pytest.mark.asyncio
async def test_create_native_user_bearer_skips_username_prefix(
    client, fake_db, fake_spaces_service
):
    """User-FID path: upstream title is the user's title verbatim — no
    ``@username:`` prefix. The prefix only exists to attribute rooms
    hosted technically by the service FID."""
    bearer = _make_jfs_bearer(TEST_FID)
    resp = await client.post(
        "/v1/rooms/native",
        json={"title": "Topic of the day", "user_jfs_bearer": bearer},
        headers=_first_party_header(),
    )
    assert resp.status_code == 201, resp.text
    call = fake_spaces_service.create_audio_room.await_args
    assert call.kwargs["title"] == "Topic of the day"

    row = fake_db.added_rooms[0]
    assert row.metadata_["farcaster_upstream_title"] == "Topic of the day"
    assert row.metadata_["host_mode"] == "user_fid"


@pytest.mark.asyncio
async def test_create_native_user_bearer_skips_speaker_invite(
    client, fake_db, fake_spaces_service
):
    """User-FID path: no fire-and-forget stage-invite — the user IS
    already the upstream host, so an invite would be a no-op at best."""
    fake_spaces_service.invite_speaker_with_retry = AsyncMock(return_value=True)
    bearer = _make_jfs_bearer(TEST_FID)
    resp = await client.post(
        "/v1/rooms/native",
        json={"title": "User-hosted", "user_jfs_bearer": bearer},
        headers=_first_party_header(),
    )
    assert resp.status_code == 201, resp.text

    import asyncio

    for _ in range(5):
        await asyncio.sleep(0)

    fake_spaces_service.invite_speaker_with_retry.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_native_user_bearer_fid_mismatch_rejected(
    client, fake_db, fake_spaces_service
):
    """Bearer's JFS-claimed FID must match the Juke JWT FID. A partner
    can't pivot to host as someone else by submitting a bearer signed
    by a different FID."""
    bearer = _make_jfs_bearer(TEST_FID + 1)
    resp = await client.post(
        "/v1/rooms/native",
        json={"title": "Spoofed", "user_jfs_bearer": bearer},
        headers=_first_party_header(),
    )
    assert resp.status_code == 400
    assert "fid" in resp.json()["detail"].lower()
    fake_spaces_service.create_audio_room.assert_not_awaited()
    assert fake_db.added_rooms == []


@pytest.mark.asyncio
async def test_create_native_user_bearer_malformed_rejected(
    client, fake_db, fake_spaces_service
):
    """A bearer that isn't ``header.payload.sig`` is rejected before we
    call upstream. Defense-in-depth: the upstream would also reject,
    but bouncing locally avoids wasting an upstream round-trip.

    The schema validator rejects any string that isn't three
    base64url-encoded dot-separated segments — that includes both
    obviously-malformed input and control-character injection (CRLF)
    that could attempt header smuggling against client.farcaster.xyz."""
    resp = await client.post(
        "/v1/rooms/native",
        json={
            "title": "Bad bearer",
            "user_jfs_bearer": "this-is-definitely-not-a-jfs-token",
        },
        headers=_first_party_header(),
    )
    # Pydantic schema validator returns 422 for shape violations.
    assert resp.status_code == 422
    fake_spaces_service.create_audio_room.assert_not_awaited()

    # CRLF / header-injection attempt is rejected at the same layer.
    resp = await client.post(
        "/v1/rooms/native",
        json={
            "title": "Header injection",
            "user_jfs_bearer": "abc.def\r\nX-Injected: 1.ghi",
        },
        headers=_first_party_header(),
    )
    assert resp.status_code == 422
    fake_spaces_service.create_audio_room.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_native_user_bearer_wrong_audience_rejected(
    client, fake_db, fake_spaces_service
):
    """The payload's ``audience`` claim must bind to client.farcaster.xyz.
    Without enforcing it locally we'd happily relay bearers minted for
    other origins (e.g. a snap server) onto the audio-rooms endpoint."""
    import base64 as _b64

    def _b64url(obj: Any) -> str:
        raw = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        return _b64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    now = int(datetime.now(tz=timezone.utc).timestamp())
    header = {"fid": TEST_FID, "type": "app_key", "key": "0x" + "ab" * 32}
    payload = {
        "audience": "https://example.snap.server",
        "timestamp": now,
        "exp": now + 300,
    }
    bearer = f"{_b64url(header)}.{_b64url(payload)}.deadbeef"

    resp = await client.post(
        "/v1/rooms/native",
        json={"title": "Wrong aud", "user_jfs_bearer": bearer},
        headers=_first_party_header(),
    )
    assert resp.status_code == 400
    fake_spaces_service.create_audio_room.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_native_user_bearer_stale_timestamp_rejected(
    client, fake_db, fake_spaces_service
):
    """A timestamp far in the future (beyond clock-skew tolerance) is
    rejected. Past timestamps are bounded by ``exp`` rather than the
    skew window — see ``test_create_native_user_bearer_expired_exp_rejected``
    for the replay-prevention coverage."""
    import base64 as _b64

    def _b64url(obj: Any) -> str:
        raw = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        return _b64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    now = int(datetime.now(tz=timezone.utc).timestamp())
    header = {"fid": TEST_FID, "type": "app_key", "key": "0x" + "ab" * 32}
    payload = {
        "audience": "https://client.farcaster.xyz",
        "timestamp": now + 3600,
        "exp": now + 7200,
    }
    bearer = f"{_b64url(header)}.{_b64url(payload)}.deadbeef"

    resp = await client.post(
        "/v1/rooms/native",
        json={"title": "Stale", "user_jfs_bearer": bearer},
        headers=_first_party_header(),
    )
    assert resp.status_code == 400
    fake_spaces_service.create_audio_room.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_native_user_bearer_expired_exp_rejected(
    client, fake_db, fake_spaces_service
):
    """``exp`` must be a future epoch-seconds integer.

    Upstream (``client.farcaster.xyz``) requires ``exp`` and 401s with
    "Invalid token: Missing exp" when it's absent. Local validation
    catches expired bearers too so a stale client clock doesn't waste
    an upstream round-trip.
    """
    import base64 as _b64

    def _b64url(obj: Any) -> str:
        raw = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        return _b64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    now = int(datetime.now(tz=timezone.utc).timestamp())
    header = {"fid": TEST_FID, "type": "app_key", "key": "0x" + "ab" * 32}
    payload = {
        "audience": "https://client.farcaster.xyz",
        "timestamp": now,
        "exp": now - 60,
    }
    bearer = f"{_b64url(header)}.{_b64url(payload)}.deadbeef"

    resp = await client.post(
        "/v1/rooms/native",
        json={"title": "Expired", "user_jfs_bearer": bearer},
        headers=_first_party_header(),
    )
    assert resp.status_code == 400
    fake_spaces_service.create_audio_room.assert_not_awaited()


# ---------------------------------------------------------------------
# Speaker-invite-on-create wiring
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_native_create_fires_speaker_invite(client, fake_db, fake_spaces_service):
    """After upstream create succeeds, the create handler schedules a
    fire-and-forget ``invite_speaker_with_retry`` task so the human
    host lands as a speaker the first time they open Warpcast.

    The single-shot ``invite_speaker`` was upgraded to a bounded retry
    loop because the upstream often no-ops the invite when the target
    FID isn't yet a participant in the room. The handler now schedules
    ``invite_speaker_with_retry`` and passes a fresh-session-aware
    ``is_room_ended`` callback so the loop bails out if the host taps
    End mid-retry."""
    fake_spaces_service.invite_speaker_with_retry = AsyncMock(return_value=True)

    resp = await client.post(
        "/v1/rooms/native",
        json={"title": "Invite me"},
        headers=_first_party_header(),
    )
    assert resp.status_code == 201, resp.text

    # The fire-and-forget task runs on the same loop; yield to let it
    # execute before asserting.
    import asyncio

    for _ in range(5):
        await asyncio.sleep(0)

    fake_spaces_service.invite_speaker_with_retry.assert_awaited_once()
    call = fake_spaces_service.invite_speaker_with_retry.await_args
    assert call.args == ("fc-room-uuid-from-upstream", TEST_FID)
    # The handler MUST pass an ``is_room_ended`` checker so the loop
    # bails out when the host taps End. Validate by shape — we can't
    # call the closure here because it would need a real DB session.
    assert "is_room_ended" in call.kwargs
    assert callable(call.kwargs["is_room_ended"])


@pytest.mark.asyncio
async def test_native_create_succeeds_when_invite_fails(
    client, fake_db, fake_spaces_service
):
    """An invite-loop failure must NOT fail the create — the invite is
    purely additive UX. The Juke row + upstream create are the source
    of truth and have already committed by the time the loop fires.

    ``invite_speaker_with_retry`` is documented as never-raising, so the
    only way it surfaces an error is through its return value. But for
    extra defense we also pin down that even an explicit raise from the
    background task does NOT bounce the create response (the task runs
    in a detached coroutine — its raises bubble only to the asyncio
    loop, not the request handler)."""
    fake_spaces_service.invite_speaker_with_retry = AsyncMock(
        side_effect=RuntimeError("simulated unexpected failure")
    )

    resp = await client.post(
        "/v1/rooms/native",
        json={"title": "Invite fails"},
        headers=_first_party_header(),
    )
    # Create still returns 201 even though the invite task will raise.
    assert resp.status_code == 201, resp.text
    assert resp.json()["farcaster_room_id"] == "fc-room-uuid-from-upstream"

    # And the Juke row is persisted regardless.
    assert len(fake_db.added_rooms) == 1


# ---------------------------------------------------------------------
# End-native-room endpoint
# ---------------------------------------------------------------------


def _make_active_native_room(
    *,
    host_fid: int = TEST_FID,
    farcaster_room_id: str = "fc-room-uuid-from-upstream",
    status_: str = "active",
    host_mode: str = "service_fid",
) -> Room:
    """Build a ``Room`` row stand-in suitable for the end endpoint's
    SELECT lookup. UUID is fixed so the URL we POST to can reference it
    deterministically. ``host_mode`` selects whether the row represents
    a service-FID hosted room (legacy) or a user-FID hosted one
    (current default)."""
    room = Room(
        title="Native space",
        host_fid=host_fid,
        status=status_,
        scheduled_at=None,
        started_at=datetime.now(tz=timezone.utc),
        ended_at=None,
        livekit_room_id=None,
        allow_agents=False,
        recording=False,
        is_farcaster_native=True,
        farcaster_room_id=farcaster_room_id,
        metadata_={
            "farcaster_host_username": "alice",
            "farcaster_upstream_title": "@alice: Native space",
            "farcaster_service_fid": settings.JUKE_FARCASTER_FID,
            "source": "backend-orchestrated",
            "host_mode": host_mode,
        },
    )
    room.id = uuid.uuid4()
    return room


@pytest.fixture
def fake_db_with_user_hosted_native_room():
    """Variant of fake_db_with_native_room where the row was minted via
    the user-FID JFS bearer path. The end endpoint MUST require a
    user_jfs_bearer in the body to authorize the upstream call."""
    room = _make_active_native_room(host_mode="user_fid")
    session = _FakeAsyncSession(_make_user(), seeded_room=room)

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        yield session, room
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def fake_db_with_native_room():
    room = _make_active_native_room()
    session = _FakeAsyncSession(_make_user(), seeded_room=room)

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        yield session, room
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def fake_db_with_ended_native_room():
    room = _make_active_native_room(status_="ended")
    room.ended_at = datetime.now(tz=timezone.utc)
    session = _FakeAsyncSession(_make_user(), seeded_room=room)

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        yield session, room
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def fake_db_with_native_room_other_host():
    # Host on the room is a different FID than the caller — the caller's
    # JWT carries TEST_FID, this room is hosted by TEST_FID + 1.
    room = _make_active_native_room(host_fid=TEST_FID + 1)
    session = _FakeAsyncSession(_make_user(), seeded_room=room)

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        yield session, room
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def fake_spaces_service_with_end():
    """Variant of ``fake_spaces_service`` that also mocks
    ``end_audio_room``. Kept separate so the create-path tests stay
    minimal and don't carry an unused mock."""
    mock_service = AsyncMock()
    mock_service.create_audio_room = AsyncMock(return_value=_make_fake_upstream_room())
    mock_service.end_audio_room = AsyncMock(return_value=None)
    mock_service.invite_speaker = AsyncMock(return_value=None)
    previous = getattr(app.state, "farcaster_spaces_service", None)
    app.state.farcaster_spaces_service = mock_service
    try:
        yield mock_service
    finally:
        if previous is not None:
            app.state.farcaster_spaces_service = previous
        else:
            try:
                del app.state.farcaster_spaces_service
            except AttributeError:
                pass


@pytest.mark.asyncio
async def test_end_native_room_calls_service_and_marks_ended(
    client, fake_db_with_native_room, fake_spaces_service_with_end
):
    """Happy path — host calls end, service dispatches upstream, row
    flips to ended."""
    session, room = fake_db_with_native_room
    resp = await client.post(
        f"/v1/rooms/{room.id}/end",
        headers=_first_party_header(),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ended"
    assert body["ended_at"] is not None
    assert body["is_farcaster_native"] is True
    fake_spaces_service_with_end.end_audio_room.assert_awaited_once_with(
        "fc-room-uuid-from-upstream", bearer=None
    )
    # Row state mutated.
    assert room.status == "ended"
    assert room.ended_at is not None


@pytest.mark.asyncio
async def test_end_native_user_hosted_forwards_user_bearer(
    client,
    fake_db_with_user_hosted_native_room,
    fake_spaces_service_with_end,
):
    """User-FID rooms — the upstream room is hosted by the caller's FID,
    so the upstream end call must use the caller's freshly-signed JFS
    bearer, NOT Juke's service bearer. Service bearer 403s on these
    rooms (that's the whole bug this path fixes)."""
    _session, room = fake_db_with_user_hosted_native_room
    bearer = _make_jfs_bearer(TEST_FID)
    resp = await client.post(
        f"/v1/rooms/{room.id}/end",
        json={"user_jfs_bearer": bearer},
        headers=_first_party_header(),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "ended"
    fake_spaces_service_with_end.end_audio_room.assert_awaited_once_with(
        "fc-room-uuid-from-upstream", bearer=bearer
    )


@pytest.mark.asyncio
async def test_end_native_user_hosted_requires_user_bearer(
    client,
    fake_db_with_user_hosted_native_room,
    fake_spaces_service_with_end,
):
    """A user-FID room without ``user_jfs_bearer`` in the body MUST 400 —
    silently falling through to the service-bearer path would leave the
    upstream room live (and that's the bug, not a graceful degrade)."""
    _session, room = fake_db_with_user_hosted_native_room
    resp = await client.post(
        f"/v1/rooms/{room.id}/end",
        headers=_first_party_header(),
    )
    assert resp.status_code == 400
    fake_spaces_service_with_end.end_audio_room.assert_not_awaited()


@pytest.mark.asyncio
async def test_end_native_user_hosted_rejects_fid_mismatch(
    client,
    fake_db_with_user_hosted_native_room,
    fake_spaces_service_with_end,
):
    """A bearer signed by a DIFFERENT fid than the JWT must 403 — same
    posture as create / join. Blocks a partner with a stolen JWT for
    account A from ending account B's room."""
    _session, room = fake_db_with_user_hosted_native_room
    bearer = _make_jfs_bearer(TEST_FID + 1)
    resp = await client.post(
        f"/v1/rooms/{room.id}/end",
        json={"user_jfs_bearer": bearer},
        headers=_first_party_header(),
    )
    assert resp.status_code == 403
    fake_spaces_service_with_end.end_audio_room.assert_not_awaited()


@pytest.mark.asyncio
async def test_end_native_room_rejects_non_host(
    client, fake_db_with_native_room_other_host, fake_spaces_service_with_end
):
    """Anyone other than the recorded host gets a 403. The upstream end
    is NOT dispatched."""
    _session, room = fake_db_with_native_room_other_host
    resp = await client.post(
        f"/v1/rooms/{room.id}/end",
        headers=_first_party_header(),
    )
    assert resp.status_code == 403
    fake_spaces_service_with_end.end_audio_room.assert_not_awaited()
    assert room.status == "active"


@pytest.mark.asyncio
async def test_end_native_room_rejects_partner_jwt(
    client, fake_db_with_native_room, fake_spaces_service_with_end
):
    """Partner-minted JWTs must not be able to end a user's space."""
    _session, room = fake_db_with_native_room
    resp = await client.post(
        f"/v1/rooms/{room.id}/end",
        headers=_partner_header(),
    )
    assert resp.status_code == 401
    fake_spaces_service_with_end.end_audio_room.assert_not_awaited()
    assert room.status == "active"


@pytest.mark.asyncio
async def test_end_native_room_idempotent(
    client, fake_db_with_ended_native_room, fake_spaces_service_with_end
):
    """Re-ending an already-ended room returns 200 with ``ended`` and
    does NOT dispatch a second upstream call."""
    _session, room = fake_db_with_ended_native_room
    resp = await client.post(
        f"/v1/rooms/{room.id}/end",
        headers=_first_party_header(),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "ended"
    fake_spaces_service_with_end.end_audio_room.assert_not_awaited()


@pytest.mark.asyncio
async def test_end_native_room_404_for_unknown(
    client, fake_db, fake_spaces_service_with_end
):
    """No seeded room → 404. Validates a missing row never reaches the
    upstream dispatch."""
    resp = await client.post(
        f"/v1/rooms/{uuid.uuid4()}/end",
        headers=_first_party_header(),
    )
    assert resp.status_code == 404
    fake_spaces_service_with_end.end_audio_room.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_room_rejects_native_room(
    client, fake_db_with_native_room, fake_spaces_service_with_end
):
    """``DELETE /v1/rooms/{id}`` must refuse Farcaster-native rooms.

    Pre-existing service.end_room would flip the local row to
    "cancelled" (scheduled) or 403 (active, because Redis has no
    participant state for native rooms). Either case leaves the
    upstream room alive while the local rail says it's gone — the
    router guards against that by 400ing native rooms here and
    pointing callers at ``POST /v1/rooms/{id}/end``.
    """
    _session, room = fake_db_with_native_room
    resp = await client.delete(
        f"/v1/rooms/{room.id}",
        headers=_first_party_header(),
    )
    assert resp.status_code == 400
    assert "POST /v1/rooms/{id}/end" in resp.json()["detail"]
    # The native row stays untouched — upstream end was never called.
    assert room.status == "active"


# ---------------------------------------------------------------------
# Native-join endpoint — trade a user JFS bearer for upstream LiveKit
# credentials so Juke can play the room in-app (no Farcaster bounce).
# ---------------------------------------------------------------------


@pytest.fixture
def fake_spaces_service_with_join():
    """Variant of the spaces-service mock that exposes
    ``join_room_as_listener``. Default return: a well-formed result dict
    with ``wsUrl`` + ``token``. Individual tests override on the fly."""
    mock_service = AsyncMock()
    mock_service.join_room_as_listener = AsyncMock(
        return_value={
            "wsUrl": "wss://farcaster-livekit.test/room",
            "token": "lk-token-xyz",
        }
    )
    previous = getattr(app.state, "farcaster_spaces_service", None)
    app.state.farcaster_spaces_service = mock_service
    try:
        yield mock_service
    finally:
        if previous is not None:
            app.state.farcaster_spaces_service = previous
        else:
            try:
                del app.state.farcaster_spaces_service
            except AttributeError:
                pass


@pytest.mark.asyncio
async def test_native_join_returns_upstream_creds(
    client, fake_db_with_native_room, fake_spaces_service_with_join
):
    """Happy path — bearer validated, upstream called, ws_url + token
    surfaced to the caller."""
    _session, room = fake_db_with_native_room
    bearer = _make_jfs_bearer(TEST_FID)
    resp = await client.post(
        f"/v1/rooms/{room.id}/native-join",
        json={"user_jfs_bearer": bearer},
        headers=_first_party_header(),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ws_url"] == "wss://farcaster-livekit.test/room"
    assert body["token"] == "lk-token-xyz"

    fake_spaces_service_with_join.join_room_as_listener.assert_awaited_once_with(
        room_id="fc-room-uuid-from-upstream",
        bearer=bearer,
    )


@pytest.mark.asyncio
async def test_native_join_role_is_host_from_juke_row(
    client, fake_db_with_native_room, fake_spaces_service_with_join
):
    """The Juke row is authoritative for the host — role resolves to
    ``host`` without an upstream participant lookup."""
    _session, room = fake_db_with_native_room  # host_fid == TEST_FID
    resp = await client.post(
        f"/v1/rooms/{room.id}/native-join",
        json={"user_jfs_bearer": _make_jfs_bearer(TEST_FID)},
        headers=_first_party_header(),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["role"] == "host"
    # host is decided from host_fid — no participants call needed.
    fake_spaces_service_with_join.get_participants.assert_not_awaited()


@pytest.mark.asyncio
async def test_native_join_role_from_upstream_participants(
    client, fake_db_with_native_room_other_host, fake_spaces_service_with_join
):
    """A non-host caller's role comes from the upstream participant list;
    Farcaster's ``cohost`` maps to Juke's ``co_host``."""
    _session, room = fake_db_with_native_room_other_host  # host_fid != TEST_FID
    fake_spaces_service_with_join.get_participants = AsyncMock(
        return_value=[
            SimpleNamespace(user=SimpleNamespace(fid=TEST_FID + 1), role="host"),
            SimpleNamespace(user=SimpleNamespace(fid=TEST_FID), role="cohost"),
        ]
    )
    resp = await client.post(
        f"/v1/rooms/{room.id}/native-join",
        json={"user_jfs_bearer": _make_jfs_bearer(TEST_FID)},
        headers=_first_party_header(),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["role"] == "co_host"


@pytest.mark.asyncio
async def test_native_join_role_defaults_listener_on_lookup_failure(
    client, fake_db_with_native_room_other_host, fake_spaces_service_with_join
):
    """A participant-lookup failure never blocks the join — role falls
    back to ``listener`` and creds are still returned."""
    _session, room = fake_db_with_native_room_other_host
    fake_spaces_service_with_join.get_participants = AsyncMock(
        side_effect=RuntimeError("upstream blip")
    )
    resp = await client.post(
        f"/v1/rooms/{room.id}/native-join",
        json={"user_jfs_bearer": _make_jfs_bearer(TEST_FID)},
        headers=_first_party_header(),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["role"] == "listener"
    assert body["token"] == "lk-token-xyz"


@pytest.mark.asyncio
async def test_native_join_fid_mismatch_rejected(
    client, fake_db_with_native_room, fake_spaces_service_with_join
):
    """JFS-claimed FID must match the JWT FID. Bouncing here prevents a
    stolen first-party JWT for user A from being used to capture LiveKit
    creds bound to user B's signature."""
    _session, room = fake_db_with_native_room
    bearer = _make_jfs_bearer(TEST_FID + 1)
    resp = await client.post(
        f"/v1/rooms/{room.id}/native-join",
        json={"user_jfs_bearer": bearer},
        headers=_first_party_header(),
    )
    assert resp.status_code == 403
    assert "fid" in resp.json()["detail"].lower()
    fake_spaces_service_with_join.join_room_as_listener.assert_not_awaited()


@pytest.mark.asyncio
async def test_native_join_rejects_partner_jwt(
    client, fake_db_with_native_room, fake_spaces_service_with_join
):
    """Partner JWTs can't broker listener joins on behalf of users — same
    posture as create-native and end-native."""
    _session, room = fake_db_with_native_room
    bearer = _make_jfs_bearer(TEST_FID)
    resp = await client.post(
        f"/v1/rooms/{room.id}/native-join",
        json={"user_jfs_bearer": bearer},
        headers=_partner_header(),
    )
    assert resp.status_code == 401
    fake_spaces_service_with_join.join_room_as_listener.assert_not_awaited()


@pytest.mark.asyncio
async def test_native_join_rejects_non_native_room(
    client, fake_spaces_service_with_join
):
    """Juke-hosted rooms have no upstream Farcaster room to join — the
    iOS client must route those through the existing LiveKit go-live
    path, not native-join."""
    juke_room = _make_active_native_room()
    juke_room.is_farcaster_native = False
    juke_room.farcaster_room_id = None
    session = _FakeAsyncSession(_make_user(), seeded_room=juke_room)

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        bearer = _make_jfs_bearer(TEST_FID)
        resp = await client.post(
            f"/v1/rooms/{juke_room.id}/native-join",
            json={"user_jfs_bearer": bearer},
            headers=_first_party_header(),
        )
        assert resp.status_code == 400
        assert "native" in resp.json()["detail"].lower()
        fake_spaces_service_with_join.join_room_as_listener.assert_not_awaited()
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_native_join_404_for_unknown_room(
    client, fake_db, fake_spaces_service_with_join
):
    """No seeded room → 404 before any upstream call."""
    bearer = _make_jfs_bearer(TEST_FID)
    resp = await client.post(
        f"/v1/rooms/{uuid.uuid4()}/native-join",
        json={"user_jfs_bearer": bearer},
        headers=_first_party_header(),
    )
    assert resp.status_code == 404
    fake_spaces_service_with_join.join_room_as_listener.assert_not_awaited()


@pytest.mark.asyncio
async def test_native_join_upstream_failure_surfaces_502(
    client, fake_db_with_native_room, fake_spaces_service_with_join
):
    """Network / 4xx-5xx from ``client.farcaster.xyz`` becomes 502 to the
    caller — the joiner can retry."""
    import httpx as _httpx

    _session, room = fake_db_with_native_room
    fake_spaces_service_with_join.join_room_as_listener.side_effect = _httpx.HTTPError(
        "upstream boom"
    )
    bearer = _make_jfs_bearer(TEST_FID)
    resp = await client.post(
        f"/v1/rooms/{room.id}/native-join",
        json={"user_jfs_bearer": bearer},
        headers=_first_party_header(),
    )
    assert resp.status_code == 502


@pytest.mark.asyncio
async def test_native_join_handles_unexpected_upstream_shape(
    client, fake_db_with_native_room, fake_spaces_service_with_join
):
    """Upstream returns a result that's missing ``token`` or ``wsUrl`` —
    surface as 502 rather than 500. Defensive: shouldn't happen in
    practice but we don't want to leak a half-formed response."""
    _session, room = fake_db_with_native_room
    fake_spaces_service_with_join.join_room_as_listener.return_value = {
        "wsUrl": "wss://farcaster-livekit.test/room",
        # token missing
    }
    bearer = _make_jfs_bearer(TEST_FID)
    resp = await client.post(
        f"/v1/rooms/{room.id}/native-join",
        json={"user_jfs_bearer": bearer},
        headers=_first_party_header(),
    )
    assert resp.status_code == 502


@pytest.mark.asyncio
async def test_native_join_malformed_bearer_rejected(
    client, fake_db_with_native_room, fake_spaces_service_with_join
):
    """Schema validator rejects anything that isn't ``base64url.base64url
    .base64url`` (also catches CRLF / header-injection attempts before
    they reach the upstream Authorization header)."""
    _session, room = fake_db_with_native_room
    resp = await client.post(
        f"/v1/rooms/{room.id}/native-join",
        json={"user_jfs_bearer": "not-a-jfs-token-but-longer-than-16-chars"},
        headers=_first_party_header(),
    )
    assert resp.status_code == 422
    fake_spaces_service_with_join.join_room_as_listener.assert_not_awaited()


# ---------------------------------------------------------------------
# Native-room mirror — POST /v1/rooms/native/mirror
# ---------------------------------------------------------------------


def _mirror_body(
    *,
    farcaster_room_id: str = "fc-room-upstream-uuid",
    title: str = "Upstream-discovered space",
    state: str = "live",
    host_fid: int = 4242,
    host_username: str | None = "bob",
    host_display_name: str | None = "Bob",
    host_pfp_url: str | None = None,
    started_at: str | None = "2026-06-09T12:00:00+00:00",
    scheduled_at: str | None = None,
    root_cast_hash: str | None = None,
) -> dict[str, Any]:
    return {
        "farcaster_room_id": farcaster_room_id,
        "title": title,
        "state": state,
        "host_fid": host_fid,
        "host_username": host_username,
        "host_display_name": host_display_name,
        "host_pfp_url": host_pfp_url,
        "started_at": started_at,
        "scheduled_at": scheduled_at,
        "root_cast_hash": root_cast_hash,
    }


def _make_upstream_audio_room(
    *,
    host_fid: int = 4242,
    host_username: str | None = "bob",
    host_display_name: str | None = "Bob",
    host_pfp_url: str | None = None,
    state: str = "live",
    title: str | None = "Upstream-discovered space",
    started_at=None,
    scheduled_at=None,
    root_cast_hash: str | None = None,
):
    """Build an authoritative upstream ``AudioRoom`` for the mirror
    endpoint's server-side host resolution."""
    from app.schemas.farcaster_spaces import AudioRoom, SpaceUser

    return AudioRoom(
        id="fc-room-upstream-uuid",
        title=title,
        host=SpaceUser(
            fid=host_fid,
            username=host_username,
            display_name=host_display_name,
            pfp_url=host_pfp_url,
        ),
        state=state,
        started_at=started_at,
        scheduled_at=scheduled_at,
        root_cast_hash=root_cast_hash,
    )


@pytest.fixture
def mirror_upstream():
    """Install a mocked FarcasterSpacesService whose ``get_room`` returns
    an authoritative upstream space (host fid=4242). Tests can reassign
    ``mock.get_room`` to change the upstream host/state or return None."""
    mock_service = AsyncMock()
    mock_service.get_room = AsyncMock(return_value=_make_upstream_audio_room())
    previous = getattr(app.state, "farcaster_spaces_service", None)
    app.state.farcaster_spaces_service = mock_service
    try:
        yield mock_service
    finally:
        if previous is not None:
            app.state.farcaster_spaces_service = previous
        else:
            try:
                del app.state.farcaster_spaces_service
            except AttributeError:
                pass


@pytest.fixture
def fake_db_empty():
    """Empty fake session — no seeded user, no seeded room. The mirror
    endpoint should upsert both."""
    session = _FakeAsyncSession(user=None, seeded_room=None)

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        yield session
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_mirror_creates_juke_room_for_upstream_space(
    client, fake_db_empty, mirror_upstream
):
    """The happy path: no existing mirror, no existing host User, so
    the endpoint upserts the host and creates a Juke ``Room`` with
    ``is_farcaster_native=True`` and ``farcaster_room_id`` set. The host
    fid comes from the authoritative upstream space."""
    resp = await client.post(
        "/v1/rooms/native/mirror",
        json=_mirror_body(),
        headers=_first_party_header(),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_farcaster_native"] is True
    assert body["farcaster_room_id"] == "fc-room-upstream-uuid"
    assert body["host_fid"] == 4242  # from upstream get_room, not the body
    assert body["status"] == "active"
    assert len(fake_db_empty.added_rooms) == 1
    mirror_upstream.get_room.assert_awaited_once_with("fc-room-upstream-uuid")


@pytest.mark.asyncio
async def test_mirror_ignores_client_supplied_host_fid(
    client, fake_db_empty, mirror_upstream
):
    """SECURITY: a client cannot spoof the host. Even when the body claims
    a different host_fid, the mirror row is attributed to the authoritative
    upstream host (4242)."""
    resp = await client.post(
        "/v1/rooms/native/mirror",
        json=_mirror_body(host_fid=9999, host_username="attacker"),
        headers=_first_party_header(),
    )
    assert resp.status_code == 200
    assert resp.json()["host_fid"] == 4242
    # The persisted Room row is attributed to the real upstream host.
    assert fake_db_empty.added_rooms[0].host_fid == 4242


@pytest.mark.asyncio
async def test_mirror_404_when_upstream_space_missing(
    client, fake_db_empty, mirror_upstream
):
    """If the upstream space can't be found, we can't verify the host, so
    we refuse to create a mirror (rather than trusting the client)."""
    mirror_upstream.get_room = AsyncMock(return_value=None)
    resp = await client.post(
        "/v1/rooms/native/mirror",
        json=_mirror_body(),
        headers=_first_party_header(),
    )
    assert resp.status_code == 404
    assert fake_db_empty.added_rooms == []


@pytest.mark.asyncio
async def test_mirror_is_idempotent_when_room_already_exists(client):
    """A pre-existing ``Room`` row for the same ``farcaster_room_id``
    short-circuits — no new row is inserted, no host upsert runs."""
    existing = Room(
        id=uuid.uuid4(),
        title="Already mirrored",
        host_fid=4242,
        status="active",
        is_farcaster_native=True,
        farcaster_room_id="fc-room-upstream-uuid",
    )
    session = _FakeAsyncSession(user=None, seeded_room=existing)

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        resp = await client.post(
            "/v1/rooms/native/mirror",
            json=_mirror_body(),
            headers=_first_party_header(),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["id"] == str(existing.id)
        assert body["title"] == "Already mirrored"
        # No new row inserted — the pre-existing one was returned.
        assert session.added_rooms == []
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_mirror_already_exists_tolerates_null_host_profile(client):
    """Regression: an already-mirrored room returned with null
    ``host_username``/``host_display_name`` must not 500. The host profile
    is display-only and can legitimately arrive null (a viewer without the
    host cached, or a host with no username), so the endpoint coerces to
    safe fallbacks instead of failing ``UserResponse`` validation and
    making the space un-openable for everyone."""
    existing = Room(
        id=uuid.uuid4(),
        title="Already mirrored",
        host_fid=4242,
        status="active",
        is_farcaster_native=True,
        farcaster_room_id="fc-room-upstream-uuid",
    )
    session = _FakeAsyncSession(user=None, seeded_room=existing)

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        resp = await client.post(
            "/v1/rooms/native/mirror",
            json=_mirror_body(host_username=None, host_display_name=None),
            headers=_first_party_header(),
        )
        assert resp.status_code == 200
        host = resp.json()["host"]
        # Falls back to the fid rather than 500-ing on null strings.
        assert host["username"] == str(existing.host_fid)
        assert host["display_name"] == f"User {existing.host_fid}"
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_mirror_rejects_partner_jwt(client, fake_db_empty):
    """Partner-minted JWTs must not be able to spam mirrors — same
    posture as POST /v1/rooms/native."""
    resp = await client.post(
        "/v1/rooms/native/mirror",
        json=_mirror_body(),
        headers=_partner_header(),
    )
    assert resp.status_code == 401
    assert fake_db_empty.added_rooms == []


@pytest.mark.asyncio
async def test_mirror_scheduled_state_persists_scheduled_at(
    client, fake_db_empty, mirror_upstream
):
    """Scheduled state plus a ``scheduled_at`` propagates through to
    the Juke ``Room`` as ``status=scheduled``."""
    mirror_upstream.get_room = AsyncMock(
        return_value=_make_upstream_audio_room(state="scheduled", started_at=None)
    )
    resp = await client.post(
        "/v1/rooms/native/mirror",
        json=_mirror_body(
            state="scheduled",
            started_at=None,
            scheduled_at="2026-06-10T14:00:00+00:00",
        ),
        headers=_first_party_header(),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "scheduled"
    assert body["scheduled_at"] is not None


@pytest.mark.asyncio
async def test_mirror_persists_root_cast_hash_as_cast_hash(
    client, fake_db_empty, mirror_upstream
):
    """The upstream root cast hash is persisted to ``Room.cast_hash`` so
    Juke's chat surface — which keys off ``cast_hash`` to render the
    FIP-2 conversation thread — lights up for native rooms automatically."""
    resp = await client.post(
        "/v1/rooms/native/mirror",
        json=_mirror_body(),
        headers=_first_party_header(),
    )
    # Sanity check the no-root-cast path: cast_hash stays null.
    assert resp.json()["cast_hash"] is None

    # Now mirror a different room WITH a root_cast_hash (matching upstream —
    # the caller isn't the host, so the claim must be upstream-verified).
    mirror_upstream.get_room = AsyncMock(
        return_value=_make_upstream_audio_room(root_cast_hash="0xdeadbeefcafebabe1234")
    )
    resp = await client.post(
        "/v1/rooms/native/mirror",
        json=_mirror_body(
            farcaster_room_id="fc-room-with-chat",
            root_cast_hash="0xdeadbeefcafebabe1234",
        ),
        headers=_first_party_header(),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["cast_hash"] == "0xdeadbeefcafebabe1234"
    # And the underlying row carries the same value, not just the response.
    inserted = next(
        r
        for r in fake_db_empty.added_rooms
        if r.farcaster_room_id == "fc-room-with-chat"
    )
    assert inserted.cast_hash == "0xdeadbeefcafebabe1234"


@pytest.mark.asyncio
async def test_mirror_backfills_cast_hash_on_existing_row(client):
    """A pre-existing mirror created before this field existed (cast_hash
    is null) gets backfilled when the HOST's mirror call supplies
    ``root_cast_hash``. Existing cast_hash values are NEVER overwritten —
    they anchor the chat thread."""
    existing = Room(
        id=uuid.uuid4(),
        title="Already mirrored",
        host_fid=4242,
        status="active",
        is_farcaster_native=True,
        farcaster_room_id="fc-room-upstream-uuid",
        cast_hash=None,
    )
    session = _FakeAsyncSession(user=None, seeded_room=existing)

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        resp = await client.post(
            "/v1/rooms/native/mirror",
            json=_mirror_body(root_cast_hash="0xfeedface"),
            headers=_first_party_header(fid=4242),
        )
        assert resp.status_code == 200
        assert resp.json()["cast_hash"] == "0xfeedface"
        assert existing.cast_hash == "0xfeedface"
    finally:
        app.dependency_overrides.pop(get_db, None)


def _seed_existing_mirror(cast_hash: str | None = None) -> tuple[Room, Any]:
    existing = Room(
        id=uuid.uuid4(),
        title="Already mirrored",
        host_fid=4242,
        status="active",
        is_farcaster_native=True,
        farcaster_room_id="fc-room-upstream-uuid",
        cast_hash=cast_hash,
    )
    return existing, _FakeAsyncSession(user=None, seeded_room=existing)


@pytest.mark.asyncio
async def test_mirror_backfill_ignores_unverified_hash_from_non_host(
    client, mirror_upstream
):
    """SECURITY (M6): a non-host can't anchor the room chat to an arbitrary
    cast — the claim must match upstream's root cast hash."""
    mirror_upstream.get_room = AsyncMock(
        return_value=_make_upstream_audio_room(root_cast_hash="0x1111")
    )
    existing, session = _seed_existing_mirror()

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        resp = await client.post(
            "/v1/rooms/native/mirror",
            json=_mirror_body(root_cast_hash="0xbad0bad0"),
            headers=_first_party_header(),
        )
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert resp.status_code == 200
    assert resp.json()["cast_hash"] is None
    assert existing.cast_hash is None


@pytest.mark.asyncio
async def test_mirror_backfill_accepts_upstream_matching_hash_from_non_host(
    client, mirror_upstream
):
    mirror_upstream.get_room = AsyncMock(
        return_value=_make_upstream_audio_room(root_cast_hash="0xabcdef")
    )
    existing, session = _seed_existing_mirror()

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        resp = await client.post(
            "/v1/rooms/native/mirror",
            json=_mirror_body(root_cast_hash="0xABCDEF"),
            headers=_first_party_header(),
        )
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert resp.status_code == 200
    assert existing.cast_hash == "0xabcdef"


@pytest.mark.asyncio
async def test_mirror_backfill_skipped_when_upstream_unreachable(client):
    """No upstream service -> the non-host claim can't be verified, so the
    backfill is skipped but the idempotent mirror still succeeds."""
    existing, session = _seed_existing_mirror()
    previous = getattr(app.state, "farcaster_spaces_service", None)
    app.state.farcaster_spaces_service = None

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        resp = await client.post(
            "/v1/rooms/native/mirror",
            json=_mirror_body(root_cast_hash="0xfeedface"),
            headers=_first_party_header(),
        )
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.state.farcaster_spaces_service = previous
    assert resp.status_code == 200
    assert existing.cast_hash is None


@pytest.mark.asyncio
async def test_new_mirror_prefers_upstream_hash_over_spoofed_claim(
    client, fake_db_empty, mirror_upstream
):
    mirror_upstream.get_room = AsyncMock(
        return_value=_make_upstream_audio_room(root_cast_hash="0x2222")
    )
    resp = await client.post(
        "/v1/rooms/native/mirror",
        json=_mirror_body(root_cast_hash="0xbad0bad0"),
        headers=_first_party_header(),
    )
    assert resp.status_code == 200
    assert resp.json()["cast_hash"] == "0x2222"


@pytest.mark.asyncio
async def test_mirror_does_not_overwrite_existing_cast_hash(client):
    """If the existing row already has a cast_hash, a fresh
    ``root_cast_hash`` from a subsequent mirror call MUST NOT stomp it —
    that's the chat-thread anchor and changing it would orphan replies."""
    existing = Room(
        id=uuid.uuid4(),
        title="Already mirrored",
        host_fid=4242,
        status="active",
        is_farcaster_native=True,
        farcaster_room_id="fc-room-upstream-uuid",
        cast_hash="0xaaaaaaaaaaaaaaaa",
    )
    session = _FakeAsyncSession(user=None, seeded_room=existing)

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        resp = await client.post(
            "/v1/rooms/native/mirror",
            json=_mirror_body(root_cast_hash="0xbbbbbbbbbbbbbbbb"),
            headers=_first_party_header(),
        )
        assert resp.status_code == 200
        assert resp.json()["cast_hash"] == "0xaaaaaaaaaaaaaaaa"
        assert existing.cast_hash == "0xaaaaaaaaaaaaaaaa"
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_mirror_rejects_malformed_root_cast_hash(client, fake_db_empty):
    """The hash must be 0x-prefixed hex — the Pydantic regex catches
    obvious injection / non-hex inputs before they reach the DB column."""
    resp = await client.post(
        "/v1/rooms/native/mirror",
        json={**_mirror_body(), "root_cast_hash": "not-a-hash"},
        headers=_first_party_header(),
    )
    assert resp.status_code == 422
    assert fake_db_empty.added_rooms == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad_hash",
    [
        "0x" + "a" * 65,  # oversized (> 64 hex digits)
        "0x",  # no hex digits
        "0xzz12",  # non-hex
        "abcdef",  # missing 0x prefix
    ],
)
async def test_mirror_rejects_oversized_or_invalid_root_cast_hash(
    client, fake_db_empty, bad_hash
):
    resp = await client.post(
        "/v1/rooms/native/mirror",
        json={**_mirror_body(), "root_cast_hash": bad_hash},
        headers=_first_party_header(),
    )
    assert resp.status_code == 422
    assert fake_db_empty.added_rooms == []


def test_mirror_cast_hash_pattern_accepts_64_hex_digits():
    from app.schemas.room import MirrorNativeRoomRequest

    body = MirrorNativeRoomRequest.model_validate(
        {**_mirror_body(), "root_cast_hash": "0x" + "A" * 64}
    )
    assert body.root_cast_hash == "0x" + "A" * 64


# ---------------------------------------------------------------------
# Stage controls — native-raise-hand, native-accept-speaker,
# native-remove-speaker.
# ---------------------------------------------------------------------


@pytest.fixture
def fake_spaces_service_with_stage():
    """Mocked spaces service exposing the stage-control + stage-invite
    response methods."""
    mock_service = AsyncMock()
    mock_service.raise_hand = AsyncMock(return_value=None)
    mock_service.heartbeat = AsyncMock(return_value=None)
    mock_service.accept_speaker_as_user = AsyncMock(return_value=None)
    mock_service.remove_speaker_as_user = AsyncMock(return_value=None)
    mock_service.accept_stage_invite_as_user = AsyncMock(return_value=None)
    mock_service.decline_stage_invite_as_user = AsyncMock(return_value=None)
    previous = getattr(app.state, "farcaster_spaces_service", None)
    app.state.farcaster_spaces_service = mock_service
    try:
        yield mock_service
    finally:
        if previous is not None:
            app.state.farcaster_spaces_service = previous
        else:
            try:
                del app.state.farcaster_spaces_service
            except AttributeError:
                pass


@pytest.mark.asyncio
async def test_native_raise_hand_forwards_user_bearer(
    client, fake_db_with_native_room, fake_spaces_service_with_stage
):
    """Happy path — caller's own bearer goes to upstream raise-hand."""
    _session, room = fake_db_with_native_room
    bearer = _make_jfs_bearer(TEST_FID)
    resp = await client.post(
        f"/v1/rooms/{room.id}/native-raise-hand",
        json={"user_jfs_bearer": bearer, "raised": True},
        headers=_first_party_header(),
    )
    assert resp.status_code == 200, resp.text
    fake_spaces_service_with_stage.raise_hand.assert_awaited_once_with(
        room_id="fc-room-uuid-from-upstream",
        raised=True,
        bearer=bearer,
    )


@pytest.mark.asyncio
async def test_native_heartbeat_credits_only_signer_fid(
    client, fake_db_with_native_room, fake_spaces_service_with_stage
):
    """Happy path — heartbeat proxies upstream crediting ONLY the signer's
    own fid, regardless of any client input, resetting the inactivity timer."""
    _session, room = fake_db_with_native_room
    bearer = _make_jfs_bearer(TEST_FID)
    resp = await client.post(
        f"/v1/rooms/{room.id}/native-heartbeat",
        json={"user_jfs_bearer": bearer},
        headers=_first_party_header(),
    )
    assert resp.status_code == 200, resp.text
    fake_spaces_service_with_stage.heartbeat.assert_awaited_once_with(
        room_id="fc-room-uuid-from-upstream",
        active_speaker_fids=[TEST_FID],
        bearer=bearer,
    )


@pytest.mark.asyncio
async def test_native_heartbeat_rejects_fid_mismatch(
    client, fake_db_with_native_room, fake_spaces_service_with_stage
):
    """A bearer signed by a DIFFERENT fid than the JWT must 403 — a caller
    can't report someone else as an active speaker."""
    _session, room = fake_db_with_native_room
    bearer = _make_jfs_bearer(TEST_FID + 1)
    resp = await client.post(
        f"/v1/rooms/{room.id}/native-heartbeat",
        json={"user_jfs_bearer": bearer},
        headers=_first_party_header(),
    )
    assert resp.status_code == 403
    fake_spaces_service_with_stage.heartbeat.assert_not_awaited()


@pytest.mark.asyncio
async def test_native_raise_hand_rejects_fid_mismatch(
    client, fake_db_with_native_room, fake_spaces_service_with_stage
):
    """A bearer signed by a DIFFERENT fid than the JWT must 403 — caller
    can't raise someone else's hand."""
    _session, room = fake_db_with_native_room
    bearer = _make_jfs_bearer(TEST_FID + 1)
    resp = await client.post(
        f"/v1/rooms/{room.id}/native-raise-hand",
        json={"user_jfs_bearer": bearer, "raised": True},
        headers=_first_party_header(),
    )
    assert resp.status_code == 403
    fake_spaces_service_with_stage.raise_hand.assert_not_awaited()


@pytest.mark.asyncio
async def test_native_raise_hand_rejects_non_native_room(
    client, fake_db, fake_spaces_service_with_stage
):
    """Juke-hosted rooms must NOT route through this endpoint."""
    juke_room = Room(
        title="Juke room",
        host_fid=TEST_FID,
        status="active",
        scheduled_at=None,
        started_at=datetime.now(tz=timezone.utc),
        ended_at=None,
        livekit_room_id="lk-room-id",
        allow_agents=True,
        recording=False,
        is_farcaster_native=False,
        farcaster_room_id=None,
        metadata_={},
    )
    juke_room.id = uuid.uuid4()
    fake_db._seeded_room = juke_room
    resp = await client.post(
        f"/v1/rooms/{juke_room.id}/native-raise-hand",
        json={"user_jfs_bearer": _make_jfs_bearer(TEST_FID), "raised": True},
        headers=_first_party_header(),
    )
    assert resp.status_code == 400
    fake_spaces_service_with_stage.raise_hand.assert_not_awaited()


@pytest.mark.asyncio
async def test_native_accept_speaker_host_only(
    client,
    fake_db_with_native_room_other_host,
    fake_spaces_service_with_stage,
):
    """The caller is NOT the recorded host (room.host_fid = TEST_FID+1
    while JWT fid = TEST_FID), so accept-speaker must 403 before any
    upstream call."""
    _session, room = fake_db_with_native_room_other_host
    resp = await client.post(
        f"/v1/rooms/{room.id}/native-accept-speaker",
        json={
            "user_jfs_bearer": _make_jfs_bearer(TEST_FID),
            "target_fid": 4242,
        },
        headers=_first_party_header(),
    )
    assert resp.status_code == 403
    fake_spaces_service_with_stage.accept_speaker_as_user.assert_not_awaited()


@pytest.mark.asyncio
async def test_native_accept_speaker_happy_path(
    client, fake_db_with_native_room, fake_spaces_service_with_stage
):
    """Host calls accept-speaker for a target — bearer forwarded
    verbatim, target_fid passed through."""
    _session, room = fake_db_with_native_room
    bearer = _make_jfs_bearer(TEST_FID)
    resp = await client.post(
        f"/v1/rooms/{room.id}/native-accept-speaker",
        json={"user_jfs_bearer": bearer, "target_fid": 4242},
        headers=_first_party_header(),
    )
    assert resp.status_code == 200, resp.text
    fake_spaces_service_with_stage.accept_speaker_as_user.assert_awaited_once_with(
        room_id="fc-room-uuid-from-upstream",
        target_fid=4242,
        bearer=bearer,
    )


@pytest.mark.asyncio
async def test_native_remove_speaker_happy_path(
    client, fake_db_with_native_room, fake_spaces_service_with_stage
):
    """Host calls remove-speaker for a target — same posture as accept."""
    _session, room = fake_db_with_native_room
    bearer = _make_jfs_bearer(TEST_FID)
    resp = await client.post(
        f"/v1/rooms/{room.id}/native-remove-speaker",
        json={"user_jfs_bearer": bearer, "target_fid": 4242},
        headers=_first_party_header(),
    )
    assert resp.status_code == 200, resp.text
    fake_spaces_service_with_stage.remove_speaker_as_user.assert_awaited_once_with(
        room_id="fc-room-uuid-from-upstream",
        target_fid=4242,
        bearer=bearer,
    )


@pytest.mark.asyncio
async def test_native_remove_speaker_host_only(
    client,
    fake_db_with_native_room_other_host,
    fake_spaces_service_with_stage,
):
    """Same host-only gate as accept-speaker — non-host must 403."""
    _session, room = fake_db_with_native_room_other_host
    resp = await client.post(
        f"/v1/rooms/{room.id}/native-remove-speaker",
        json={
            "user_jfs_bearer": _make_jfs_bearer(TEST_FID),
            "target_fid": 4242,
        },
        headers=_first_party_header(),
    )
    assert resp.status_code == 403
    fake_spaces_service_with_stage.remove_speaker_as_user.assert_not_awaited()


@pytest.mark.asyncio
async def test_native_stage_endpoints_reject_partner_jwt(
    client, fake_db_with_native_room, fake_spaces_service_with_stage
):
    """Partner-minted JWTs must NOT be able to control the stage on a
    user's behalf — same posture as create / join / end."""
    _session, room = fake_db_with_native_room
    bearer = _make_jfs_bearer(TEST_FID)
    for path, payload in (
        ("native-raise-hand", {"user_jfs_bearer": bearer, "raised": True}),
        (
            "native-accept-speaker",
            {"user_jfs_bearer": bearer, "target_fid": 4242},
        ),
        (
            "native-remove-speaker",
            {"user_jfs_bearer": bearer, "target_fid": 4242},
        ),
    ):
        resp = await client.post(
            f"/v1/rooms/{room.id}/{path}",
            json=payload,
            headers=_partner_header(),
        )
        assert resp.status_code == 401, (path, resp.text)
    fake_spaces_service_with_stage.raise_hand.assert_not_awaited()
    fake_spaces_service_with_stage.accept_speaker_as_user.assert_not_awaited()
    fake_spaces_service_with_stage.remove_speaker_as_user.assert_not_awaited()


# ---------------------------------------------------------------------
# Stage-invite responses — native-accept-stage-invite, native-decline-
# stage-invite (the invitee's response to a host's promote-to-speaker).
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_native_accept_stage_invite_forwards_bearer(
    client, fake_db_with_native_room, fake_spaces_service_with_stage
):
    """Happy path — invitee's own bearer goes to upstream
    accept-stage-invite."""
    _session, room = fake_db_with_native_room
    bearer = _make_jfs_bearer(TEST_FID)
    resp = await client.post(
        f"/v1/rooms/{room.id}/native-accept-stage-invite",
        json={"user_jfs_bearer": bearer},
        headers=_first_party_header(),
    )
    assert resp.status_code == 200, resp.text
    fake_spaces_service_with_stage.accept_stage_invite_as_user.assert_awaited_once_with(
        room_id="fc-room-uuid-from-upstream",
        bearer=bearer,
    )


@pytest.mark.asyncio
async def test_native_decline_stage_invite_forwards_bearer(
    client, fake_db_with_native_room, fake_spaces_service_with_stage
):
    """Happy path — invitee's own bearer goes to upstream
    decline-stage-invite."""
    _session, room = fake_db_with_native_room
    bearer = _make_jfs_bearer(TEST_FID)
    resp = await client.post(
        f"/v1/rooms/{room.id}/native-decline-stage-invite",
        json={"user_jfs_bearer": bearer},
        headers=_first_party_header(),
    )
    assert resp.status_code == 200, resp.text
    fake_spaces_service_with_stage.decline_stage_invite_as_user.assert_awaited_once_with(
        room_id="fc-room-uuid-from-upstream",
        bearer=bearer,
    )


@pytest.mark.asyncio
async def test_native_stage_invite_response_rejects_fid_mismatch(
    client, fake_db_with_native_room, fake_spaces_service_with_stage
):
    """A bearer signed by a DIFFERENT fid than the JWT must 403 on
    both accept and decline — only the actual invitee can respond."""
    _session, room = fake_db_with_native_room
    bearer = _make_jfs_bearer(TEST_FID + 1)
    for path in (
        "native-accept-stage-invite",
        "native-decline-stage-invite",
    ):
        resp = await client.post(
            f"/v1/rooms/{room.id}/{path}",
            json={"user_jfs_bearer": bearer},
            headers=_first_party_header(),
        )
        assert resp.status_code == 403, (path, resp.text)
    fake_spaces_service_with_stage.accept_stage_invite_as_user.assert_not_awaited()
    fake_spaces_service_with_stage.decline_stage_invite_as_user.assert_not_awaited()


@pytest.mark.asyncio
async def test_native_stage_invite_response_rejects_partner_jwt(
    client, fake_db_with_native_room, fake_spaces_service_with_stage
):
    """Partner JWTs must not be able to accept/decline invites on
    a user's behalf."""
    _session, room = fake_db_with_native_room
    bearer = _make_jfs_bearer(TEST_FID)
    for path in (
        "native-accept-stage-invite",
        "native-decline-stage-invite",
    ):
        resp = await client.post(
            f"/v1/rooms/{room.id}/{path}",
            json={"user_jfs_bearer": bearer},
            headers=_partner_header(),
        )
        assert resp.status_code == 401, (path, resp.text)
    fake_spaces_service_with_stage.accept_stage_invite_as_user.assert_not_awaited()
    fake_spaces_service_with_stage.decline_stage_invite_as_user.assert_not_awaited()


@pytest.mark.asyncio
async def test_native_accept_stage_invite_invalidates_participants_cache(
    client, fake_db_with_native_room, fake_spaces_service_with_stage
):
    """After a successful upstream accept, the participants cache for
    this room MUST be dropped so the iOS poll sees the post-accept
    state on the next tick instead of waiting for the TTL to expire."""
    from unittest.mock import AsyncMock, patch

    _session, room = fake_db_with_native_room
    bearer = _make_jfs_bearer(TEST_FID)
    inv_mock = AsyncMock(return_value=None)
    with patch("app.routers.rooms.invalidate_participants_cache", inv_mock):
        resp = await client.post(
            f"/v1/rooms/{room.id}/native-accept-stage-invite",
            json={"user_jfs_bearer": bearer},
            headers=_first_party_header(),
        )
    assert resp.status_code == 200, resp.text
    inv_mock.assert_awaited_once()
    # First positional arg is the redis client; second is the upstream
    # room id (the Farcaster UUID, NOT the Juke UUID).
    _redis_arg, room_id_arg = inv_mock.await_args.args
    assert room_id_arg == "fc-room-uuid-from-upstream"


@pytest.mark.asyncio
async def test_native_decline_stage_invite_invalidates_participants_cache(
    client, fake_db_with_native_room, fake_spaces_service_with_stage
):
    """Mirror of the accept-cache-invalidation test for the decline path."""
    from unittest.mock import AsyncMock, patch

    _session, room = fake_db_with_native_room
    bearer = _make_jfs_bearer(TEST_FID)
    inv_mock = AsyncMock(return_value=None)
    with patch("app.routers.rooms.invalidate_participants_cache", inv_mock):
        resp = await client.post(
            f"/v1/rooms/{room.id}/native-decline-stage-invite",
            json={"user_jfs_bearer": bearer},
            headers=_first_party_header(),
        )
    assert resp.status_code == 200, resp.text
    inv_mock.assert_awaited_once()
    _redis_arg, room_id_arg = inv_mock.await_args.args
    assert room_id_arg == "fc-room-uuid-from-upstream"


# ---------------------------------------------------------------------
# Auto-stop recording when host ends the space
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_end_native_room_auto_stops_active_recording(
    client, fake_spaces_service_with_end
):
    """Host ends the space WITH an active recording. The end handler
    should stop the recording BEFORE calling upstream end so the
    worker can finalize ffmpeg + S3 while LiveKit's still alive — then
    proceed with the normal end flow."""
    from unittest.mock import AsyncMock

    # Build a room flagged as actively recording.
    room = _make_active_native_room(host_mode="user_fid")
    room.recording = True
    room.recording_id = "rec-id-deadbeef"
    session = _FakeAsyncSession(_make_user(), seeded_room=room)

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override

    # Install a recording-agent mock on app.state.
    rec_mock = AsyncMock()
    rec_mock.stop_recording = AsyncMock(
        return_value="https://s3.example.com/recordings/rec.ogg"
    )
    previous_rec = getattr(app.state, "recording_agent_service", None)
    app.state.recording_agent_service = rec_mock

    try:
        resp = await client.post(
            f"/v1/rooms/{room.id}/end",
            json={"user_jfs_bearer": _make_jfs_bearer(TEST_FID)},
            headers=_first_party_header(),
        )
        # End flow succeeded — host's space is closed and recording
        # was finalized in the same call.
        assert resp.status_code == 200, resp.text
        # The recording stop was attempted before the upstream end.
        rec_mock.stop_recording.assert_called_once()
        # Upstream end was also called.
        fake_spaces_service_with_end.end_audio_room.assert_awaited_once()
    finally:
        app.dependency_overrides.pop(get_db, None)
        if previous_rec is not None:
            app.state.recording_agent_service = previous_rec
        else:
            try:
                del app.state.recording_agent_service
            except AttributeError:
                pass


@pytest.mark.asyncio
async def test_end_native_room_continues_when_auto_stop_fails(
    client, fake_spaces_service_with_end
):
    """A failing recording stop must NOT block ending the space — the
    host's primary intent is to end the space; a stuck worker is a
    secondary concern. Log the failure and continue with the end."""
    from unittest.mock import AsyncMock

    room = _make_active_native_room(host_mode="user_fid")
    room.recording = True
    room.recording_id = "rec-id-cafebabe"
    session = _FakeAsyncSession(_make_user(), seeded_room=room)

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override

    rec_mock = AsyncMock()
    rec_mock.stop_recording = AsyncMock(side_effect=RuntimeError("worker died"))
    previous_rec = getattr(app.state, "recording_agent_service", None)
    app.state.recording_agent_service = rec_mock

    try:
        resp = await client.post(
            f"/v1/rooms/{room.id}/end",
            json={"user_jfs_bearer": _make_jfs_bearer(TEST_FID)},
            headers=_first_party_header(),
        )
        # End flow still succeeded despite the recording stop failure.
        assert resp.status_code == 200, resp.text
        # Recording stop was attempted.
        rec_mock.stop_recording.assert_called_once()
        # Upstream end ran anyway — host's space IS closed.
        fake_spaces_service_with_end.end_audio_room.assert_awaited_once()
    finally:
        app.dependency_overrides.pop(get_db, None)
        if previous_rec is not None:
            app.state.recording_agent_service = previous_rec
        else:
            try:
                del app.state.recording_agent_service
            except AttributeError:
                pass


# ---------------------------------------------------------------------
# POST /v1/rooms/{id}/native-start — go live on a scheduled
# Farcaster-native room (cross-platform scheduling).
# ---------------------------------------------------------------------


def _make_scheduled_native_room(
    *,
    host_fid: int = TEST_FID,
    host_mode: str = "service_fid",
) -> Room:
    """A scheduled (not-yet-live) Farcaster-native room row. ``started_at``
    is ``None`` until the host goes live via ``native-start``."""
    room = _make_active_native_room(host_fid=host_fid, host_mode=host_mode)
    room.status = "scheduled"
    room.started_at = None
    room.scheduled_at = datetime.now(tz=timezone.utc) + timedelta(hours=2)
    return room


@pytest.fixture
def fake_spaces_service_with_start():
    """``fake_spaces_service`` variant that also mocks
    ``start_scheduled_audio_room`` (the upstream go-live call)."""
    mock_service = AsyncMock()
    mock_service.start_scheduled_audio_room = AsyncMock(return_value=None)
    previous = getattr(app.state, "farcaster_spaces_service", None)
    app.state.farcaster_spaces_service = mock_service
    try:
        yield mock_service
    finally:
        if previous is not None:
            app.state.farcaster_spaces_service = previous
        else:
            try:
                del app.state.farcaster_spaces_service
            except AttributeError:
                pass


def _seed_room(room: Room):
    session = _FakeAsyncSession(_make_user(), seeded_room=room)

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    return session


@pytest.mark.asyncio
async def test_native_start_service_fid_goes_live(
    client, fake_spaces_service_with_start
):
    """Service-FID hosted scheduled room: host goes live with no bearer;
    upstream start dispatched via the service bearer, Juke row flips to
    active with ``started_at`` stamped."""
    room = _make_scheduled_native_room(host_mode="service_fid")
    session = _seed_room(room)
    try:
        resp = await client.post(
            f"/v1/rooms/{room.id}/native-start",
            headers=_first_party_header(),
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "active"
        assert body["is_farcaster_native"] is True
        assert body["started_at"]  # non-empty ISO timestamp
        fake_spaces_service_with_start.start_scheduled_audio_room.assert_awaited_once_with(
            "fc-room-uuid-from-upstream", bearer=None
        )
        assert room.status == "active"
        assert room.started_at is not None
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_native_start_user_fid_requires_bearer(
    client, fake_spaces_service_with_start
):
    """User-FID hosted room: missing ``user_jfs_bearer`` → 400, no
    upstream call."""
    room = _make_scheduled_native_room(host_mode="user_fid")
    _seed_room(room)
    try:
        resp = await client.post(
            f"/v1/rooms/{room.id}/native-start",
            headers=_first_party_header(),
        )
        assert resp.status_code == 400
        assert "user_jfs_bearer" in resp.json()["detail"]
        fake_spaces_service_with_start.start_scheduled_audio_room.assert_not_awaited()
        assert room.status == "scheduled"
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_native_start_user_fid_forwards_bearer(
    client, fake_spaces_service_with_start
):
    """User-FID hosted room: a matching bearer is forwarded verbatim to
    the upstream start call."""
    room = _make_scheduled_native_room(host_mode="user_fid")
    _seed_room(room)
    bearer = _make_jfs_bearer(TEST_FID)
    try:
        resp = await client.post(
            f"/v1/rooms/{room.id}/native-start",
            json={"user_jfs_bearer": bearer},
            headers=_first_party_header(),
        )
        assert resp.status_code == 200, resp.text
        fake_spaces_service_with_start.start_scheduled_audio_room.assert_awaited_once_with(
            "fc-room-uuid-from-upstream", bearer=bearer
        )
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_native_start_user_fid_bearer_mismatch_rejected(
    client, fake_spaces_service_with_start
):
    """A bearer signed by a different FID than the caller's JWT → 403,
    no upstream call (mirrors the create / end gate)."""
    room = _make_scheduled_native_room(host_mode="user_fid")
    _seed_room(room)
    bearer = _make_jfs_bearer(TEST_FID + 1)
    try:
        resp = await client.post(
            f"/v1/rooms/{room.id}/native-start",
            json={"user_jfs_bearer": bearer},
            headers=_first_party_header(),
        )
        assert resp.status_code == 403
        assert "fid" in resp.json()["detail"].lower()
        fake_spaces_service_with_start.start_scheduled_audio_room.assert_not_awaited()
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_native_start_non_host_rejected(client, fake_spaces_service_with_start):
    """Only the recorded host can go live."""
    room = _make_scheduled_native_room(host_fid=TEST_FID + 1)
    _seed_room(room)
    try:
        resp = await client.post(
            f"/v1/rooms/{room.id}/native-start",
            headers=_first_party_header(),
        )
        assert resp.status_code == 403
        fake_spaces_service_with_start.start_scheduled_audio_room.assert_not_awaited()
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_native_start_rejects_non_native_room(
    client, fake_spaces_service_with_start
):
    """A Juke-hosted scheduled room must go live via
    ``/v1/rooms/{id}/start``, not this endpoint."""
    room = _make_scheduled_native_room()
    room.is_farcaster_native = False
    _seed_room(room)
    try:
        resp = await client.post(
            f"/v1/rooms/{room.id}/native-start",
            headers=_first_party_header(),
        )
        assert resp.status_code == 400
        assert "native" in resp.json()["detail"].lower()
        fake_spaces_service_with_start.start_scheduled_audio_room.assert_not_awaited()
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_native_start_already_active_is_idempotent(
    client, fake_spaces_service_with_start
):
    """Going live on an already-active room returns 200 with no upstream
    call (handles a double-tap)."""
    room = _make_active_native_room()  # status="active"
    _seed_room(room)
    try:
        resp = await client.post(
            f"/v1/rooms/{room.id}/native-start",
            headers=_first_party_header(),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "active"
        fake_spaces_service_with_start.start_scheduled_audio_room.assert_not_awaited()
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_native_start_upstream_failure_keeps_scheduled(
    client, fake_spaces_service_with_start
):
    """Upstream start failure → 502; the Juke row stays ``scheduled`` so a
    client retry is meaningful."""
    import httpx

    fake_spaces_service_with_start.start_scheduled_audio_room.side_effect = (
        httpx.ConnectError("upstream gone")
    )
    room = _make_scheduled_native_room(host_mode="service_fid")
    _seed_room(room)
    try:
        resp = await client.post(
            f"/v1/rooms/{room.id}/native-start",
            headers=_first_party_header(),
        )
        assert resp.status_code == 502
        assert "Couldn't start on Farcaster" in resp.json()["detail"]
        assert room.status == "scheduled"
        assert room.started_at is None
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.asyncio
async def test_native_start_upstream_4xx_maps_to_400(
    client, fake_spaces_service_with_start
):
    """An upstream 4xx (permanent rejection — e.g. not the host, not in
    scheduled state) maps to 400, NOT 502, so the client stops instead of
    hammering a doomed retry. The Juke row stays ``scheduled``."""
    import httpx

    req = httpx.Request(
        "POST", "https://client.farcaster.xyz/v1/audio-room/start-scheduled"
    )
    resp_upstream = httpx.Response(
        403, request=req, json={"errors": [{"message": "not host"}]}
    )
    fake_spaces_service_with_start.start_scheduled_audio_room.side_effect = (
        httpx.HTTPStatusError("rejected", request=req, response=resp_upstream)
    )
    room = _make_scheduled_native_room(host_mode="service_fid")
    _seed_room(room)
    try:
        resp = await client.post(
            f"/v1/rooms/{room.id}/native-start",
            headers=_first_party_header(),
        )
        assert resp.status_code == 400
        assert "Couldn't start on Farcaster" in resp.json()["detail"]
        assert room.status == "scheduled"
        assert room.started_at is None
    finally:
        app.dependency_overrides.pop(get_db, None)


# ---------------------------------------------------------------------
# list_active_rooms — DB-authoritative union for native active rooms.
#
# create_native_room's redis.add_active_room is best-effort: a miss is
# swallowed, so a genuinely status='active' native Room row can be absent
# from the Redis active sorted-set. list_active_rooms must still surface
# it (the DB is the source of truth for native actives), otherwise
# web-created native spaces vanish from /v1/rooms?status=active.
# ---------------------------------------------------------------------


class _ListScalarsResult:
    def __init__(self, items: list[Any]):
        self._items = items

    def all(self) -> list[Any]:
        return list(self._items)


class _ListExecuteResult:
    def __init__(self, items: list[Any]):
        self._items = items

    def scalars(self) -> _ListScalarsResult:
        return _ListScalarsResult(self._items)


class _QueuedDb:
    """AsyncSession stand-in that returns queued ``scalars().all()`` lists
    in call order. The list_active_rooms flow issues, in order:

      1. select(Room).where(id.in_(page_uuids))   — Redis page rooms
      2. select(User).where(fid.in_(host_fids))    — hosts for #1
      3. select(Room)...is_farcaster_native...     — DB native actives
      4. select(User).where(fid.in_(extra_fids))   — hosts for #3
    """

    def __init__(self, results: list[list[Any]]):
        self._results = list(results)
        self.calls = 0

    async def execute(self, _stmt: Any) -> _ListExecuteResult:
        items = self._results[self.calls] if self.calls < len(self._results) else []
        self.calls += 1
        return _ListExecuteResult(items)


class _ListFakeRedis:
    """RedisService stand-in exposing only what list_active_rooms needs.

    Deliberately has NO ``redis`` attribute so
    ``_get_anonymous_listener_count`` hits its ``AttributeError`` guard
    and returns 0 without touching a real pipeline.
    """

    def __init__(self, active_ids: list[str], counts: dict[str, tuple[int, int]]):
        self._active_ids = active_ids
        self._counts = counts

    async def get_active_rooms(self, limit: int = 20, offset: int = 0) -> list[str]:
        return self._active_ids[offset : offset + limit]

    async def get_room_participant_counts(
        self, room_ids: list[str]
    ) -> dict[str, tuple[int, int]]:
        return {rid: self._counts.get(rid, (0, 0)) for rid in room_ids}


def _make_web_native_active_room(*, host_fid: int = TEST_FID) -> Room:
    room = Room(
        title="Web native space",
        host_fid=host_fid,
        status="active",
        started_at=datetime.now(tz=timezone.utc) - timedelta(minutes=5),
        ended_at=None,
        livekit_room_id=None,
        allow_agents=False,
        recording=False,
        recording_id=None,
        is_farcaster_native=True,
        farcaster_room_id="fc-web-room",
        metadata_={"source": "backend-orchestrated"},
    )
    room.id = uuid.uuid4()
    return room


@pytest.mark.asyncio
async def test_list_active_unions_db_native_missing_from_redis():
    """A native active row absent from the Redis active set (add_active_room
    miss) still appears in list_active_rooms via the DB union."""
    from app.services.room_service import RoomService

    native = _make_web_native_active_room()
    host = _make_user(fid=native.host_fid)

    # Redis knows about NO active rooms — models the best-effort miss.
    redis = _ListFakeRedis(active_ids=[], counts={})
    # DB queue: (1) page rooms empty, (2) page hosts empty,
    # (3) DB native actives = [native], (4) extra hosts = [host].
    db = _QueuedDb([[], [], [native], [host]])

    service = RoomService(db, redis, AsyncMock())
    result = await service.list_active_rooms(limit=20, cursor=0)

    ids = [r.id for r in result.rooms]
    assert str(native.id) in ids
    surfaced = next(r for r in result.rooms if r.id == str(native.id))
    assert surfaced.is_farcaster_native is True
    assert surfaced.status == "active"
    assert result.next_cursor is None


@pytest.mark.asyncio
async def test_list_active_dedupes_native_already_in_redis():
    """A native active row already present in the Redis page must NOT be
    duplicated by the DB union."""
    from app.services.room_service import RoomService

    native = _make_web_native_active_room()
    host = _make_user(fid=native.host_fid)
    rid = str(native.id)

    redis = _ListFakeRedis(active_ids=[rid], counts={rid: (1, 2)})
    # (1) page rooms = [native], (2) page hosts = [host],
    # (3) DB native actives also returns [native] (same row),
    # (4) extra hosts (unused since deduped, but keep queue aligned).
    db = _QueuedDb([[native], [host], [native], [host]])

    service = RoomService(db, redis, AsyncMock())
    result = await service.list_active_rooms(limit=20, cursor=0)

    ids = [r.id for r in result.rooms]
    assert ids.count(rid) == 1


@pytest.mark.asyncio
async def test_list_active_skips_db_union_on_later_pages():
    """The DB union only runs on the first page (cursor == 0) so the
    Redis cursor contract is preserved for pagination."""
    from app.services.room_service import RoomService

    native = _make_web_native_active_room()
    host = _make_user(fid=native.host_fid)

    redis = _ListFakeRedis(active_ids=[], counts={})
    # Only the Redis-page queries fire; the union block is skipped so the
    # native-actives query (index 2) is never reached.
    db = _QueuedDb([[], [], [native], [host]])

    service = RoomService(db, redis, AsyncMock())
    result = await service.list_active_rooms(limit=20, cursor=20)

    assert result.rooms == []
    # Only the two Redis-page queries ran — union skipped on later pages.
    assert db.calls == 2
