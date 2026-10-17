"""HTTP + WS tests for ``/v1/messages`` against the upstream fake."""

from __future__ import annotations

import json
import time
import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import settings
from app.dependencies import get_db
from app.main import app
from app.routers import messages as messages_router
from app.services import direct_cast_relay, farcaster_token_service, signer_crypto
from app.services.auth_service import create_jwt, create_partner_jwt
from app.services.direct_cast_service import (
    PATH_CATEGORIZATION,
    PATH_CONVERSATION,
    PATH_DELETE_MESSAGE,
    PATH_INBOX,
    PATH_INBOX_SEARCH,
    PATH_MARK_READ,
    PATH_MARK_UNREAD,
    PATH_MESSAGE_SEARCH,
    PATH_MESSAGES,
    PATH_METADATA,
    PATH_REACTION,
    PATH_RECENT_MESSAGES,
    PATH_RECIPIENTS,
    PATH_SEND,
)
from app.services.farcaster_token_service import DirectCastTokenStatus
from tests.direct_cast_fake import (
    GROUP_ID,
    ONE_TO_ONE_ID,
    PEER_FID,
    VIEWER_FID,
    FakeDirectCast,
    FakeRedis,
    load_fixture,
    make_service,
)

BASE = "/v1/messages"


VIEWER_DC_TOKEN = "MK-viewer-dc-token"
TOKEN_EXPIRES_AT = datetime(2030, 1, 1, tzinfo=UTC)


def _auth(fid: int = VIEWER_FID) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_jwt(fid)[0]}"}


class _Result:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class FakeSession:
    """Just enough ``AsyncSession`` for ``load_sender_profile``."""

    def __init__(self, user=None):
        self.user = user

    async def execute(self, _statement):
        return _Result(self.user)

    async def get(self, _model, _key):
        # No stored Direct Casts token (``farcaster_token_service``).
        return None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


@pytest.fixture
def dc_tokens(monkeypatch) -> dict[int, DirectCastTokenStatus]:
    """Stored DC token state per fid: VIEWER_FID active, everyone else none.

    Tests mutate the returned dict (e.g. mark the viewer ``expired``).
    """
    tokens = {VIEWER_FID: DirectCastTokenStatus("active", TOKEN_EXPIRES_AT)}

    async def get_token_status(db, fid, **_):
        return tokens.get(fid, DirectCastTokenStatus("missing", None))

    async def get_direct_cast_bearer(db, fid, **_):
        token = tokens.get(fid)
        if token is None or not token.is_enabled:
            return None
        return VIEWER_DC_TOKEN

    monkeypatch.setattr(farcaster_token_service, "get_token_status", get_token_status)
    monkeypatch.setattr(
        farcaster_token_service, "get_direct_cast_bearer", get_direct_cast_bearer
    )
    return tokens


@pytest.fixture
def env(monkeypatch, dc_tokens):
    fake = FakeDirectCast()
    redis = FakeRedis()
    session = FakeSession(
        SimpleNamespace(username="alice", display_name="Alice", pfp_url=None)
    )

    async def fake_db():
        yield session

    monkeypatch.setattr(settings, "MESSAGING_ENABLED", True)
    previous_redis = getattr(app.state, "redis", None)
    previous_service = getattr(app.state, "direct_cast_service", None)
    app.state.redis = redis
    app.state.direct_cast_service = make_service(fake, redis)
    app.dependency_overrides[get_db] = fake_db
    monkeypatch.setattr(
        messages_router, "get_messages_session_factory", lambda: FakeSession
    )
    try:
        yield SimpleNamespace(fake=fake, redis=redis, session=session, tokens=dc_tokens)
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.state.redis = previous_redis
        app.state.direct_cast_service = previous_service


@pytest.fixture
async def http(env):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client


# ---------------------------------------------------------------------------
# Gating + auth
# ---------------------------------------------------------------------------


async def test_flag_off_hides_every_route(client, monkeypatch):
    monkeypatch.setattr(settings, "MESSAGING_ENABLED", False)
    for method, path in [
        ("GET", "/inbox"),
        ("GET", f"/conversations/{ONE_TO_ONE_ID}/messages"),
        ("PUT", "/send"),
        ("PUT", "/reactions"),
        ("GET", "/search?q=gm"),
    ]:
        response = await client.request(method, BASE + path, headers=_auth())
        assert response.status_code == 404, path
        assert response.json() == {"detail": "messaging_disabled"}, path


def test_flag_off_ws_closes_4404(monkeypatch):
    monkeypatch.setattr(settings, "MESSAGING_ENABLED", False)
    with (
        pytest.raises(WebSocketDisconnect) as exc,
        _test_client().websocket_connect(f"{BASE}/events?ticket=x"),
    ):
        pass
    assert exc.value.code == messages_router.WS_CLOSE_NOT_FOUND


async def test_requires_jwt(http):
    assert (await http.get(f"{BASE}/inbox")).status_code in (401, 403)


