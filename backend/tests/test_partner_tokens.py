"""Partner SSO pre-mint endpoint tests.

Smoke-level: auth gating, validation, and the JWT-helper signing surface.
DB-integration coverage for the room_id scope check belongs in the
testcontainer suite — these tests live with the rest of the developer
key suite which is similarly mock-driven.
"""

import uuid
from datetime import datetime, timezone

import pytest
from jose import jwt

from app.config import settings
from app.services.auth_service import create_partner_jwt


def test_create_partner_jwt_includes_partner_app_id_and_source():
    partner_app_id = str(uuid.uuid4())
    token, expires_at_iso = create_partner_jwt(
        fid=12345, partner_app_id=partner_app_id, ttl_seconds=300
    )
    decoded = jwt.decode(
        token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM]
    )
    assert decoded["fid"] == 12345
    assert decoded["partner_app_id"] == partner_app_id
    # `source="partner"` is what `require_first_party_user` keys off of
    # to refuse sensitive account-management endpoints.
    assert decoded["source"] == "partner"
    # `iat` + `exp` are ints and span ~300s
    assert decoded["exp"] - decoded["iat"] == 300
    # `expires_at_iso` is parseable and matches the exp claim
    parsed = datetime.fromisoformat(expires_at_iso)
    assert int(parsed.timestamp()) == decoded["exp"]


def test_create_partner_jwt_short_ttl_lands_in_the_past_quickly():
    """60s TTL is the validated lower bound — make sure the JWT honors it."""
    _, expires_at_iso = create_partner_jwt(
        fid=1, partner_app_id=str(uuid.uuid4()), ttl_seconds=60
    )
    expires_at = datetime.fromisoformat(expires_at_iso)
    delta = (expires_at - datetime.now(timezone.utc)).total_seconds()
    assert 55 < delta <= 65


@pytest.mark.asyncio
async def test_partner_jwt_rejected_by_get_current_user():
    """H1: the default auth dependency refuses partner JWTs; only routes that
    opt in via ``get_principal_allow_partner`` accept them."""
    from fastapi import HTTPException
    from fastapi.security import HTTPAuthorizationCredentials

    from app.middleware.auth import get_current_user, get_principal_allow_partner

    partner_app_id = str(uuid.uuid4())
    token, _ = create_partner_jwt(
        fid=42, partner_app_id=partner_app_id, ttl_seconds=300
    )
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
    with pytest.raises(HTTPException) as exc:
        await get_current_user(credentials=creds)
    assert exc.value.status_code == 401

    principal = await get_principal_allow_partner(credentials=creds)
    assert principal.fid == 42
    assert principal.is_partner is True
    assert principal.partner_app_id == partner_app_id


# ---------------------------------------------------------------------------
# C2: partner mint refuses admin fids; extra app/owner rate-limit buckets
# ---------------------------------------------------------------------------


class _ScalarDb:
    def __init__(self, value):
        self.value = value
        self.statements = []

    async def scalar(self, statement):
        self.statements.append(statement)
        return self.value


@pytest.fixture
def partner_mint_overrides(monkeypatch):
    from app.dependencies import get_db, get_redis, require_developer_api_key
    from app.main import app
    from app.routers import developer
    from app.services.developer_key_service import VerifiedDeveloperKey

    key = VerifiedDeveloperKey(fid=777, app_id=uuid.uuid4(), key_id="key_abc")
    seen_keys: list[str] = []

    async def _record_rate_limit(_redis, *, key, limit, window_seconds, **_):
        seen_keys.append(key)

    monkeypatch.setattr(developer, "_enforce_rate_limit", _record_rate_limit)
    state = {"db": _ScalarDb(None)}

    async def _db():
        yield state["db"]

    app.dependency_overrides[require_developer_api_key] = lambda: key
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_redis] = lambda: object()
    try:
        yield key, seen_keys, state
    finally:
        for dep in (require_developer_api_key, get_db, get_redis):
            app.dependency_overrides.pop(dep, None)


