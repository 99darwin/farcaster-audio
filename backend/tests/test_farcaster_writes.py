"""Hypersnap write path: validation, mentions, lookups and error mapping,
plus endpoint coverage for every user-signed write with a faked node."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from jose import jwt

from app.clients import farcaster_messages as fm
from app.clients import hypersnap
from app.config import settings
from app.main import app
from app.services import farcaster_writes as fw
from app.services.signer_crypto import SignerDecryptError
from app.services.user_signer_service import SignerNotApprovedError
from tests.hypersnap_write_fakes import (
    FakeReads,
    install_write_fakes,
    signer_key_for,
    submit_error,
)

FID = 12345
TARGET_HASH = "0x" + "ab" * 20
TARGET_AUTHOR = 4242


def auth_header(fid: int = FID) -> dict[str, str]:
    token = jwt.encode(
        {"fid": fid, "exp": 4_102_444_800, "source": "first_party"},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


def _signer() -> fw.Signer:
    return fw.Signer(fid=FID, private_key=b"\x01" * 32)


# ---------------------------------------------------------------------------
# Embed validation (security L5)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "https://juke.audio",
        "http://example.com/a?b=c",
        "https://example.com/" + "a" * (256 - len("https://example.com/")),
    ],
)
def test_valid_embed_urls(url):
    assert fw.is_valid_embed_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "",
        "javascript:alert(1)",
        "ftp://example.com/file",
        "data:text/html;base64,AAAA",
        "https://",
        "//example.com/no-scheme",
        "https://example.com/" + "a" * (257 - len("https://example.com/")),
        "https://example.com/" + "é" * 120,  # 260 bytes, 140 characters
    ],
)
def test_invalid_embed_urls(url):
    assert not fw.is_valid_embed_url(url)


def test_validate_embed_urls_counts_quote_toward_cap():
    assert fw.validate_embed_urls(["https://a.example"], has_quote=True) == [
        "https://a.example"
    ]
    with pytest.raises(fw.CastValidationError):
        fw.validate_embed_urls(
            ["https://a.example", "https://b.example"], has_quote=True
        )
    with pytest.raises(fw.CastValidationError):
        fw.validate_embed_urls([f"https://{i}.example" for i in range(3)])
    with pytest.raises(fw.CastValidationError):
        fw.validate_embed_urls(["javascript:alert(1)"])


@pytest.mark.parametrize("bad", ["0x1234", "ab" * 20, "0x" + "zz" * 20, ""])
def test_parse_cast_hash_rejects_malformed(bad):
    with pytest.raises(fw.CastValidationError):
        fw.parse_cast_hash(bad)


# ---------------------------------------------------------------------------
# Mentions
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_prepare_cast_mention_offsets_are_utf8_bytes():
    resolver = fw.known_mentions_resolver({"alice": 11, "bob": 22})
    prepared = await fw.prepare_cast(
        text="héllo @alice 🎧 and @bob!", resolve_username=resolver
    )

    assert prepared.text == "héllo  🎧 and !"
    assert prepared.mentions == (11, 22)
    encoded = prepared.text.encode("utf-8")
    # "héllo " is 7 bytes (é is 2); "héllo  🎧 and " adds " "(1)+🎧(4)+" and "(5).
    assert prepared.mentions_positions == (7, 17)
    assert encoded[: prepared.mentions_positions[0]].decode() == "héllo "
    assert encoded[: prepared.mentions_positions[1]].decode() == "héllo  🎧 and "


@pytest.mark.asyncio
async def test_prepare_cast_leaves_unknown_mentions_literal():
    prepared = await fw.prepare_cast(
        text="hi @ghost", resolve_username=fw.known_mentions_resolver({})
    )
    assert prepared.text == "hi @ghost"
    assert prepared.mentions == ()


@pytest.mark.asyncio
async def test_mention_resolver_caps_resolved_mentions_at_ten():
    calls: list[str] = []

    async def lookup(username: str) -> int | None:
        calls.append(username)
        return 1000 + len(calls)

    resolver = fw.MentionResolver(lookup)
    text = " ".join(f"@user{i}" for i in range(15))
    prepared = await fw.prepare_cast(text=text, resolve_username=resolver)

    assert len(prepared.mentions) == fw.MAX_RESOLVED_MENTIONS == 10
    assert len(calls) == 10
    assert "@user10" in prepared.text


@pytest.mark.asyncio
async def test_mention_resolver_caps_upstream_lookups():
    calls: list[str] = []

    async def lookup(username: str) -> int | None:
        calls.append(username)
        return None  # every name unknown: only the lookup cap bounds work

    resolver = fw.MentionResolver(lookup)
    text = " ".join(f"@nobody{i}" for i in range(50))
    await fw.prepare_cast(text=text, resolve_username=resolver)

    assert len(calls) == fw.MAX_MENTION_LOOKUPS


@pytest.mark.asyncio
async def test_mention_resolver_memoizes_case_insensitively():
    calls: list[str] = []

    async def lookup(username: str) -> int | None:
        calls.append(username)
        return 7

    resolver = fw.MentionResolver(lookup)
    assert await resolver("Alice") == 7
    assert await resolver("alice") == 7
    assert calls == ["alice"]


@pytest.mark.asyncio
async def test_lookup_username_fid_degrades_on_upstream_error(monkeypatch):
    async def failing_get(path, params=None):
        raise hypersnap.HypersnapUpstreamError("down", path=path, status_code=503)

    monkeypatch.setattr("app.clients.hypersnap.get", failing_get)
    assert await fw.lookup_username_fid("alice") is None


@pytest.mark.asyncio
async def test_fetch_username_fid_propagates_upstream_error(monkeypatch):
    async def failing_get(path, params=None):
        raise hypersnap.HypersnapUpstreamError("down", path=path, status_code=503)

    monkeypatch.setattr("app.clients.hypersnap.get", failing_get)
    with pytest.raises(hypersnap.HypersnapUpstreamError):
        await fw.fetch_username_fid("alice")


# ---------------------------------------------------------------------------
# Byte limits and emptiness
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_prepare_cast_allows_exactly_1024_bytes():
    prepared = await fw.prepare_cast(text="é" * 512)
    assert len(prepared.text.encode("utf-8")) == 1024


@pytest.mark.asyncio
async def test_prepare_cast_rejects_1025_bytes():
    with pytest.raises(fw.CastValidationError):
        await fw.prepare_cast(text="a" + "é" * 512)


@pytest.mark.asyncio
async def test_prepare_cast_limit_applies_after_mentions_are_stripped():
    # 1030 bytes as typed, 1024 once "@alice" (6 bytes) becomes a mention.
    text = "@alice " + "a" * 1023
    prepared = await fw.prepare_cast(
        text=text, resolve_username=fw.known_mentions_resolver({"alice": 1})
    )
    assert prepared.mentions == (1,)


@pytest.mark.asyncio
async def test_prepare_cast_rejects_empty():
    with pytest.raises(fw.CastValidationError):
        await fw.prepare_cast(text="   ")


# ---------------------------------------------------------------------------
# Lookups
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_parent_url_is_cached_and_unknown_is_400(monkeypatch):
    fakes = install_write_fakes(monkeypatch)
    first = await fw.resolve_channel_parent_url("neynar")
    second = await fw.resolve_channel_parent_url("neynar")
    assert first == second == "https://warpcast.com/~/channel/neynar"
    assert len(fakes.reads.calls) == 1

    with pytest.raises(fw.CastValidationError):
        await fw.resolve_channel_parent_url("missing")


@pytest.mark.asyncio
async def test_cast_author_lookup_is_cached_and_missing_is_not_found(monkeypatch):
    fakes = install_write_fakes(
        monkeypatch, reads=FakeReads(cast_authors={TARGET_HASH: TARGET_AUTHOR})
    )
    assert await fw.resolve_cast_author(TARGET_HASH.upper().replace("0X", "0x")) == (
        TARGET_AUTHOR
    )
    assert await fw.resolve_cast_author(TARGET_HASH) == TARGET_AUTHOR
    assert len(fakes.reads.calls) == 1

    with pytest.raises(fw.CastNotFoundError):
        await fw.resolve_cast_author("0x" + "cd" * 20)


# ---------------------------------------------------------------------------
# Submit semantics
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_submit_treats_duplicate_as_success(monkeypatch):
    fakes = install_write_fakes(monkeypatch)
    fakes.node.errors = [submit_error(400, err_code="bad_request.duplicate")]
    message = fm.build_link(
        FID, "add", fm.LINK_TYPE_FOLLOW, 2, signer_private_key=_signer().private_key
    )
    assert await fw.submit(message) == fm.message_hash_hex(message)


# Shape captured from the live node (haatz.quilibrium.com) for a cast signed
# by an unregistered key: HTTP 400, error_detail "...bad_request.
# validation_failure/invalid signer...". The duplicate code is the structured
# ``bad_request.duplicate``; free text alone must never classify.
@pytest.mark.parametrize(
    ("err_code", "node_message", "duplicate"),
    [
        ("bad_request.duplicate", "message has already been merged", True),
        ("bad_request.duplicate", None, True),
        ("bad_request.validation_failure", "duplicate mentions", False),
        (None, "duplicate", False),
    ],
)
def test_is_duplicate_submit_uses_structured_code_only(
    err_code, node_message, duplicate
):
    exc = submit_error(400, err_code=err_code, node_message=node_message)
    assert fw.is_duplicate_submit(exc) is duplicate


@pytest.mark.parametrize(
    ("status", "err_code", "node_message", "rejection"),
    [
        (400, "bad_request.validation_failure", "invalid signer", True),
        (400, "bad_request.validation_failure", "Invalid Signer", True),
        (400, "bad_request.validation_failure", "invalid signer: not active", True),
        (400, "bad_request.validation_failure", "unknown signer", True),
        (400, "bad_request.validation_failure", "invalid signer key length", False),
        (400, "bad_request.validation_failure", "signer revoked", False),
        (400, "bad_request", "invalid signer", False),
        (400, None, "invalid signer", False),
        (503, "bad_request.validation_failure", "invalid signer", False),
    ],
)
def test_is_signer_rejection_is_anchored(status, err_code, node_message, rejection):
    exc = submit_error(status, err_code=err_code, node_message=node_message)
    assert fw.is_signer_rejection(exc) is rejection


@pytest.mark.asyncio
async def test_submit_does_not_treat_free_text_duplicate_as_success(monkeypatch):
    fakes = install_write_fakes(monkeypatch)
    fakes.node.errors = [
        submit_error(
            400,
            err_code="bad_request.validation_failure",
            node_message="duplicate mentions",
        )
    ]
    message = fm.build_link(
        FID, "add", fm.LINK_TYPE_FOLLOW, 2, signer_private_key=_signer().private_key
    )
    with pytest.raises(fm.SubmitMessageError):
        await fw.submit(message)


@pytest.mark.asyncio
async def test_submit_propagates_other_errors(monkeypatch):
    fakes = install_write_fakes(monkeypatch)
    fakes.node.errors = [submit_error(400, err_code="bad_request.validation_failure")]
    message = fm.build_link(
        FID, "add", fm.LINK_TYPE_FOLLOW, 2, signer_private_key=_signer().private_key
    )
    with pytest.raises(fm.SubmitMessageError):
        await fw.submit(message)


@pytest.mark.asyncio
async def test_load_user_signer_returns_raw_key(monkeypatch):
    install_write_fakes(monkeypatch)
    signer = await fw.load_user_signer(None, FID)
    assert signer.fid == FID
    assert len(signer.private_key) == 32


def test_signer_repr_hides_key():
    assert "\\x01" not in repr(_signer())


def test_system_signer_requires_configuration(monkeypatch):
    monkeypatch.setattr(settings, "BRAND_FID", None)
    assert not fw.is_system_signer_configured()
    with pytest.raises(fw.SystemSignerUnavailableError):
        fw.load_system_signer()


def test_system_signer_aad_binds_brand_fid():
    assert fw.system_signer_aad(99) == "system:99"


# ---------------------------------------------------------------------------
# Router-boundary error mapping
# ---------------------------------------------------------------------------


def _mapped(exc: Exception) -> HTTPException:
    with pytest.raises(HTTPException) as raised:
        with fw.write_errors_as_http("test"):
            raise exc
    return raised.value


@pytest.mark.parametrize(
    ("exc", "status", "detail"),
    [
        (SignerNotApprovedError("x"), 403, "signer_not_linked"),
        (
            submit_error(
                400,
                err_code="bad_request.validation_failure",
                node_message="invalid signer",
            ),
            403,
            "signer_not_linked",
        ),
        (SignerDecryptError("x"), 503, "Signer temporarily unavailable"),
        (fw.SystemSignerUnavailableError("x"), 503, "Signer temporarily unavailable"),
        (fw.CastValidationError("Unknown channel"), 400, "Unknown channel"),
        (fw.CastNotFoundError("x"), 404, "Cast not found"),
        (submit_error(400, err_code="bad_request"), 400, fw.NODE_REJECTED_DETAIL),
        (submit_error(None), 502, fw.UPSTREAM_ERROR_DETAIL),
        (submit_error(503), 502, fw.UPSTREAM_ERROR_DETAIL),
        (submit_error(429), 502, fw.UPSTREAM_ERROR_DETAIL),
    ],
)
def test_write_errors_as_http(exc, status, detail):
    mapped = _mapped(exc)
    assert mapped.status_code == status
    assert mapped.detail == detail


def test_write_errors_never_leak_node_message():
    mapped = _mapped(submit_error(400, err_code="x", node_message="secret internals"))
    assert "secret" not in str(mapped.detail)


# ---------------------------------------------------------------------------
# Endpoints: each user-signed write path against a faked node
# ---------------------------------------------------------------------------


@pytest.fixture
def ledger(monkeypatch):
    recorded = AsyncMock()
    monkeypatch.setattr("app.routers.feed.record_cast", recorded)
    return recorded


@pytest.fixture
def fakes(monkeypatch, ledger):
    return install_write_fakes(
        monkeypatch, reads=FakeReads(cast_authors={TARGET_HASH: TARGET_AUTHOR})
    )


@pytest.fixture
def unlinked(monkeypatch, ledger):
    return install_write_fakes(monkeypatch, linked_fids=set())


def _assert_signed_by(message, fid: int) -> None:
    public = signer_key_for(fid).public_key().public_bytes_raw()
    assert message.signer == public
    assert message.data.fid == fid


@pytest.mark.asyncio
async def test_create_cast_with_mentions_and_embeds(client, fakes, ledger):
    fakes.reads.usernames = {"alice": 501}
    response = await client.post(
        "/v1/feed/cast",
        json={"text": "gm @alice 🎧", "embeds": ["https://juke.audio"]},
        headers=auth_header(),
    )

    assert response.status_code == 200, response.text
    message = fakes.node.submitted[0]
    _assert_signed_by(message, FID)
    body = message.data.cast_add_body
    assert body.text == "gm  🎧"
    assert list(body.mentions) == [501]
    assert list(body.mentions_positions) == [3]
    assert [e.url for e in body.embeds] == ["https://juke.audio/"]
    assert response.json() == {
        "success": True,
        "cast": {
            "hash": fm.message_hash_hex(message),
            "author": {"fid": FID},
            "text": "gm @alice 🎧",
        },
    }
    assert ledger.await_args.kwargs["cast_hash"] == fm.message_hash_hex(message)


@pytest.mark.asyncio
async def test_create_reply_resolves_parent_author(client, fakes):
    response = await client.post(
        "/v1/feed/cast",
        json={"text": "reply", "parent": TARGET_HASH},
        headers=auth_header(),
    )

    assert response.status_code == 200, response.text
    parent = fakes.node.bodies[0].cast_add_body.parent_cast_id
    assert parent.fid == TARGET_AUTHOR
    assert parent.hash == bytes.fromhex(TARGET_HASH[2:])


@pytest.mark.asyncio
async def test_create_cast_rejects_non_http_embed(client, fakes):
    response = await client.post(
        "/v1/feed/cast",
        json={"text": "x", "embeds": ["javascript:alert(1)"]},
        headers=auth_header(),
    )
    assert response.status_code in (400, 422)
    assert fakes.node.attempts == 0


@pytest.mark.asyncio
async def test_create_cast_unlinked_signer_is_403(client, unlinked):
    response = await client.post(
        "/v1/feed/cast", json={"text": "gm"}, headers=auth_header()
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "signer_not_linked"
    assert unlinked.node.attempts == 0


@pytest.mark.asyncio
async def test_delete_cast_submits_cast_remove(client, fakes):
    response = await client.delete(
        f"/v1/feed/cast/{TARGET_HASH}", headers=auth_header()
    )

    assert response.status_code == 200, response.text
    message = fakes.node.submitted[0]
    _assert_signed_by(message, FID)
    assert message.data.cast_remove_body.target_hash == bytes.fromhex(TARGET_HASH[2:])
    assert response.json() == {"success": True, "hash": fm.message_hash_hex(message)}


@pytest.mark.asyncio
async def test_delete_cast_unlinked_signer_is_403(client, unlinked):
    response = await client.delete(
        f"/v1/feed/cast/{TARGET_HASH}", headers=auth_header()
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "signer_not_linked"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "reaction_type", "message_type"),
    [
        ("POST", "like", "MESSAGE_TYPE_REACTION_ADD"),
        ("POST", "recast", "MESSAGE_TYPE_REACTION_ADD"),
        ("DELETE", "like", "MESSAGE_TYPE_REACTION_REMOVE"),
    ],
)
async def test_reactions_submit_reaction_messages(
    client, fakes, method, reaction_type, message_type
):
    response = await client.request(
        method,
        "/v1/feed/reaction",
        json={"reaction_type": reaction_type, "target": TARGET_HASH},
        headers=auth_header(),
    )

    assert response.status_code == 200, response.text
    from app.clients.proto import message_pb2

    data = fakes.node.bodies[0]
    assert data.type == getattr(message_pb2, message_type)
    assert data.reaction_body.target_cast_id.fid == TARGET_AUTHOR
    assert data.reaction_body.target_cast_id.hash == bytes.fromhex(TARGET_HASH[2:])


@pytest.mark.asyncio
async def test_reaction_on_unknown_cast_is_404(client, fakes):
    response = await client.post(
        "/v1/feed/reaction",
        json={"reaction_type": "like", "target": "0x" + "cd" * 20},
        headers=auth_header(),
    )
    assert response.status_code == 404
    assert fakes.node.attempts == 0


@pytest.mark.asyncio
async def test_reaction_unlinked_signer_is_403(client, unlinked):
    response = await client.post(
        "/v1/feed/reaction",
        json={"reaction_type": "like", "target": TARGET_HASH},
        headers=auth_header(),
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "signer_not_linked"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "message_type"),
    [("POST", "MESSAGE_TYPE_LINK_ADD"), ("DELETE", "MESSAGE_TYPE_LINK_REMOVE")],
)
async def test_follow_and_unfollow_submit_link_messages(
    client, fakes, method, message_type
):
    from app.clients.proto import message_pb2

    response = await client.request(
        method, "/v1/users/777/follow", headers=auth_header()
    )

    assert response.status_code == 200, response.text
    message = fakes.node.submitted[0]
    _assert_signed_by(message, FID)
    assert message.data.type == getattr(message_pb2, message_type)
    assert message.data.link_body.type == "follow"
    assert message.data.link_body.target_fid == 777
    assert response.json() == {"success": True, "hash": fm.message_hash_hex(message)}


@pytest.mark.asyncio
async def test_self_follow_is_400(client, fakes):
    response = await client.post(f"/v1/users/{FID}/follow", headers=auth_header())
    assert response.status_code == 400
    assert fakes.node.attempts == 0


@pytest.mark.asyncio
async def test_follow_unlinked_signer_is_403(client, unlinked):
    response = await client.post("/v1/users/777/follow", headers=auth_header())
    assert response.status_code == 403
    assert response.json()["detail"] == "signer_not_linked"


@pytest.mark.asyncio
async def test_node_signer_rejection_is_403(client, fakes):
    fakes.node.errors = [
        submit_error(
            400,
            err_code="bad_request.validation_failure",
            node_message="invalid signer: not active",
        )
    ]
    response = await client.post("/v1/users/777/follow", headers=auth_header())
    assert response.status_code == 403
    assert response.json()["detail"] == "signer_not_linked"


@pytest.mark.asyncio
async def test_node_unavailable_is_502(client, fakes):
    fakes.node.errors = [submit_error(None)]
    response = await client.post("/v1/users/777/follow", headers=auth_header())
    assert response.status_code == 502


def test_app_is_importable():
    # Guards the router wiring: every write router imports cleanly.
    assert app is not None