async def test_partner_jwt_refused(http):
    token, _ = create_partner_jwt(fid=VIEWER_FID, partner_app_id="app", ttl_seconds=60)
    response = await http.get(
        f"{BASE}/inbox", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 401


async def test_stored_dc_token_is_the_upstream_bearer(http, env):
    env.fake.route("GET", PATH_INBOX, load_fixture("inbox"))
    response = await http.get(f"{BASE}/inbox", headers=_auth())
    assert response.status_code == 200
    body = response.json()
    assert body["requests_count"] == 3
    assert body["items"][0]["conversation_id"] == ONE_TO_ONE_ID
    # nullable fields serialize as null, never omitted
    assert body["items"][1]["counterparty"] is None
    assert env.fake.calls[0].headers["authorization"] == f"Bearer {VIEWER_DC_TOKEN}"


async def test_client_bearer_header_is_ignored(http, env):
    """B1: upstream rejects app-key JFS, so a client bearer is never used."""
    env.fake.route("GET", PATH_INBOX, load_fixture("inbox"))
    response = await http.get(
        f"{BASE}/inbox", headers={**_auth(), "X-Farcaster-Bearer": "client-jfs"}
    )
    assert response.status_code == 200
    assert env.fake.calls[0].headers["authorization"] == f"Bearer {VIEWER_DC_TOKEN}"


async def test_no_dc_token_is_403_missing(http, env):
    response = await http.get(f"{BASE}/inbox", headers=_auth(PEER_FID))
    assert response.status_code == 403
    assert response.json() == {"detail": "messaging_token_missing"}
    assert env.fake.calls == []


async def test_expired_dc_token_is_403_expired(http, env):
    env.tokens[VIEWER_FID] = DirectCastTokenStatus(
        "expired", TOKEN_EXPIRES_AT - timedelta(days=3650)
    )
    response = await http.get(f"{BASE}/inbox", headers=_auth())
    assert response.status_code == 403
    assert response.json() == {"detail": "messaging_token_expired"}
    assert env.fake.calls == []


async def test_undecryptable_dc_token_is_opaque_503(http, env, monkeypatch):
    async def broken(db, fid, **_):
        raise signer_crypto.SignerDecryptError("bad")

    monkeypatch.setattr(farcaster_token_service, "get_direct_cast_bearer", broken)
    response = await http.get(f"{BASE}/inbox", headers=_auth())
    assert response.status_code == 503
    assert response.json() == {"detail": "messaging_token_unavailable"}


async def test_upstream_401_is_opaque_403(http, env):
    env.fake.route("GET", PATH_INBOX, (401, load_fixture("error_401")))
    response = await http.get(f"{BASE}/inbox", headers=_auth())
    assert response.status_code == 403
    assert response.json() == {"detail": "messaging_token_rejected"}
    assert "Unauthorized" not in response.text
    assert VIEWER_DC_TOKEN not in response.text


async def test_upstream_429_carries_retry_after(http, env):
    env.fake.route("GET", PATH_INBOX, (429, {}))
    response = await http.get(f"{BASE}/inbox", headers=_auth())
    assert response.status_code == 429
    assert response.headers["retry-after"] == "60"


async def test_rate_limit_is_per_user(http, env, monkeypatch):
    monkeypatch.setitem(messages_router.RATE_LIMITS_PER_MIN, "search", 2)
    env.fake.route("GET", PATH_RECIPIENTS, load_fixture("users"))
    statuses = [
        (await http.get(f"{BASE}/recipients?q=b", headers=_auth())).status_code
        for _ in range(3)
    ]
    assert statuses == [200, 200, 429]
    # The window is set once (nx) so polling cannot extend it forever.
    assert await env.redis.ttl(f"messages:rl:search:{VIEWER_FID}") <= 60
    # Another user's budget is untouched.
    other = await http.get(f"{BASE}/recipients?q=b", headers=_auth(PEER_FID))
    assert other.status_code == 403  # no signer, but not rate limited


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


async def test_conversation_and_messages(http, env):
    env.fake.route("GET", PATH_CONVERSATION, load_fixture("conversation"))
    env.fake.route("GET", PATH_MESSAGES, load_fixture("messages"))
    env.fake.route("GET", PATH_RECENT_MESSAGES, load_fixture("recent_messages"))
    conv = await http.get(f"{BASE}/conversations/{ONE_TO_ONE_ID}", headers=_auth())
    assert conv.status_code == 200 and conv.json()["counterparty"]["fid"] == PEER_FID
    page = await http.get(
        f"{BASE}/conversations/{ONE_TO_ONE_ID}/messages?anchor_message_id=abc&limit=10",
        headers=_auth(),
    )
    assert page.status_code == 200
    assert len(page.json()["items"]) == 3
    assert env.fake.calls_to("GET", PATH_MESSAGES)[0].params["messageId"] == "abc"
    recent = await http.get(
        f"{BASE}/conversations/{ONE_TO_ONE_ID}/recent", headers=_auth()
    )
    assert recent.json()["next_cursor"] is None


async def test_unknown_conversation_messages_is_empty_page(http, env):
    env.fake.route("GET", PATH_MESSAGES, (403, {}))
    response = await http.get(
        f"{BASE}/conversations/1001-4242/messages", headers=_auth()
    )
    assert response.status_code == 200
    assert response.json() == {
        "items": [],
        "next_cursor": None,
        "next_newer_cursor": None,
    }


@pytest.mark.parametrize("bad_id", ["a b", "..%2F..", "x" * 200, "a;b"])
async def test_conversation_id_is_validated(http, env, bad_id):
    response = await http.get(f"{BASE}/conversations/{bad_id}", headers=_auth())
    assert response.status_code in (404, 422)
    assert env.fake.calls == []


async def test_send_with_reply_and_idempotency(http, env):
    env.fake.route("PUT", PATH_METADATA, load_fixture("metadata_empty"))
    env.fake.route("PUT", PATH_SEND, load_fixture("send_success"))
    message_id = str(uuid.uuid4())
    response = await http.put(
        f"{BASE}/send",
        headers=_auth(),
        json={
            "conversation_id": None,
            "recipient_fids": [PEER_FID],
            "message_id": message_id,
            "text": "gm",
            "in_reply_to_id": "a1b2c3d4-0001-4000-8000-000000000001",
        },
    )
    assert response.status_code == 200
    message = response.json()["message"]
    assert message["conversation_id"] == ONE_TO_ONE_ID
    assert message["sender"] == {
        "fid": VIEWER_FID,
        "username": "alice",
        "display_name": "Alice",
        "pfp_url": None,
    }
    call = env.fake.calls_to("PUT", PATH_SEND)[0]
    assert call.headers["idempotency-key"] == message_id
    assert call.json["inReplyToId"] == "a1b2c3d4-0001-4000-8000-000000000001"


async def test_send_unknown_user_falls_back_to_bang_fid(http, env):
    env.session.user = None
    env.fake.route("PUT", PATH_SEND, load_fixture("send_success"))
    response = await http.put(
        f"{BASE}/send",
        headers=_auth(),
        json={
            "conversation_id": GROUP_ID,
            "recipient_fids": [],
            "message_id": str(uuid.uuid4()),
            "text": "gm",
            "in_reply_to_id": None,
            "process_metadata": False,
        },
    )
    assert response.status_code == 200
    assert response.json()["message"]["sender"]["display_name"] == f"!{VIEWER_FID}"


@pytest.mark.parametrize(
    "body",
    [
        {"conversation_id": None, "recipient_fids": [], "text": "gm"},
        {"conversation_id": None, "recipient_fids": [1, 2], "text": "gm"},
        {"conversation_id": GROUP_ID, "recipient_fids": [], "text": "   "},
        {"conversation_id": GROUP_ID, "recipient_fids": [], "text": "x" * 2001},
        {"conversation_id": GROUP_ID, "recipient_fids": [-1], "text": "gm"},
    ],
)
async def test_send_validation(http, env, body):
    payload = {"message_id": str(uuid.uuid4()), "in_reply_to_id": None, **body}
    response = await http.put(f"{BASE}/send", headers=_auth(), json=payload)
    assert response.status_code == 422
    assert env.fake.calls == []


async def test_send_to_self_is_400(http, env):
    response = await http.put(
        f"{BASE}/send",
        headers=_auth(),
        json={
            "conversation_id": None,
            "recipient_fids": [VIEWER_FID],
            "message_id": str(uuid.uuid4()),
            "text": "gm",
            "in_reply_to_id": None,
        },
    )
    assert response.status_code == 400
    assert response.json() == {"detail": "invalid_recipient"}


async def test_read_unread_delete_are_204(http, env):
    for method, path in (
        ("POST", PATH_MARK_READ),
        ("POST", PATH_MARK_UNREAD),
        ("DELETE", PATH_DELETE_MESSAGE),
    ):
        env.fake.route(method, path, load_fixture("success"))
    conv = f"{BASE}/conversations/{ONE_TO_ONE_ID}"
    assert (await http.post(f"{conv}/read", headers=_auth())).status_code == 204
    assert (await http.post(f"{conv}/unread", headers=_auth())).status_code == 204
    deleted = await http.delete(f"{conv}/messages/m-1", headers=_auth())
    assert deleted.status_code == 204 and deleted.content == b""
    assert env.fake.calls_to("DELETE", PATH_DELETE_MESSAGE)[0].json == {
        "conversationId": ONE_TO_ONE_ID,
        "messageId": "m-1",
    }


async def test_reactions_add_remove_and_list(http, env):
    env.fake.route("PUT", PATH_REACTION, load_fixture("success"))
    env.fake.route("DELETE", PATH_REACTION, load_fixture("success"))
    env.fake.route("GET", PATH_REACTION, load_fixture("reactions"))
    body = {"conversation_id": ONE_TO_ONE_ID, "message_id": "m-1", "reaction": "🔥"}
    added = await http.put(f"{BASE}/reactions", headers=_auth(), json=body)
    assert added.status_code == 204
    removed = await http.request(
        "DELETE", f"{BASE}/reactions", headers=_auth(), json=body
    )
    assert removed.status_code == 204
    assert env.fake.calls_to("DELETE", PATH_REACTION)[0].json["reaction"] == "🔥"
    listed = await http.get(
        f"{BASE}/reactions?conversation_id={ONE_TO_ONE_ID}&message_id=m-1",
        headers=_auth(),
    )
    assert listed.status_code == 200
    assert len(listed.json()["items"]) == 3
    assert listed.json()["next_cursor"] == "cmVhY3Rpb25zOjI"


async def test_reaction_validation(http, env):
    body = {"conversation_id": ONE_TO_ONE_ID, "message_id": "m-1", "reaction": " "}
    response = await http.put(f"{BASE}/reactions", headers=_auth(), json=body)
    assert response.status_code == 422


async def test_search_routes(http, env):
    env.fake.route("GET", PATH_MESSAGE_SEARCH, load_fixture("search"))
    env.fake.route("GET", PATH_INBOX_SEARCH, load_fixture("search_inbox"))
    global_hits = await http.get(f"{BASE}/search?q=gm", headers=_auth())
    assert len(global_hits.json()["items"]) == 2
    scoped = await http.get(
        f"{BASE}/search?q=gm&conversation_id={GROUP_ID}&limit=1", headers=_auth()
    )
    assert [h["conversation"]["conversation_id"] for h in scoped.json()["items"]] == [
        GROUP_ID
    ]
    conversations = await http.get(
        f"{BASE}/search/conversations?q=juke", headers=_auth()
    )
    assert conversations.json()["items"][0]["name"] == "Juke builders"
    assert (await http.get(f"{BASE}/search?q=", headers=_auth())).status_code == 422


async def test_recipients_and_metadata_preview(http, env):
    env.fake.route("GET", PATH_RECIPIENTS, load_fixture("users"))
    env.fake.route("PUT", PATH_METADATA, load_fixture("metadata"))
    recipients = await http.get(f"{BASE}/recipients?q=b", headers=_auth())
    assert VIEWER_FID not in [u["fid"] for u in recipients.json()["items"]]
    preview = await http.post(
        f"{BASE}/metadata/preview", headers=_auth(), json={"text": "https://juke.audio"}
    )
    assert preview.status_code == 200
    assert preview.json()["urls"][0]["domain"] == "juke.audio"


async def test_inbox_filter_alias(http, env):
    env.fake.route("GET", PATH_INBOX, load_fixture("inbox"))
    response = await http.get(
        f"{BASE}/inbox?filter=unread&category=request", headers=_auth()
    )
    assert response.status_code == 200
    params = env.fake.calls_to("GET", PATH_INBOX)[0].params
    assert params["filter"] == "unread" and params["category"] == "request"
    bad = await http.get(f"{BASE}/inbox?filter=bogus", headers=_auth())
    assert bad.status_code == 422


# ---------------------------------------------------------------------------
# WS /events
# ---------------------------------------------------------------------------


def _test_client() -> TestClient:
    """Not used as a context manager, so the app lifespan (real Redis,
    background workers) never runs and the fakes on ``app.state`` stay."""
    return TestClient(app)


def _ws_url(env, fid: int = VIEWER_FID) -> str:
    """``/events`` with a fresh ticket for ``fid`` (session valid for 1h)."""
    return _ticket_url(_sync_ticket(env, fid=fid, expires_at=int(time.time()) + 3600))


def _expect_close_with_reason(path: str) -> tuple[int, str]:
    with (
        pytest.raises(WebSocketDisconnect) as exc,
        _test_client().websocket_connect(path) as ws,
    ):
        ws.receive_json()
    return exc.value.code, exc.value.reason


@pytest.fixture
def ws_env(env, monkeypatch):
    monkeypatch.setattr(direct_cast_relay, "POLL_INTERVAL_SECONDS", 0.05)
    monkeypatch.setattr(messages_router, "WS_RECEIVE_TIMEOUT_SECONDS", 0.02)
    return env


def test_ws_requires_ticket(ws_env):
    """A JWT in ``?token=`` is no longer accepted (only tickets)."""
    token = create_jwt(VIEWER_FID)[0]
    for path in (
        f"{BASE}/events",
        _ticket_url("garbage"),
        f"{BASE}/events?token={token}",
    ):
        assert _expect_close_with_reason(path) == (
            messages_router.WS_CLOSE_UNAUTHORIZED,
            messages_router.WS_CLOSE_REASON_TICKET_REJECTED,
        )


def test_ws_with_expired_dc_token_closes_4403_expired(ws_env):
    ws_env.tokens[VIEWER_FID] = DirectCastTokenStatus("expired", TOKEN_EXPIRES_AT)
    assert _expect_close_with_reason(_ws_url(ws_env)) == (
        messages_router.WS_CLOSE_FORBIDDEN,
        "messaging_token_expired",
    )


def test_ws_streams_message_event(ws_env):
    _changed_inbox_routes(ws_env)
    with _test_client().websocket_connect(_ws_url(ws_env)) as ws:
        ws.send_json({"type": "ping"})
        frame = ws.receive_json()
    assert frame["type"] == "message"
    assert frame["conversation_id"] == ONE_TO_ONE_ID
    assert frame["message"]["message_id"] == "fresh"
    # Polling only ever publishes on the viewer's own channel.
    assert ws_env.redis.published
    assert all(
        channel == direct_cast_relay.events_channel(VIEWER_FID)
        for channel, _ in ws_env.redis.published
    )


def test_ws_upstream_token_rejection_closes_4403(ws_env):
    ws_env.fake.route("GET", PATH_INBOX, (401, {}))
    assert _expect_close_with_reason(_ws_url(ws_env)) == (
        messages_router.WS_CLOSE_FORBIDDEN,
        "messaging_token_rejected",
    )


# ---------------------------------------------------------------------------
# Round 2: status, lookup-by-recipient, requests, paging, search, peer read
# ---------------------------------------------------------------------------


async def test_status_when_flag_off_is_200_disabled(http, env, monkeypatch):
    monkeypatch.setattr(settings, "MESSAGING_ENABLED", False)
    response = await http.get(f"{BASE}/status", headers=_auth())
    assert response.status_code == 200
    assert response.json() == {
        "enabled": False,
        "signer_status": None,
        "token_status": None,
        "expires_at": None,
    }
    assert env.fake.calls == []


async def test_status_requires_jwt(http):
    assert (await http.get(f"{BASE}/status")).status_code in (401, 403)


@pytest.mark.parametrize(
    ("fid", "signer_status", "token_status", "expires_at"),
    [
        (VIEWER_FID, "ready", "active", "2030-01-01T00:00:00Z"),
        (PEER_FID, "not_linked", "missing", None),
    ],
)
async def test_status_reports_token(
    http, env, fid, signer_status, token_status, expires_at
):
    response = await http.get(f"{BASE}/status", headers=_auth(fid))
    assert response.status_code == 200
    assert response.json() == {
        "enabled": True,
        "signer_status": signer_status,
        "token_status": token_status,
        "expires_at": expires_at,
    }
    assert env.fake.calls == []  # never calls upstream


async def test_status_reports_expired_token(http, env):
    env.tokens[VIEWER_FID] = DirectCastTokenStatus("expired", TOKEN_EXPIRES_AT)
    response = await http.get(f"{BASE}/status", headers=_auth())
    body = response.json()
    assert (body["signer_status"], body["token_status"]) == ("not_linked", "expired")
    assert body["expires_at"] == "2030-01-01T00:00:00Z"


async def test_status_reports_undecryptable_token(http, env, monkeypatch):
    async def broken(db, fid, **_):
        raise signer_crypto.SignerDecryptError("bad")

    monkeypatch.setattr(farcaster_token_service, "get_direct_cast_bearer", broken)
    response = await http.get(f"{BASE}/status", headers=_auth())
    assert response.json() == {
        "enabled": True,
        "signer_status": "unavailable",
        "token_status": "active",
        "expires_at": "2030-01-01T00:00:00Z",
    }


async def test_conversation_with_returns_existing_one_to_one(http, env):
    env.fake.route("GET", PATH_CONVERSATION, load_fixture("conversation"))
    response = await http.get(f"{BASE}/conversations/with/{PEER_FID}", headers=_auth())
    assert response.status_code == 200
    body = response.json()
    assert body["conversation_id"] == ONE_TO_ONE_ID
    assert body["peer_last_read_at"] == 1760600060000
    params = env.fake.calls_to("GET", PATH_CONVERSATION)[0].params
    assert params == {"conversationId": ONE_TO_ONE_ID}


@pytest.mark.parametrize("upstream_status", [403, 404])
async def test_conversation_with_missing_is_404(http, env, upstream_status):
    env.fake.route("GET", PATH_CONVERSATION, (upstream_status, {}))
    response = await http.get(f"{BASE}/conversations/with/{PEER_FID}", headers=_auth())
    assert response.status_code == 404
    assert response.json() == {"detail": "conversation_not_found"}


async def test_conversation_with_self_or_bad_fid(http, env):
    response = await http.get(
        f"{BASE}/conversations/with/{VIEWER_FID}", headers=_auth()
    )
    assert response.status_code == 400
    assert response.json() == {"detail": "invalid_recipient"}
    for bad in ("0", "-5", "abc"):
        response = await http.get(f"{BASE}/conversations/with/{bad}", headers=_auth())
        assert response.status_code == 422, bad
    assert env.fake.calls == []


@pytest.mark.parametrize(
    ("action", "category"), [("accept", "default"), ("decline", "deleted")]
)
async def test_request_accept_decline(http, env, action, category):
    env.fake.route("POST", PATH_CATEGORIZATION, load_fixture("success"))
    response = await http.post(
        f"{BASE}/conversations/{ONE_TO_ONE_ID}/{action}", headers=_auth()
    )
    assert response.status_code == 204
    call = env.fake.calls_to("POST", PATH_CATEGORIZATION)[0]
    assert call.json == {"conversationId": ONE_TO_ONE_ID, "category": category}


async def test_request_accept_upstream_failure_maps(http, env):
    env.fake.route("POST", PATH_CATEGORIZATION, (403, {}))
    response = await http.post(
        f"{BASE}/conversations/{ONE_TO_ONE_ID}/accept", headers=_auth()
    )
    assert response.status_code == 403
    assert response.json() == {"detail": "upstream_forbidden"}


async def test_messages_page_exposes_both_cursors(http, env):
    import base64

    raw = load_fixture("messages")
    cursor = {"page": 2, "limit": 30, "before": 100, "after": 200, "midpoint": 150}
    raw["next"] = {
        "cursor": base64.b64encode(json.dumps(cursor).encode()).decode().rstrip("=")
    }
    env.fake.route("GET", PATH_MESSAGES, raw)
    response = await http.get(
        f"{BASE}/conversations/{ONE_TO_ONE_ID}/messages?anchor_message_id=m-1",
        headers=_auth(),
    )
    assert response.status_code == 200
    body = response.json()
    sent = [item["sent_at"] for item in body["items"]]
    assert sent == sorted(sent, reverse=True)

    def decode(value):
        return json.loads(base64.b64decode(value + "=" * (-len(value) % 4)))

    assert decode(body["next_cursor"]) == {"limit": 30, "page": 2, "before": 100}
    assert decode(body["next_newer_cursor"]) == {"limit": 30, "page": 2, "after": 200}


async def test_search_hit_exposes_ranges_and_thread_cursors(http, env):
    env.fake.route("GET", PATH_MESSAGE_SEARCH, load_fixture("search"))
    response = await http.get(f"{BASE}/search?q=alice", headers=_auth())
    hit = response.json()["items"][0]
    assert hit["highlights"] == ["gm <em>alice</em>"]
    assert hit["matched_terms"] == ["alice"]
    assert hit["highlight_ranges"] == [{"start": 3, "end": 8}]
    # Opaque (non-JSON) surrounding cursor passes through as the older cursor.
    assert hit["thread_cursor"] == "c3Vycm91bmQ"
    assert hit["thread_newer_cursor"] is None


# ---------------------------------------------------------------------------
# Round 3: WS tickets, session expiry, pubsub resilience, buckets, errors
# ---------------------------------------------------------------------------


def _ticket_url(ticket: str) -> str:
    return f"{BASE}/events?ticket={ticket}"


def _changed_inbox_routes(env) -> None:
    inbox = load_fixture("inbox")
    changed = json.loads(json.dumps(inbox))
    last = changed["result"]["conversations"][0]["lastMessage"]
    last["messageId"] = "fresh"
    last["serverTimestamp"] += 1  # newer than the previous tick's watermark
    env.fake.route("GET", PATH_INBOX, [inbox, changed])


async def _mint_ticket(http, fid: int = VIEWER_FID) -> str:
    response = await http.post(f"{BASE}/events/ticket", headers=_auth(fid))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["expires_in"] == messages_router.WS_TICKET_TTL_SECONDS
    return body["ticket"]


async def test_ticket_is_opaque_hashed_and_short_lived(http, env):
    ticket = await _mint_ticket(http)
    assert len(ticket) >= 32
    keys = [k for k in env.redis.store if k.startswith("messages:ws_ticket:")]
    assert len(keys) == 1
    assert ticket not in keys[0]  # stored hashed, never as the usable value
    assert 0 < await env.redis.ttl(keys[0]) <= messages_router.WS_TICKET_TTL_SECONDS
    stored = json.loads(env.redis.store[keys[0]][0])
    assert stored["fid"] == VIEWER_FID and isinstance(stored["exp"], int)
    assert ticket != await _mint_ticket(http)


async def test_ticket_requires_first_party_jwt(http, env):
    missing = await http.post(f"{BASE}/events/ticket")
    assert missing.status_code == 401
    assert missing.json() == {"detail": "invalid_token"}
    wrong_scheme = await http.post(
        f"{BASE}/events/ticket", headers={"Authorization": "Basic Zm9vOmJhcg=="}
    )
    assert wrong_scheme.status_code == 401
    partner, _ = create_partner_jwt(
        fid=VIEWER_FID, partner_app_id="app", ttl_seconds=60
    )
    response = await http.post(
        f"{BASE}/events/ticket", headers={"Authorization": f"Bearer {partner}"}
    )
    assert response.status_code == 401
    assert not any(k.startswith("messages:ws_ticket:") for k in env.redis.store)


async def test_ticket_route_gated_and_rate_limited(http, env, monkeypatch):
    monkeypatch.setitem(messages_router.RATE_LIMITS_PER_MIN, "events_ticket", 1)
    await _mint_ticket(http)
    response = await http.post(f"{BASE}/events/ticket", headers=_auth())
    assert response.status_code == 429
    monkeypatch.setattr(settings, "MESSAGING_ENABLED", False)
    response = await http.post(f"{BASE}/events/ticket", headers=_auth())
    assert response.status_code == 404


def _sync_ticket(env, *, fid: int = VIEWER_FID, expires_at: int | None) -> str:
    import asyncio

    return asyncio.run(
        messages_router._issue_ws_ticket(env.redis, fid=fid, expires_at=expires_at)
    )


def test_ws_ticket_streams_and_is_single_use(ws_env, caplog):
    _changed_inbox_routes(ws_env)
    ticket = _sync_ticket(ws_env, expires_at=int(time.time()) + 3600)
    with _test_client().websocket_connect(_ticket_url(ticket)) as ws:
        frame = ws.receive_json()
    assert frame["type"] == "message" and frame["message"]["message_id"] == "fresh"
    # Consumed on first use: re-mint, not re-auth.
    assert _expect_close_with_reason(_ticket_url(ticket)) == (
        messages_router.WS_CLOSE_UNAUTHORIZED,
        messages_router.WS_CLOSE_REASON_TICKET_REJECTED,
    )
    assert ticket not in caplog.text


def test_ws_rejects_unknown_or_oversized_ticket(ws_env):
    for bad in ("nope", "x" * (messages_router.MAX_WS_TICKET_CHARS + 1)):
        assert _expect_close_with_reason(_ticket_url(bad)) == (
            messages_router.WS_CLOSE_UNAUTHORIZED,
            messages_router.WS_CLOSE_REASON_TICKET_REJECTED,
        )


def test_ws_ticket_for_fid_without_dc_token_closes_4403(ws_env):
    ticket = _sync_ticket(ws_env, fid=PEER_FID, expires_at=None)
    assert _expect_close_with_reason(_ticket_url(ticket)) == (
        messages_router.WS_CLOSE_FORBIDDEN,
        "messaging_token_missing",
    )


def test_ws_ticket_socket_closes_4401_when_session_expires(ws_env):
    ws_env.fake.route("GET", PATH_INBOX, load_fixture("inbox"))
    ticket = _sync_ticket(ws_env, expires_at=int(time.time()) - 1)
    assert _expect_close_with_reason(_ticket_url(ticket)) == (
        messages_router.WS_CLOSE_UNAUTHORIZED,
        messages_router.WS_CLOSE_REASON_SESSION_EXPIRED,
    )
    assert ws_env.fake.calls_to("GET", PATH_INBOX) == []  # no poll after expiry


def test_ws_ticket_socket_closes_4401_mid_stream_at_session_exp(ws_env):
    ws_env.fake.route("GET", PATH_INBOX, load_fixture("inbox"))
    ticket = _sync_ticket(ws_env, expires_at=int(time.time()) + 1)
    started = time.monotonic()
    assert _expect_close_with_reason(_ticket_url(ticket)) == (
        messages_router.WS_CLOSE_UNAUTHORIZED,
        messages_router.WS_CLOSE_REASON_SESSION_EXPIRED,
    )
    assert time.monotonic() - started < 5
    assert ws_env.fake.calls_to("GET", PATH_INBOX)  # it was live before expiry


def test_ws_pubsub_redis_error_is_logged_and_survived(ws_env, monkeypatch, caplog):
    from redis.exceptions import ConnectionError as RedisConnectionError

    _changed_inbox_routes(ws_env)
    real_pubsub = ws_env.redis.pubsub
    failures = {"left": 2}

    def flaky_pubsub():
        pubsub = real_pubsub()
        real_get = pubsub.get_message

        async def get_message(**kwargs):
            if failures["left"]:
                failures["left"] -= 1
                raise RedisConnectionError("redis://:hunter2@host blew up")
            return await real_get(**kwargs)

        pubsub.get_message = get_message
        return pubsub

    monkeypatch.setattr(ws_env.redis, "pubsub", flaky_pubsub)
    with _test_client().websocket_connect(_ws_url(ws_env)) as ws:
        frame = ws.receive_json()
    assert frame["type"] == "message"
    assert failures["left"] == 0
    assert "pubsub read failed (ConnectionError)" in caplog.text
    assert "hunter2" not in caplog.text


def _ws_conn_key(fid: int = VIEWER_FID) -> str:
    return f"{messages_router.WS_CONNECTION_KEY_PREFIX}{fid}"


def test_ws_refuses_socket_over_per_fid_cap(ws_env, monkeypatch):
    monkeypatch.setattr(settings, "MESSAGES_WS_MAX_PER_FID", 2)
    live_until = time.time() + 60
    ws_env.redis.store[_ws_conn_key()] = ({"a": live_until, "b": live_until}, None)
    assert _expect_close_with_reason(_ws_url(ws_env)) == (
        messages_router.WS_CLOSE_RATE_LIMITED,
        messages_router.WS_CLOSE_REASON_TOO_MANY_CONNECTIONS,
    )
    # The rejected attempt did not leave a lease behind.
    assert set(ws_env.redis.store[_ws_conn_key()][0]) == {"a", "b"}


def test_ws_expired_leases_do_not_count_toward_cap(ws_env, monkeypatch):
    """A crashed worker's leases lapse instead of locking the fid out."""
    monkeypatch.setattr(settings, "MESSAGES_WS_MAX_PER_FID", 1)
    ws_env.redis.store[_ws_conn_key()] = ({"stale": time.time() - 1}, None)
    _changed_inbox_routes(ws_env)
    with _test_client().websocket_connect(_ws_url(ws_env)) as ws:
        assert ws.receive_json()["type"] == "message"


def test_ws_releases_lease_on_disconnect(ws_env):
    _changed_inbox_routes(ws_env)
    with _test_client().websocket_connect(_ws_url(ws_env)) as ws:
        ws.receive_json()
        assert len(ws_env.redis.store[_ws_conn_key()][0]) == 1
    assert ws_env.redis.store[_ws_conn_key()][0] == {}


def test_ws_closes_live_socket_when_messaging_disabled(ws_env, monkeypatch):
    _changed_inbox_routes(ws_env)
    with (
        pytest.raises(WebSocketDisconnect) as exc,
        _test_client().websocket_connect(_ws_url(ws_env)) as ws,
    ):
        assert ws.receive_json()["type"] == "message"
        monkeypatch.setattr(settings, "MESSAGING_ENABLED", False)
        while True:
            ws.receive_json()
    assert (exc.value.code, exc.value.reason) == (
        messages_router.WS_CLOSE_NOT_FOUND,
        messages_router.WS_CLOSE_REASON_MESSAGING_DISABLED,
    )


async def test_mark_read_has_its_own_bucket(http, env, monkeypatch):
    monkeypatch.setitem(messages_router.RATE_LIMITS_PER_MIN, "mark_read", 1)
    env.fake.route("POST", PATH_MARK_READ, load_fixture("success"))
    env.fake.route("POST", PATH_MARK_UNREAD, load_fixture("success"))
    env.fake.route("GET", PATH_RECENT_MESSAGES, load_fixture("recent_messages"))
    read = f"{BASE}/conversations/{ONE_TO_ONE_ID}/read"
    unread = f"{BASE}/conversations/{ONE_TO_ONE_ID}/unread"
    assert (await http.post(read, headers=_auth())).status_code == 204
    assert (await http.post(unread, headers=_auth())).status_code == 429
    # Polling reads are untouched by the write-ish bucket.
    recent = await http.get(
        f"{BASE}/conversations/{ONE_TO_ONE_ID}/recent", headers=_auth()
    )
    assert recent.status_code == 200
    assert f"messages:rl:mark_read:{VIEWER_FID}" in env.redis.store


async def test_preview_has_its_own_bucket(http, env, monkeypatch):
    monkeypatch.setitem(messages_router.RATE_LIMITS_PER_MIN, "preview", 1)
    env.fake.route("PUT", PATH_METADATA, load_fixture("metadata"))
    env.fake.route("GET", PATH_RECIPIENTS, load_fixture("users"))
    preview = f"{BASE}/metadata/preview"
    body = {"text": "https://juke.audio"}
    assert (await http.post(preview, json=body, headers=_auth())).status_code == 200
    assert (await http.post(preview, json=body, headers=_auth())).status_code == 429
    recipients = await http.get(f"{BASE}/recipients?q=b", headers=_auth())
    assert recipients.status_code == 200
    assert f"messages:rl:search:{VIEWER_FID}" in env.redis.store


def _send_body(**overrides) -> dict:
    return {
        "conversation_id": ONE_TO_ONE_ID,
        "recipient_fids": [],
        "message_id": str(uuid.uuid4()),
        "text": "gm",
        "in_reply_to_id": None,
        "process_metadata": False,
        **overrides,
    }


async def test_upstream_400_is_upstream_rejected_not_502(http, env):
    env.fake.route(
        "PUT",
        PATH_SEND,
        (400, {"errors": [{"message": f"Bearer {VIEWER_DC_TOKEN} cannot DM"}]}),
    )
    response = await http.put(f"{BASE}/send", json=_send_body(), headers=_auth())
    assert response.status_code == 422
    body = response.json()
    assert body["detail"] == "upstream_rejected"
    assert "cannot DM" in body["message"]
    assert VIEWER_DC_TOKEN not in response.text
    assert "authorization" not in response.text.lower()


async def test_send_echo_carries_reply_quote(http, env):
    env.fake.route("PUT", PATH_SEND, load_fixture("send_success"))
    parent = "a1b2c3d4-0002-4000-8000-000000000002"
    response = await http.put(
        f"{BASE}/send", json=_send_body(in_reply_to_id=parent), headers=_auth()
    )
    assert response.status_code == 200
    quote = response.json()["message"]["in_reply_to"]
    assert quote["message_id"] == parent


async def test_messages_422_does_not_echo_message_text(http, env):
    secret_text = "private words " * 200  # over MAX_MESSAGE_LENGTH
    response = await http.put(
        f"{BASE}/send", json=_send_body(text=secret_text), headers=_auth()
    )
    assert response.status_code == 422
    assert "private words" not in response.text
    assert env.fake.calls == []


# ---------------------------------------------------------------------------
# Round 4: 4401 close reasons, ticket route 401
# ---------------------------------------------------------------------------


def test_ws_malformed_or_expired_ticket_closes_4401_ticket_rejected(ws_env):
    import hashlib

    # A stored value that isn't the expected JSON shape.
    malformed = "malformed-ticket"
    digest = hashlib.sha256(malformed.encode()).hexdigest()
    ws_env.redis.store[f"{messages_router.WS_TICKET_KEY_PREFIX}{digest}"] = (
        "not json",
        None,
    )
    # A ticket whose 30 s Redis TTL already lapsed.
    expired = _sync_ticket(ws_env, expires_at=None)
    for key, (value, _) in list(ws_env.redis.store.items()):
        if key.startswith(messages_router.WS_TICKET_KEY_PREFIX) and value != "not json":
            ws_env.redis.store[key] = (value, 0.0)
    for ticket in (malformed, expired):
        assert _expect_close_with_reason(_ticket_url(ticket)) == (
            messages_router.WS_CLOSE_UNAUTHORIZED,
            messages_router.WS_CLOSE_REASON_TICKET_REJECTED,
        )


async def test_other_routes_keep_http_bearer_default(http, env):
    """Only POST /events/ticket pins 401; other routes keep ``HTTPBearer``'s
    own missing-credentials status (403 on older FastAPI, 401 on newer)."""
    from fastapi import HTTPException
    from starlette.requests import Request as StarletteRequest

    from app.middleware.auth import security

    with pytest.raises(HTTPException) as default:
        await security(
            StarletteRequest({"type": "http", "headers": [], "method": "GET"})
        )
    response = await http.get(f"{BASE}/inbox")
    assert response.status_code == default.value.status_code
