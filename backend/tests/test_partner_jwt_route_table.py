"""H1 regression guard: partner-minted JWTs work only on an explicit allowlist.

A partner JWT is minted on a developer app's *assertion* of who a visitor
is, so it must not act as that user on any route except the embed-safe
ones below. Adding a route to this allowlist is a security decision; it
should come with a scope check like ``_enforce_partner_session_scope``.
"""

from __future__ import annotations

import re
import uuid

import pytest
from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute, iter_route_contexts

from app.config import settings
from app.main import app
from app.middleware.auth import (
    get_admin_user,
    get_agent_or_user,
    get_current_user,
    get_principal_allow_partner,
    require_first_party_user,
)
from app.services.auth_service import create_partner_jwt

PARTNER_ALLOWED_ROUTES = {
    ("POST", "/v1/rooms/{room_id}/leave"),
    ("POST", "/v1/rooms/{room_id}/token"),
}

FIRST_PARTY_JWT_DEPENDENCIES = {
    get_current_user,
    require_first_party_user,
    get_admin_user,
    get_agent_or_user,
}

PATH_PARAM = re.compile(r"\{([^}:]+)(?::[^}]+)?\}")


def _dependency_calls(dependant: Dependant) -> set:
    calls = set()
    stack = list(dependant.dependencies)
    while stack:
        sub = stack.pop()
        calls.add(sub.call)
        stack.extend(sub.dependencies)
    return calls


def _route_methods():
    # ``iter_route_contexts`` flattens included routers and applies their
    # prefixes / router-level dependencies.
    for context in iter_route_contexts(app.routes):
        if not isinstance(context.original_route, APIRoute):
            continue  # WebSockets / mounts are out of scope here
        calls = _dependency_calls(context.dependant)
        for method in sorted(context.methods or ()):
            yield method, context.path, calls


def _concrete_path(path: str) -> str:
    # A UUID satisfies both str and UUID path params; int params are rare
    # and FastAPI resolves dependencies before path-param validation errors.
    return PATH_PARAM.sub(str(uuid.uuid4()), path)


def test_only_allowlisted_routes_accept_partner_jwts():
    accepting = {
        (method, path)
        for method, path, calls in _route_methods()
        if get_principal_allow_partner in calls
    }
    assert accepting == PARTNER_ALLOWED_ROUTES


JWT_PROTECTED = sorted(
    (method, path)
    for method, path, calls in _route_methods()
    if calls & FIRST_PARTY_JWT_DEPENDENCIES and get_principal_allow_partner not in calls
)


def test_route_table_is_populated():
    # Guard against the parametrized test below silently collecting nothing.
    assert len(JWT_PROTECTED) > 50


@pytest.mark.asyncio
@pytest.mark.parametrize(("method", "path"), JWT_PROTECTED)
async def test_partner_jwt_refused_on_first_party_routes(
    client, monkeypatch, method, path
):
    # Feature-flag gates run before auth; open them so auth is what answers.
    monkeypatch.setattr(settings, "MESSAGING_ENABLED", True)
    token, _ = create_partner_jwt(
        fid=1, partner_app_id=str(uuid.uuid4()), ttl_seconds=300
    )
    response = await client.request(
        method,
        _concrete_path(path),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code in (
        401,
        403,
    ), f"{method} {path} -> {response.status_code}: {response.text[:200]}"
