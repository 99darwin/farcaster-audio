"""Unit tests for the JWT auth dependencies (H1 / L8 hardening).

* First-party dependencies refuse partner-minted and unknown-source JWTs.
* ``get_principal_allow_partner`` is the only dependency that admits a
  partner JWT, and it still refuses unknown sources.
* Every dependency refuses a JWT without ``exp`` instead of treating it as
  non-expiring.
* Admin routes refuse a partner JWT even when it asserts an admin's fid.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from jose import jwt
from starlette.requests import Request

from app.config import settings
from app.middleware.auth import (
    PARTNER_JWT_REJECTED_DETAIL,
    get_agent_or_user,
    get_current_user,
    get_optional_current_user,
    get_principal_allow_partner,
    require_first_party_user,
)
from app.services.auth_service import create_partner_jwt

FID = 4242


def _encode(claims: dict) -> str:
    return jwt.encode(claims, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def _exp(hours: int = 1) -> int:
    return int((datetime.now(timezone.utc) + timedelta(hours=hours)).timestamp())


def _creds(token: str) -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


def _partner_token(fid: int = FID) -> str:
    token, _ = create_partner_jwt(
        fid=fid, partner_app_id=str(uuid.uuid4()), ttl_seconds=300
    )
    return token


def _request_with(headers: dict[str, str], path: str = "/v1/rooms/r1/leave"):
    scope = {
        "type": "http",
        "method": "POST",
        "path": path,
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "app": SimpleNamespace(state=SimpleNamespace(redis=None)),
    }
    return Request(scope)


FIRST_PARTY_DEPS = [get_current_user, require_first_party_user]


@pytest.mark.asyncio
@pytest.mark.parametrize("dependency", FIRST_PARTY_DEPS)
@pytest.mark.parametrize("source", [None, "first_party"])
async def test_first_party_deps_accept_first_party_tokens(dependency, source):
    claims = {"fid": FID, "exp": _exp()}
    if source is not None:
        claims["source"] = source
    assert await dependency(credentials=_creds(_encode(claims))) == FID


@pytest.mark.asyncio
@pytest.mark.parametrize("dependency", FIRST_PARTY_DEPS)
async def test_first_party_deps_reject_partner_tokens(dependency):
    with pytest.raises(HTTPException) as exc:
        await dependency(credentials=_creds(_partner_token()))
    assert exc.value.status_code == 401
    assert exc.value.detail == PARTNER_JWT_REJECTED_DETAIL


@pytest.mark.asyncio
@pytest.mark.parametrize("dependency", [*FIRST_PARTY_DEPS, get_principal_allow_partner])
async def test_unknown_source_rejected(dependency):
    token = _encode({"fid": FID, "exp": _exp(), "source": "something_new"})
    with pytest.raises(HTTPException) as exc:
        await dependency(credentials=_creds(token))
    assert exc.value.status_code == 401


@pytest.mark.asyncio
@pytest.mark.parametrize("dependency", [*FIRST_PARTY_DEPS, get_principal_allow_partner])
@pytest.mark.parametrize("source", [None, "partner"])
async def test_exp_less_token_rejected(dependency, source):
    """L8: a JWT without ``exp`` must never authenticate."""
    claims: dict = {"fid": FID}
    if source is not None:
        claims["source"] = source
        claims["partner_app_id"] = str(uuid.uuid4())
    with pytest.raises(HTTPException) as exc:
        await dependency(credentials=_creds(_encode(claims)))
    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_expired_token_rejected():
    token = _encode({"fid": FID, "exp": _exp(hours=-1)})
    with pytest.raises(HTTPException) as exc:
        await get_current_user(credentials=_creds(token))
    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_principal_allow_partner_distinguishes_sources():
    first_party = await get_principal_allow_partner(
        credentials=_creds(_encode({"fid": FID, "exp": _exp()}))
    )
    assert first_party.fid == FID
    assert first_party.is_partner is False
    assert first_party.partner_app_id is None

    partner = await get_principal_allow_partner(credentials=_creds(_partner_token()))
    assert partner.fid == FID
    assert partner.is_partner is True
    assert partner.partner_app_id


@pytest.mark.asyncio
async def test_optional_user_degrades_partner_and_invalid_tokens_to_anonymous():
    assert await get_optional_current_user(credentials=None) is None
    assert await get_optional_current_user(credentials=_creds(_partner_token())) is None
    assert (
        await get_optional_current_user(credentials=_creds(_encode({"fid": FID})))
        is None
    )
    assert (
        await get_optional_current_user(
            credentials=_creds(_encode({"fid": FID, "exp": _exp()}))
        )
        == FID
    )


@pytest.mark.asyncio
async def test_agent_or_user_accepts_first_party_jwt():
    token = _encode({"fid": FID, "exp": _exp()})
    request = _request_with({"Authorization": f"Bearer {token}"})
    assert await get_agent_or_user(request) == FID


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "token_factory",
    [
        _partner_token,
        lambda: _encode({"fid": FID}),  # L8: no exp
        lambda: _encode({"fid": FID, "exp": _exp(), "source": "other"}),
    ],
    ids=["partner", "exp_less", "unknown_source"],
)
async def test_agent_or_user_rejects_non_first_party_jwts(token_factory):
    request = _request_with({"Authorization": f"Bearer {token_factory()}"})
    with pytest.raises(HTTPException) as exc:
        await get_agent_or_user(request)
    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_admin_route_rejects_partner_jwt_for_admin_fid(client):
    """A partner app asserting an admin fid gets nowhere near the admin check."""
    response = await client.get(
        "/v1/admin/rooms",
        headers={"Authorization": f"Bearer {_partner_token(fid=1)}"},
    )
    assert response.status_code == 401
    assert response.json()["detail"] == PARTNER_JWT_REJECTED_DETAIL


@pytest.mark.parametrize(
    ("token_factory", "expected"),
    [
        (lambda: _encode({"fid": FID, "exp": _exp()}), FID),
        (_partner_token, None),
        (lambda: _encode({"fid": FID, "exp": _exp(), "source": "other"}), None),
        (lambda: _encode({"fid": FID}), None),
    ],
    ids=["first_party", "partner", "unknown_source", "exp_less"],
)
def test_logout_and_ws_ticket_helpers_use_first_party_allowlist(
    token_factory, expected
):
    from app.routers.auth import _first_party_fid_from_bearer
    from app.routers.messages import _first_party_claims

    token = token_factory()
    assert _first_party_fid_from_bearer(_creds(token)) == expected
    claims = _first_party_claims(token)
    assert (claims[0] if claims else None) == expected