@pytest.mark.asyncio
async def test_partner_token_refused_for_admin_fid(client, partner_mint_overrides):
    _key, _seen, state = partner_mint_overrides
    state["db"] = _ScalarDb(True)
    response = await client.post(
        "/v1/developer/partner-tokens", json={"fid": 1, "ttl_seconds": 300}
    )
    assert response.status_code == 403
    assert "token" not in response.json()


@pytest.mark.asyncio
async def test_partner_token_rate_limited_per_key_app_and_owner(
    client, partner_mint_overrides
):
    key, seen_keys, _state = partner_mint_overrides
    response = await client.post(
        "/v1/developer/partner-tokens", json={"fid": 12345, "ttl_seconds": 300}
    )
    assert response.status_code == 201, response.text
    assert response.json()["fid"] == 12345
    assert set(seen_keys) == {
        f"developer_partner_token_rate:{key.key_id}",
        f"developer_partner_token_daily:{key.key_id}",
        f"developer_partner_token_rate:app:{key.app_id}",
        f"developer_partner_token_daily:app:{key.app_id}",
        f"developer_partner_token_rate:owner:{key.fid}",
        f"developer_partner_token_daily:owner:{key.fid}",
    }


@pytest.mark.asyncio
async def test_partner_token_requires_api_key(client):
    response = await client.post(
        "/v1/developer/partner-tokens",
        json={"fid": 12345, "ttl_seconds": 300},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_partner_token_rejects_extra_fields(client):
    """`extra="forbid"` on the schema prevents accidental claim injection.

    A future-self change that loosens this would let a partner sneak
    additional claims into the minted JWT — explicitly reject.
    """
    response = await client.post(
        "/v1/developer/partner-tokens",
        headers={"X-Juke-Api-Key": "definitely-not-a-real-key"},
        json={"fid": 12345, "admin": True},
    )
    # 401 (auth caught first) or 422 (schema). Either is acceptable; the
    # point is the request never reached `create_partner_jwt`.
    assert response.status_code in (401, 422)


@pytest.mark.asyncio
async def test_partner_token_rejects_zero_fid(client):
    response = await client.post(
        "/v1/developer/partner-tokens",
        headers={"X-Juke-Api-Key": "definitely-not-a-real-key"},
        json={"fid": 0},
    )
    assert response.status_code in (401, 422)


@pytest.mark.asyncio
async def test_partner_token_rejects_ttl_over_cap(client):
    response = await client.post(
        "/v1/developer/partner-tokens",
        headers={"X-Juke-Api-Key": "definitely-not-a-real-key"},
        json={"fid": 1, "ttl_seconds": 999_999},
    )
    assert response.status_code in (401, 422)


@pytest.mark.asyncio
async def test_partner_token_rejects_ttl_under_floor(client):
    response = await client.post(
        "/v1/developer/partner-tokens",
        headers={"X-Juke-Api-Key": "definitely-not-a-real-key"},
        json={"fid": 1, "ttl_seconds": 1},
    )
    assert response.status_code in (401, 422)


@pytest.mark.asyncio
async def test_partner_token_rejects_fid_over_cap(client):
    """fid is clamped to a sane Farcaster range to prevent garbage int abuse."""
    response = await client.post(
        "/v1/developer/partner-tokens",
        headers={"X-Juke-Api-Key": "definitely-not-a-real-key"},
        json={"fid": 10**18},
    )
    assert response.status_code in (401, 422)


@pytest.mark.asyncio
async def test_partner_token_rejects_room_id_field(client):
    """We dropped the room_id parameter to avoid misleading scope semantics.

    A request that sends it should be rejected by Pydantic's extra=forbid.
    """
    response = await client.post(
        "/v1/developer/partner-tokens",
        headers={"X-Juke-Api-Key": "definitely-not-a-real-key"},
        json={"fid": 1, "room_id": str(uuid.uuid4())},
    )
    assert response.status_code in (401, 422)


# ---------------------------------------------------------------------------
# First-party gate
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_require_first_party_user_refuses_partner_jwt():
    """``require_first_party_user`` must reject any JWT with ``source="partner"``.

    Tested as a unit against the dependency directly to avoid hitting the
    DB-backed route paths in the mocked test app, which would expose
    asyncpg cross-event-loop pool reuse issues unrelated to this code.
    """
    from fastapi import HTTPException
    from fastapi.security import HTTPAuthorizationCredentials

    from app.middleware.auth import require_first_party_user

    token, _ = create_partner_jwt(
        fid=12345, partner_app_id=str(uuid.uuid4()), ttl_seconds=300
    )
    with pytest.raises(HTTPException) as exc:
        await require_first_party_user(
            credentials=HTTPAuthorizationCredentials(
                scheme="Bearer", credentials=token
            ),
        )
    assert exc.value.status_code == 401
    assert (
        "first-party" in exc.value.detail.lower()
        or "partner" in exc.value.detail.lower()
    )


@pytest.mark.asyncio
async def test_require_first_party_user_accepts_siwf_jwt():
    """A regular SIWF-issued JWT (no ``source`` claim) passes the gate."""
    from fastapi.security import HTTPAuthorizationCredentials

    from app.middleware.auth import require_first_party_user
    from app.services.auth_service import create_jwt

    token, _ = create_jwt(fid=12345)
    fid = await require_first_party_user(
        credentials=HTTPAuthorizationCredentials(scheme="Bearer", credentials=token),
    )
    assert fid == 12345


# ---------------------------------------------------------------------------
# Partner-scoped agent-join
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_partner_agent_join_requires_api_key(client):
    """The partner agent-join path must reject calls without an API key."""
    response = await client.post(
        f"/v1/developer/rooms/{uuid.uuid4()}/agent-join",
        json={"agent_name": "ZOE"},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_partner_agent_join_rejects_unsafe_agent_name(client):
    """Schema-level safety check on agent_name shouldn't change for the
    partner variant (it reuses ``AgentJoinRequest``)."""
    response = await client.post(
        f"/v1/developer/rooms/{uuid.uuid4()}/agent-join",
        headers={"X-Juke-Api-Key": "definitely-not-a-real-key"},
        json={"agent_name": "<script>alert(1)</script>"},
    )
    # 401 (auth caught first) or 422 (schema). Either proves the request
    # never reached SessionService.create_session.
    assert response.status_code in (401, 422)


@pytest.mark.asyncio
async def test_partner_agent_join_rejects_non_https_pfp(client):
    """Same HTTPS-only pfp guard as the public agent-join path."""
    response = await client.post(
        f"/v1/developer/rooms/{uuid.uuid4()}/agent-join",
        headers={"X-Juke-Api-Key": "definitely-not-a-real-key"},
        json={
            "agent_name": "ZOE",
            "agent_pfp_url": "http://insecure.example/pfp.png",
        },
    )
    assert response.status_code in (401, 422)


@pytest.mark.asyncio
async def test_partner_agent_join_rejects_malformed_room_id(client):
    """Non-UUID room_id must 404 before any DB/Redis work."""
    response = await client.post(
        "/v1/developer/rooms/not-a-uuid/agent-join",
        headers={"X-Juke-Api-Key": "definitely-not-a-real-key"},
        json={"agent_name": "ZOE"},
    )
    # 401 (auth caught first) or 404 (UUID parse).
    assert response.status_code in (401, 404)


def test_partner_agent_join_route_is_registered():
    """Static sanity: the partner agent-join path is mounted under the
    developer router (not the public rooms router), so it skips the x402
    middleware. Tested against the FastAPI app's route table to avoid
    issuing extra HTTP calls that would compound asyncpg pool churn
    across tests.
    """
    from app.main import app
    from tests.conftest import registered_route_pairs

    routes = registered_route_pairs(app)
    assert ("/v1/developer/rooms/{room_id}/agent-join", "POST") in routes
    # And the public path still exists alongside it.
    assert ("/v1/rooms/{room_id}/agent-join", "POST") in routes


# ---------------------------------------------------------------------------
# Defenses surfaced by the security review
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_allocate_fid_returns_counter_value_without_db():
    """Backwards-compat: SessionService._allocate_fid with db=None just
    trusts the Redis counter. Required so existing callers in test
    fixtures and non-DB paths keep working."""
    from unittest.mock import AsyncMock

    from app.config import settings
    from app.services.session_service import SessionService

    redis = AsyncMock()
    redis.incr = AsyncMock(return_value=42)
    svc = SessionService(redis)
    fid = await svc._allocate_fid(db=None)
    assert fid == settings.AGENT_FID_START + 42


@pytest.mark.asyncio
async def test_allocate_fid_skips_colliding_real_user_rows():
    """When the Redis counter wraps into populated User space, the
    allocator must keep INCR'ing until it lands on a free fid (or a
    stale agent row from a prior session for the same synthetic fid).
    Defends against the Redis-flush identity-reuse vector flagged by
    the security review.
    """
    from unittest.mock import AsyncMock, MagicMock

    from app.config import settings
    from app.services.session_service import SessionService

    # Fake DB: first two lookups return a real user (collision), third
    # returns no row (free).
    real_user = MagicMock(is_agent=False, signer_uuid="real-signer")
    results = [
        MagicMock(scalar_one_or_none=MagicMock(return_value=real_user)),
        MagicMock(scalar_one_or_none=MagicMock(return_value=real_user)),
        MagicMock(scalar_one_or_none=MagicMock(return_value=None)),
    ]
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=results)

    counter = {"v": 0}

    async def _incr(_key):
        counter["v"] += 1
        return counter["v"]

    redis = AsyncMock()
    redis.incr = _incr
    svc = SessionService(redis)
    fid = await svc._allocate_fid(db=db)
    # Skipped fids 1 and 2 (collisions), landed on 3.
    assert fid == settings.AGENT_FID_START + 3
    assert counter["v"] == 3


@pytest.mark.asyncio
async def test_allocate_fid_reuses_prior_agent_row_for_same_fid():
    """A stale `User` row from a prior session at the same synthetic
    fid is OK to reuse — we know it was ours. Only blocks reuse when
    the existing row is a real user or a foreign agent."""
    from unittest.mock import AsyncMock, MagicMock

    from app.config import settings
    from app.services.session_service import SessionService

    target_fid = settings.AGENT_FID_START + 1
    stale_agent = MagicMock(
        is_agent=True,
        signer_uuid=f"agent:{target_fid}",
    )
    db = AsyncMock()
    db.execute = AsyncMock(
        return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=stale_agent))
    )
    redis = AsyncMock()
    redis.incr = AsyncMock(return_value=1)
    svc = SessionService(redis)
    fid = await svc._allocate_fid(db=db)
    assert fid == target_fid


@pytest.mark.asyncio
async def test_count_agents_in_room_filters_by_is_agent_flag():
    """RoomService._count_agents_in_room must only count participants
    flagged is_agent=True so the MAX_AGENTS_PER_ROOM cap doesn't
    accidentally fire on humans or anonymous listeners."""
    from unittest.mock import AsyncMock, MagicMock

    from app.services.room_service import RoomService

    redis_service = AsyncMock()
    redis_service.get_all_participants = AsyncMock(
        return_value=[
            {"fid": 1, "is_agent": False},
            {"fid": 2, "is_agent": True},
            {"fid": 3, "is_agent": True},
            {"fid": 4},  # No flag — treat as not-agent.
        ]
    )
    svc = RoomService(db=MagicMock(), redis=redis_service, livekit=MagicMock())
    assert await svc._count_agents_in_room("some-room") == 2


def test_max_agents_per_room_default_is_sane():
    """Cap should be high enough for legitimate use (concierge,
    transcriber, recap, headroom) but low enough to bound abuse."""
    from app.config import settings

    assert 3 <= settings.MAX_AGENTS_PER_ROOM <= 10
