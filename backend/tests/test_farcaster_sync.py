"""Tests for the Farcaster sync opt-in router.

The bearer secret obtained via the Warpcast handshake never reaches the
backend — these tests document that contract: ``LinkRequest`` rejects
any field other than ``fid``, and the persisted state is just the flag
+ fid + timestamp.
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest
from jose import jwt

from app.config import settings
from app.dependencies import get_db
from app.main import app
from app.models.user import User
from app.routers.farcaster_sync import LINK_RATE_LIMIT_PER_MIN

TEST_FID = 7777


def _auth_header(fid: int = TEST_FID) -> dict[str, str]:
    token = jwt.encode(
        {"fid": fid, "exp": 4_102_444_800},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


def _make_user(fid: int = TEST_FID, **overrides) -> User:
    """Build an in-memory User row that the router code can mutate."""
    user = User(
        fid=fid,
        signer_uuid="test-signer",
        username="tester",
        display_name="Tester",
        is_admin=False,
        is_agent=False,
        developer_access_status="none",
        farcaster_fid=overrides.get("farcaster_fid"),
        farcaster_sync_enabled=overrides.get("farcaster_sync_enabled", False),
        farcaster_sync_linked_at=overrides.get("farcaster_sync_linked_at"),
    )
    return user


class _FakeAsyncSession:
    """Minimal AsyncSession stand-in for sync-router tests.

    Holds a single User row keyed by fid. ``execute`` only needs to
    answer ``select(User).where(User.fid == fid)`` — every other branch
    in this router runs against the in-memory ``user`` reference, so
    commit/refresh are no-ops.
    """

    def __init__(self, user: User | None):
        self._user = user
        self.commit_count = 0

    async def execute(self, _stmt):
        user = self._user

        class _Result:
            def scalar_one_or_none(self_inner):
                return user

        return _Result()

    def add(self, user):  # pragma: no cover - unused by this router
        self._user = user

    async def commit(self):
        self.commit_count += 1

    async def refresh(self, _user):
        return None


@pytest.fixture
def fake_db():
    """Override get_db with an in-memory fake holding one user row."""
    session = _FakeAsyncSession(_make_user())

    async def _override():
        yield session

    app.dependency_overrides[get_db] = _override
    try:
        yield session
    finally:
        app.dependency_overrides.pop(get_db, None)


# ---------------------------------------------------------------------
# POST /v1/farcaster-sync/link
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_link_sets_fid_and_flag(client, fake_db):
    resp = await client.post(
        "/v1/farcaster-sync/link",
        json={"fid": TEST_FID},
        headers=_auth_header(),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["enabled"] is True
    assert body["fid"] == TEST_FID
    assert body["linked_at"] is not None

    user = fake_db._user
    assert user.farcaster_fid == TEST_FID
    assert user.farcaster_sync_enabled is True
    assert isinstance(user.farcaster_sync_linked_at, datetime)


@pytest.mark.asyncio
async def test_link_rejects_fid_other_than_signed_in_user(client, fake_db):
    """SECURITY (M5): the linked Farcaster fid used to be self-attested,
    letting a user claim another account's upstream spaces. It must now
    equal the authenticated fid."""
    resp = await client.post(
        "/v1/farcaster-sync/link",
        json={"fid": 12345},
        headers=_auth_header(),
    )
    assert resp.status_code == 403
    assert fake_db._user.farcaster_fid is None
    assert fake_db._user.farcaster_sync_enabled is not True


@pytest.mark.asyncio
async def test_link_repairs_previously_self_attested_fid(client, fake_db):
    """A row linked to a foreign fid before the fix is rewritten to the
    caller's own fid on the next link."""
    fake_db._user = _make_user(
        farcaster_fid=11111,
        farcaster_sync_enabled=True,
        farcaster_sync_linked_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
    )

    resp = await client.post(
        "/v1/farcaster-sync/link",
        json={"fid": TEST_FID},
        headers=_auth_header(),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["fid"] == TEST_FID
    assert body["enabled"] is True
    assert fake_db._user.farcaster_fid == TEST_FID


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid_fid", [0, -1, 10_000_001, 999_999_999])
async def test_link_rejects_invalid_fid(client, fake_db, invalid_fid):
    resp = await client.post(
        "/v1/farcaster-sync/link",
        json={"fid": invalid_fid},
        headers=_auth_header(),
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_link_rejects_extra_fields(client, fake_db):
    """Schema-level defense: a future regression that tries to send
    the Warpcast bearer secret in the body must 422 before the
    router runs."""
    resp = await client.post(
        "/v1/farcaster-sync/link",
        json={"fid": 12345, "secret": "warpcast-bearer-xyz"},
        headers=_auth_header(),
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_link_requires_auth(client, fake_db):
    resp = await client.post("/v1/farcaster-sync/link", json={"fid": 12345})
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_link_with_invalid_jwt_returns_401(client, fake_db):
    resp = await client.post(
        "/v1/farcaster-sync/link",
        json={"fid": 12345},
        headers={"Authorization": "Bearer not-a-jwt"},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_link_rejects_partner_minted_jwt(client, fake_db):
    """Partner-minted JWTs (source="partner") must not be able to
    silently link a user's Warpcast account — that's account-state
    mutation a third-party app should never perform on the user's
    behalf, even with a valid token."""
    partner_token = jwt.encode(
        {"fid": TEST_FID, "exp": 4_102_444_800, "source": "partner"},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    resp = await client.post(
        "/v1/farcaster-sync/link",
        json={"fid": 12345},
        headers={"Authorization": f"Bearer {partner_token}"},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_delete_rejects_partner_minted_jwt(client, fake_db):
    """Mirror of the link-side check: partner JWTs can't revoke
    a user's Warpcast linkage either."""
    partner_token = jwt.encode(
        {"fid": TEST_FID, "exp": 4_102_444_800, "source": "partner"},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    resp = await client.delete(
        "/v1/farcaster-sync",
        headers={"Authorization": f"Bearer {partner_token}"},
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------
# GET /v1/farcaster-sync
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_status_unlinked(client, fake_db):
    resp = await client.get("/v1/farcaster-sync", headers=_auth_header())
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body == {"enabled": False, "fid": None, "linked_at": None}


@pytest.mark.asyncio
async def test_get_status_linked(client, fake_db):
    linked_at = datetime(2026, 5, 30, 12, 0, tzinfo=timezone.utc)
    fake_db._user = _make_user(
        farcaster_fid=4242,
        farcaster_sync_enabled=True,
        farcaster_sync_linked_at=linked_at,
    )

    resp = await client.get("/v1/farcaster-sync", headers=_auth_header())
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["enabled"] is True
    assert body["fid"] == 4242
    assert body["linked_at"] is not None


@pytest.mark.asyncio
async def test_get_status_requires_auth(client, fake_db):
    resp = await client.get("/v1/farcaster-sync")
    assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------
# DELETE /v1/farcaster-sync
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_clears_fields(client, fake_db):
    fake_db._user = _make_user(
        farcaster_fid=4242,
        farcaster_sync_enabled=True,
        farcaster_sync_linked_at=datetime.now(timezone.utc),
    )

    resp = await client.delete("/v1/farcaster-sync", headers=_auth_header())
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body == {"enabled": False, "fid": None, "linked_at": None}
    assert fake_db._user.farcaster_fid is None
    assert fake_db._user.farcaster_sync_enabled is False
    assert fake_db._user.farcaster_sync_linked_at is None

    # GET after DELETE confirms cleared.
    status_resp = await client.get("/v1/farcaster-sync", headers=_auth_header())
    assert status_resp.status_code == 200
    assert status_resp.json()["enabled"] is False
    assert status_resp.json()["fid"] is None


@pytest.mark.asyncio
async def test_delete_requires_auth(client, fake_db):
    resp = await client.delete("/v1/farcaster-sync")
    assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_link_rate_limit(client, fake_db):
    """N+1th link call within the window returns 429 with Retry-After."""
    pipe = MagicMock()
    pipe.incr = MagicMock()
    pipe.expire = MagicMock()
    pipe.execute = AsyncMock(return_value=[LINK_RATE_LIMIT_PER_MIN + 1, True])
    app.state.redis.pipeline = MagicMock(return_value=pipe)

    resp = await client.post(
        "/v1/farcaster-sync/link",
        json={"fid": 12345},
        headers=_auth_header(),
    )
    assert resp.status_code == 429
    assert resp.headers.get("retry-after") == "60"
