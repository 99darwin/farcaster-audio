"""Unit tests for ``app.services.direct_cast_service`` and the Phase A diff."""

from __future__ import annotations

import asyncio
import json
import uuid
from types import SimpleNamespace

import pytest

from app.schemas.messages import (
    InboxResponse,
    MessageUser,
    ReactionRequest,
    SendMessageRequest,
)
from app.services import direct_cast_relay, farcaster_token_service, signer_crypto
from app.services.direct_cast_relay import InboxPoller, diff_inbox, snapshot_inbox
from app.services.direct_cast_service import (
    BROWSER_USER_AGENT,
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
    DirectCastService,
    DirectCastUpstreamError,
    FarcasterDirectCastService,
    MessagingAuthError,
    MessagingBackendUnavailable,
    MessagingError,
    MessagingViewer,
    build_direct_cast_service,
    derive_one_to_one_conversation_id,
    highlight_ranges,
    normalize_conversation,
    normalize_message,
    normalize_metadata,
    normalize_search_hit,
    normalize_user,
    split_thread_cursor,
)
from app.services.farcaster_token_service import DirectCastTokenStatus
from tests.direct_cast_fake import (
    GROUP_ID,
    ONE_TO_ONE_ID,
    OTHER_FID,
    PEER_FID,
    VIEWER_FID,
    FakeDirectCast,
    FakeRedis,
    load_fixture,
    make_service,
)
from tests.hypersnap_fake import V2, fake_hypersnap  # noqa: F401

FAKE_BEARER = "header.payload.signature-not-real"
VIEWER = MessagingViewer(fid=VIEWER_FID, bearer=FAKE_BEARER)
SENDER = MessageUser(fid=VIEWER_FID, username="alice", display_name="Alice")


STORED_DC_TOKEN = "MK-stored-dc-token"


def _stub_stored_token(
    monkeypatch, *, bearer: str | None, token_status: str = "active", error=None
) -> None:
    """Replace the ``farcaster_token_service`` reads ``authorize`` makes."""

    async def get_direct_cast_bearer(db, fid, **_):
        if error is not None:
            raise error
        return bearer

    async def get_token_status(db, fid, **_):
        return DirectCastTokenStatus(token_status, None)

    monkeypatch.setattr(
        farcaster_token_service, "get_direct_cast_bearer", get_direct_cast_bearer
    )
    monkeypatch.setattr(farcaster_token_service, "get_token_status", get_token_status)


@pytest.fixture
def fake() -> FakeDirectCast:
    return FakeDirectCast()


# ---------------------------------------------------------------------------
# Normalizers (pure)
# ---------------------------------------------------------------------------


def test_normalize_user_fallbacks():
    assert normalize_user({"fid": 5, "username": "x"}).display_name == "x"
    assert normalize_user({"fid": 5}).display_name == "!5"
    assert normalize_user({"fid": 0}) is None
    assert normalize_user({"fid": True}) is None
    assert normalize_user("nope") is None
    hydrated = normalize_user({"fid": 7, "display_name": "D", "pfp_url": "https://p"})
    assert hydrated.display_name == "D" and hydrated.pfp_url == "https://p"


def test_normalize_message_full_fixture():
    raw = load_fixture("messages")["result"]["messages"][2]
    message = normalize_message(raw)
    assert message is not None
    assert message.sender.fid == PEER_FID
    assert message.sender.pfp_url == "https://i.imgur.com/bob.png"
    assert message.sent_at == 1760600000000
    assert message.is_last_read is True
    fire, thumbs = message.reactions
    assert (fire.count, fire.viewer_reacted) == (2, True)
    assert (thumbs.count, thumbs.viewer_reacted) == (1, False)
    metadata = message.metadata
    assert metadata.medias[0].url == "https://imagedelivery.net/abc/original"
    assert metadata.medias[0].mime_type == "image/png"
    assert metadata.urls[0].title == "Juke"
    assert metadata.urls[0].image_url == "https://juke.audio/og.png"
    assert metadata.mentions[0].fid == VIEWER_FID
    assert metadata.cast_hashes == ["0xabc123"]


def test_normalize_message_reply_and_deleted():
    raws = load_fixture("messages")["result"]["messages"]
    deleted, reply = normalize_message(raws[0]), normalize_message(raws[1])
    assert deleted.is_deleted is True and deleted.text == ""
    assert reply.in_reply_to.message_id == raws[2]["messageId"]
    assert reply.in_reply_to.sender.fid == PEER_FID
    assert reply.in_reply_to.text.startswith("gm alice")


def test_normalize_message_drops_unknown_type_and_missing_ids():
    raws = load_fixture("messages")["result"]["messages"]
    assert normalize_message(raws[3]) is None
    assert normalize_message({**raws[0], "messageId": None}) is None
    assert normalize_message(None) is None


def test_normalize_message_without_sender_context_uses_sender_fid():
    raw = dict(load_fixture("messages")["result"]["messages"][1])
    raw.pop("senderContext")
    assert normalize_message(raw).sender.display_name == f"!{VIEWER_FID}"


def test_url_embed_domain_falls_back_to_host():
    metadata = normalize_metadata(
        {"urls": [{"type": "url", "openGraph": {"url": "https://www.example.com/x"}}]}
    )
    assert metadata.urls[0].domain == "www.example.com"


@pytest.mark.parametrize(
    "bad",
    [
        "javascript:alert(1)",
        "data:image/png;base64,AAAA",
        "file:///etc/passwd",
        "java\tscript://x",
        "https://",
        "//evil.example/x.png",
        "intent://x#Intent;end",
    ],
)
def test_metadata_drops_unsafe_url_schemes(bad):
    """L14: upstream-controlled URLs are relayed to clients that render and
    open them, so only https images and http(s) links pass through."""
    metadata = normalize_metadata(
        {
            "medias": [{"staticRaster": bad}, {"url": bad}],
            "urls": [
                {"openGraph": {"url": bad, "image": {"url": bad}}},
                {"openGraph": {"url": "https://ok.example/", "image": bad}},
            ],
        }
    )
    assert metadata.medias == []
    assert [u.url for u in metadata.urls] == ["https://ok.example/"]
    assert metadata.urls[0].image_url is None
    user = normalize_user({"fid": 5, "pfp": {"url": bad}, "pfp_url": bad})
    assert user.pfp_url is None
    conversation = normalize_conversation({"conversationId": "c", "photoUrl": bad})
    assert conversation.photo_url is None


def test_metadata_keeps_https_images_and_http_links():
    metadata = normalize_metadata(
        {
            "medias": [{"url": "http://plain.example/a.png"}, {"url": "https://i/a"}],
            "urls": [
                {
                    "openGraph": {
                        "url": "http://plain.example/page",
                        "image": "https://img.example/og.png",
                    }
                }
            ],
        }
    )
    assert [m.url for m in metadata.medias] == ["https://i/a"]
    assert metadata.urls[0].url == "http://plain.example/page"
    assert metadata.urls[0].image_url == "https://img.example/og.png"


def test_normalize_conversation_one_to_one_and_group():
    one, group = load_fixture("inbox")["result"]["conversations"]
    c1 = normalize_conversation(one)
    assert c1.conversation_id == ONE_TO_ONE_ID
    assert c1.counterparty.fid == PEER_FID
    assert c1.unread_count == 1
    assert c1.category == "default" and c1.access == "read-write"
    assert c1.last_message.is_deleted is True
    c2 = normalize_conversation(group)
    assert c2.is_group is True and c2.counterparty is None
    assert c2.name == "Juke builders"
    assert [p.fid for p in c2.participants] == [VIEWER_FID, PEER_FID, OTHER_FID]
    assert c2.participants[2].pfp_url is None


def test_normalize_conversation_unknown_category_defaults():
    raw = load_fixture("conversation")["result"]["conversation"]
    raw["viewerContext"]["category"] = "brand-new"
    raw["viewerContext"]["access"] = "weird"
    c = normalize_conversation(raw)
    assert c.category == "default" and c.access == "read-write"


def test_derive_conversation_id():
    assert derive_one_to_one_conversation_id(9, 3) == "3-9"
    assert derive_one_to_one_conversation_id(3, 9) == "3-9"
    with pytest.raises(MessagingError) as exc:
        derive_one_to_one_conversation_id(3, 3)
    assert exc.value.code == "invalid_recipient"


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------


async def test_inbox_sends_browser_headers_and_normalizes(fake):
    fake.route("GET", PATH_INBOX, load_fixture("inbox"))
    service = make_service(fake)
    inbox = await service.inbox(
        VIEWER, category="default", filter_="unread", cursor="abc", limit=25
    )
    assert isinstance(inbox, InboxResponse)
    assert [c.conversation_id for c in inbox.items] == [ONE_TO_ONE_ID, GROUP_ID]
    assert inbox.next_cursor == "eyJwYWdlIjoyfQ"
    assert (inbox.requests_count, inbox.has_unread_requests, inbox.has_archived) == (
        3,
        True,
        True,
    )
    call = fake.calls_to("GET", PATH_INBOX)[0]
    assert call.params == {
        "category": "default",
        "filter": "unread",
        "cursor": "abc",
        "limit": "25",
    }
    assert call.headers["authorization"] == f"Bearer {FAKE_BEARER}"
    assert call.headers["origin"] == "https://farcaster.xyz"
    assert call.headers["referer"] == "https://farcaster.xyz/"
    assert call.headers["user-agent"] == BROWSER_USER_AGENT
    assert call.headers["accept"] == "application/json"


@pytest.mark.parametrize(
    ("upstream", "status", "code"),
    [
        (401, 403, "messaging_token_rejected"),
        (403, 403, "upstream_forbidden"),
        (404, 404, "not_found"),
        (429, 429, "upstream_rate_limited"),
        (400, 422, "upstream_rejected"),
        (500, 502, "upstream_error"),
    ],
)
async def test_upstream_error_mapping(fake, upstream, status, code):
    fake.route("GET", PATH_INBOX, (upstream, load_fixture("error_401")))
    service = make_service(fake)
    with pytest.raises(DirectCastUpstreamError) as exc:
        await service.inbox(
            VIEWER, category="default", filter_=None, cursor=None, limit=25
        )
    assert (exc.value.status_code, exc.value.code) == (status, code)
    assert exc.value.upstream_status == upstream
    assert FAKE_BEARER not in str(exc.value)
    assert FAKE_BEARER not in repr(exc.value)
    assert exc.value.__cause__ is None


async def test_5xx_is_retried_then_succeeds(fake):
    fake.route("GET", PATH_INBOX, [(503, {}), load_fixture("inbox")])
    service = make_service(fake)
    inbox = await service.inbox(
        VIEWER, category="default", filter_=None, cursor=None, limit=25
    )
    assert len(inbox.items) == 2
    assert len(fake.calls_to("GET", PATH_INBOX)) == 2


async def test_cloudflare_html_is_upstream_error(fake):
    fake.route("GET", PATH_INBOX, (200, "<html>Just a moment...</html>"))
    service = make_service(fake)
    with pytest.raises(DirectCastUpstreamError) as exc:
        await service.inbox(
            VIEWER, category="default", filter_=None, cursor=None, limit=25
        )
    assert exc.value.code == "upstream_error"


async def test_missing_result_is_upstream_error(fake):
    fake.route("GET", PATH_INBOX, {"next": None})
    service = make_service(fake)
    with pytest.raises(DirectCastUpstreamError):
        await service.inbox(
            VIEWER, category="default", filter_=None, cursor=None, limit=25
        )


async def test_viewer_without_bearer_is_refused_before_upstream(fake):
    service = make_service(fake)
    with pytest.raises(MessagingAuthError):
        await service.recent_messages(MessagingViewer(fid=VIEWER_FID), ONE_TO_ONE_ID)
    assert fake.calls == []


def test_viewer_repr_hides_bearer():
    assert FAKE_BEARER not in repr(VIEWER)


async def test_read_cache_hits_within_ttl_and_is_per_fid(fake):
    fake.route("GET", PATH_RECENT_MESSAGES, load_fixture("recent_messages"))
    service = make_service(fake, FakeRedis(), cache_ttl_seconds=3)
    first = await service.recent_messages(VIEWER, ONE_TO_ONE_ID)
    second = await service.recent_messages(VIEWER, ONE_TO_ONE_ID)
    assert first == second
    assert len(fake.calls_to("GET", PATH_RECENT_MESSAGES)) == 1
    other = MessagingViewer(fid=PEER_FID, bearer=FAKE_BEARER)
    await service.recent_messages(other, ONE_TO_ONE_ID)
    assert len(fake.calls_to("GET", PATH_RECENT_MESSAGES)) == 2


async def test_cache_never_stores_bearer(fake):
    redis = FakeRedis()
    fake.route("GET", PATH_RECENT_MESSAGES, load_fixture("recent_messages"))
    service = make_service(fake, redis, cache_ttl_seconds=3)
    await service.recent_messages(VIEWER, ONE_TO_ONE_ID)
    assert redis.store
    for key, (value, _) in redis.store.items():
        assert FAKE_BEARER not in key and FAKE_BEARER not in str(value)


async def test_messages_403_is_empty_new_conversation(fake):
    fake.route("GET", PATH_MESSAGES, (403, {"errors": [{"message": "Forbidden"}]}))
    service = make_service(fake)
    page = await service.messages(
        VIEWER, "1001-4242", cursor=None, anchor_message_id=None, limit=30
    )
    assert page.items == [] and page.next_cursor is None


async def test_messages_anchor_maps_to_message_id(fake):
    fake.route("GET", PATH_MESSAGES, load_fixture("messages"))
    service = make_service(fake)
    page = await service.messages(
        VIEWER, ONE_TO_ONE_ID, cursor=None, anchor_message_id="m-1", limit=30
    )
    assert len(page.items) == 3  # unknown type dropped
    assert page.next_cursor is not None
    params = fake.calls_to("GET", PATH_MESSAGES)[0].params
    assert params == {
        "conversationId": ONE_TO_ONE_ID,
        "messageId": "m-1",
        "limit": "30",
    }


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------


def _send_request(**overrides) -> SendMessageRequest:
    fields = {
        "conversation_id": None,
        "recipient_fids": [PEER_FID],
        "message_id": uuid.uuid4(),
        "text": "gm https://juke.audio",
        "in_reply_to_id": None,
    }
    fields.update(overrides)
    return SendMessageRequest(**fields)


async def test_send_new_conversation_derives_id_and_idempotency(fake):
    fake.route("PUT", PATH_METADATA, load_fixture("metadata"))
    fake.route("PUT", PATH_SEND, load_fixture("send_success"))
    service = make_service(fake)
    body = _send_request(in_reply_to_id="a1b2c3d4-0001-4000-8000-000000000001")
    message = await service.send(VIEWER, body, sender=SENDER)
    send_call = fake.calls_to("PUT", PATH_SEND)[0]
    assert send_call.headers["idempotency-key"] == str(body.message_id)
    assert send_call.json["conversationId"] == ONE_TO_ONE_ID
    assert send_call.json["recipientFids"] == [PEER_FID]
    assert send_call.json["type"] == "text"
    assert send_call.json["messageId"] == str(body.message_id)
    assert send_call.json["inReplyToId"] == "a1b2c3d4-0001-4000-8000-000000000001"
    assert send_call.json["clientProcessedMetadata"]["casts"] == [{"hash": "0xabc123"}]
    assert fake.calls_to("PUT", PATH_METADATA)[0].json == {"message": body.text}
    assert message.conversation_id == ONE_TO_ONE_ID
    assert message.sender == SENDER
    assert message.metadata.urls[0].domain == "juke.audio"
    assert message.message_id == str(body.message_id)


async def test_send_existing_conversation_skips_metadata_when_disabled(fake):
    fake.route("PUT", PATH_SEND, load_fixture("send_success"))
    service = make_service(fake)
    body = _send_request(
        conversation_id=GROUP_ID, recipient_fids=[], process_metadata=False
    )
    message = await service.send(VIEWER, body, sender=SENDER)
    assert message.conversation_id == GROUP_ID
    assert fake.calls_to("PUT", PATH_METADATA) == []
    send_call = fake.calls_to("PUT", PATH_SEND)[0]
    assert "inReplyToId" not in send_call.json
    assert "clientProcessedMetadata" not in send_call.json


async def test_send_metadata_failure_is_best_effort(fake):
    fake.route("PUT", PATH_METADATA, (500, {}))
    fake.route("PUT", PATH_SEND, load_fixture("send_success"))
    service = make_service(fake)
    message = await service.send(VIEWER, _send_request(), sender=SENDER)
    assert message.metadata is None
    assert "clientProcessedMetadata" not in fake.calls_to("PUT", PATH_SEND)[0].json


async def test_send_metadata_401_aborts(fake):
    fake.route("PUT", PATH_METADATA, (401, load_fixture("error_401")))
    service = make_service(fake)
    with pytest.raises(DirectCastUpstreamError) as exc:
        await service.send(VIEWER, _send_request(), sender=SENDER)
    assert exc.value.code == "messaging_token_rejected"
    assert fake.calls_to("PUT", PATH_SEND) == []


async def test_send_unsuccessful_result_is_error(fake):
    fake.route("PUT", PATH_METADATA, load_fixture("metadata_empty"))
    fake.route("PUT", PATH_SEND, load_fixture("send_failure"))
    service = make_service(fake)
    with pytest.raises(DirectCastUpstreamError):
        await service.send(VIEWER, _send_request(), sender=SENDER)


async def test_send_to_self_or_as_other_is_refused(fake):
    service = make_service(fake)
    with pytest.raises(MessagingError) as self_send:
        await service.send(
            VIEWER, _send_request(recipient_fids=[VIEWER_FID]), sender=SENDER
        )
    assert self_send.value.code == "invalid_recipient"
    with pytest.raises(MessagingError) as spoof:
        await service.send(
            VIEWER,
            _send_request(),
            sender=MessageUser(fid=PEER_FID, display_name="Bob"),
        )
    assert spoof.value.code == "sender_mismatch"
    assert fake.calls == []


@pytest.mark.parametrize(("remove", "method"), [(False, "PUT"), (True, "DELETE")])
async def test_react_body_and_method(fake, remove, method):
    fake.route(method, PATH_REACTION, load_fixture("success"))
    service = make_service(fake)
    body = ReactionRequest(
        conversation_id=ONE_TO_ONE_ID, message_id="m-1", reaction="\U0001f525"
    )
    await service.react(VIEWER, body, remove=remove)
    assert fake.calls_to(method, PATH_REACTION)[0].json == {
        "conversationId": ONE_TO_ONE_ID,
        "messageId": "m-1",
        "reaction": "\U0001f525",
    }


async def test_mark_read_unread_delete(fake):
    for method, path in (
        ("POST", PATH_MARK_READ),
        ("POST", PATH_MARK_UNREAD),
        ("DELETE", PATH_DELETE_MESSAGE),
    ):
        fake.route(method, path, load_fixture("success"))
    service = make_service(fake)
    await service.mark_read(VIEWER, ONE_TO_ONE_ID)
    await service.mark_unread(VIEWER, ONE_TO_ONE_ID)
    await service.delete_message(VIEWER, ONE_TO_ONE_ID, "m-1")
    assert fake.calls_to("POST", PATH_MARK_READ)[0].json == {
        "conversationId": ONE_TO_ONE_ID
    }
    assert fake.calls_to("POST", PATH_MARK_UNREAD)[0].json == {
        "conversationId": ONE_TO_ONE_ID
    }
    assert fake.calls_to("DELETE", PATH_DELETE_MESSAGE)[0].json == {
        "conversationId": ONE_TO_ONE_ID,
        "messageId": "m-1",
    }


async def test_write_without_success_flag_is_error(fake):
    fake.route("POST", PATH_MARK_READ, {"result": {}})
    service = make_service(fake)
    with pytest.raises(DirectCastUpstreamError):
        await service.mark_read(VIEWER, ONE_TO_ONE_ID)


async def test_preview_metadata(fake):
    fake.route("PUT", PATH_METADATA, load_fixture("metadata"))
    fake_empty = FakeDirectCast()
    fake_empty.route("PUT", PATH_METADATA, load_fixture("metadata_empty"))
    metadata = await make_service(fake).preview_metadata(VIEWER, "gm")
    assert metadata.urls[0].url == "https://juke.audio"
    empty = await make_service(fake_empty).preview_metadata(VIEWER, "gm")
    assert empty.urls == [] and empty.medias == []


# ---------------------------------------------------------------------------
# Reactors / search / recipients
# ---------------------------------------------------------------------------


async def test_reactors_hydrates_profiles_with_fallback(fake):
    fake.route("GET", PATH_REACTION, load_fixture("reactions"))
    looked_up: list[list[int]] = []

    async def lookup(fids):
        looked_up.append(list(fids))
        return {OTHER_FID: MessageUser(fid=OTHER_FID, display_name="Carol")}

    service = make_service(fake, user_lookup=lookup)
    page = await service.reactors(VIEWER, ONE_TO_ONE_ID, "m-1", cursor=None, limit=50)
    assert [e.user.display_name for e in page.items] == [
        f"!{VIEWER_FID}",
        "Carol",
        "!9999",
    ]
    assert page.next_cursor == "cmVhY3Rpb25zOjI"
    assert looked_up == [[VIEWER_FID, OTHER_FID, 9999]]


async def test_lookup_users_via_hypersnap(fake_hypersnap):  # noqa: F811
    from app.services.direct_cast_service import lookup_users_via_hypersnap

    fake_hypersnap.route(
        f"{V2}/user/bulk",
        {"users": [{"fid": OTHER_FID, "username": "carol", "display_name": "Carol"}]},
    )
    profiles = await lookup_users_via_hypersnap([OTHER_FID, OTHER_FID])
    assert profiles[OTHER_FID].display_name == "Carol"
    assert await lookup_users_via_hypersnap([]) == {}


async def test_global_search(fake):
    fake.route("GET", PATH_MESSAGE_SEARCH, load_fixture("search"))
    service = make_service(fake)
    page = await service.search_messages(
        VIEWER, "gm", conversation_id=None, cursor=None, limit=20
    )
    assert len(page.items) == 2
    hit = page.items[0]
    assert hit.highlights == ["gm <em>alice</em>"]
    assert [m.text for m in hit.after] == ["gm bob"]
    assert page.next_cursor == "c2VhcmNoOjI"
    assert fake.calls_to("GET", PATH_MESSAGE_SEARCH)[0].params == {
        "query": "gm",
        "limit": "20",
    }


async def test_in_thread_search_filters_and_scans_pages(fake):
    search = load_fixture("search")
    last_page = {**search, "next": None}
    fake.route("GET", PATH_MESSAGE_SEARCH, [search, search, last_page])
    service = make_service(fake)
    page = await service.search_messages(
        VIEWER, "gm", conversation_id=GROUP_ID, cursor=None, limit=5
    )
    assert {h.conversation.conversation_id for h in page.items} == {GROUP_ID}
    assert len(page.items) == 3
    assert page.next_cursor is None
    assert len(fake.calls_to("GET", PATH_MESSAGE_SEARCH)) == 3


async def test_in_thread_search_stops_at_limit(fake):
    fake.route("GET", PATH_MESSAGE_SEARCH, load_fixture("search"))
    service = make_service(fake)
    page = await service.search_messages(
        VIEWER, "gm", conversation_id=ONE_TO_ONE_ID, cursor=None, limit=1
    )
    assert len(page.items) == 1
    # The page's only match fit exactly: resume at the next upstream page.
    assert page.next_cursor == "c2VhcmNoOjI"
    assert len(fake.calls_to("GET", PATH_MESSAGE_SEARCH)) == 1


async def test_search_conversations(fake):
    fake.route("GET", PATH_INBOX_SEARCH, load_fixture("search_inbox"))
    service = make_service(fake)
    page = await service.search_conversations(
        VIEWER, "juke", category="default", cursor=None, limit=20
    )
    assert [c.conversation_id for c in page.items] == [GROUP_ID]
    assert fake.calls_to("GET", PATH_INBOX_SEARCH)[0].params["q"] == "juke"


async def test_recipients_exclude_self(fake):
    fake.route("GET", PATH_RECIPIENTS, load_fixture("users"))
    service = make_service(fake)
    page = await service.search_recipients(VIEWER, "b", cursor=None, limit=20)
    assert [u.fid for u in page.items] == [PEER_FID, OTHER_FID]
    assert fake.calls_to("GET", PATH_RECIPIENTS)[0].params["excludeFids"] == str(
        VIEWER_FID
    )


# ---------------------------------------------------------------------------
# authorize (docs section 3.2)
# ---------------------------------------------------------------------------


async def test_authorize_uses_stored_dc_token(fake, monkeypatch):
    _stub_stored_token(monkeypatch, bearer=STORED_DC_TOKEN)
    viewer = await make_service(fake).authorize(SimpleNamespace(), fid=VIEWER_FID)
    assert viewer == MessagingViewer(fid=VIEWER_FID, bearer=STORED_DC_TOKEN)
    assert STORED_DC_TOKEN not in repr(viewer)


@pytest.mark.parametrize(
    ("token_status", "code"),
    [("missing", "messaging_token_missing"), ("expired", "messaging_token_expired")],
)
async def test_authorize_without_usable_token_is_403(
    fake, monkeypatch, token_status, code
):
    _stub_stored_token(monkeypatch, bearer=None, token_status=token_status)
    with pytest.raises(MessagingAuthError) as exc:
        await make_service(fake).authorize(None, fid=VIEWER_FID)
    assert (exc.value.status_code, exc.value.code) == (403, code)
    assert fake.calls == []


@pytest.mark.parametrize(
    "error",
    [signer_crypto.SignerKeyConfigError("cfg"), signer_crypto.SignerDecryptError("x")],
)
async def test_authorize_undecryptable_token_is_503(fake, monkeypatch, error):
    _stub_stored_token(monkeypatch, bearer=None, error=error)
    with pytest.raises(MessagingAuthError) as exc:
        await make_service(fake).authorize(None, fid=VIEWER_FID)
    assert (exc.value.status_code, exc.value.code) == (
        503,
        "messaging_token_unavailable",
    )
    assert exc.value.__cause__ is None


def test_build_service_selects_backend():
    farcaster = build_direct_cast_service(
        SimpleNamespace(MESSAGING_BACKEND="farcaster"), FakeRedis()
    )
    assert isinstance(farcaster, FarcasterDirectCastService)
    assert isinstance(farcaster, DirectCastService)
    with pytest.raises(MessagingBackendUnavailable):
        build_direct_cast_service(SimpleNamespace(MESSAGING_BACKEND="native"), None)


# ---------------------------------------------------------------------------
# Phase A diff + poller
# ---------------------------------------------------------------------------


def _inbox(conversations) -> InboxResponse:
    return InboxResponse(
        items=conversations,
        requests_count=0,
        has_unread_requests=False,
        has_archived=False,
    )


def _conversations():
    raw = load_fixture("inbox")["result"]["conversations"]
    return [normalize_conversation(item) for item in raw]


def test_diff_first_tick_is_baseline():
    assert diff_inbox(None, _inbox(_conversations())) == []


def test_diff_detects_new_message_read_and_removal():
    one, group = _conversations()
    previous = snapshot_inbox(_inbox([one, group]))
    new_last = one.last_message.model_copy(
        update={"message_id": "new-id", "sent_at": one.last_message.sent_at + 1}
    )
    one_new = one.model_copy(update={"last_message": new_last, "unread_count": 2})
    group_read = group.model_copy(update={"last_read_at": group.last_read_at + 1})
    events = diff_inbox(previous, _inbox([one_new, group_read]))
    assert [(e.type, e.conversation_id) for e in events] == [
        ("message", ONE_TO_ONE_ID),
        ("read", GROUP_ID),
    ]
    assert events[0].message.message_id == "new-id"

    removed = diff_inbox(previous, _inbox([one]))
    assert [(e.type, e.conversation_id) for e in removed] == [("inbox", GROUP_ID)]
    assert diff_inbox(previous, _inbox([one, group])) == []


def test_diff_unread_increase_without_new_last_is_inbox():
    one, group = _conversations()
    previous = snapshot_inbox(_inbox([one, group]))
    bumped = one.model_copy(update={"unread_count": one.unread_count + 1})
    events = diff_inbox(previous, _inbox([bumped, group]))
    assert [(e.type, e.conversation_id) for e in events] == [("inbox", ONE_TO_ONE_ID)]


class _NullSession:
    async def __aenter__(self):
        return SimpleNamespace()

    async def __aexit__(self, *exc):
        return False


async def test_poller_publishes_diff_and_takes_lock(fake, monkeypatch):
    _stub_stored_token(monkeypatch, bearer=STORED_DC_TOKEN)
    inbox = load_fixture("inbox")
    changed = json.loads(json.dumps(inbox))
    last = changed["result"]["conversations"][0]["lastMessage"]
    last["messageId"] = "fresh"
    last["serverTimestamp"] += 1  # newer than the previous tick's watermark
    fake.route("GET", PATH_INBOX, [inbox, changed])
    redis = FakeRedis()
    service = make_service(fake, redis)
    poller = InboxPoller(
        service=service, redis=redis, session_factory=_NullSession, interval_seconds=0
    )
    assert await poller.tick(VIEWER_FID) == 0  # baseline
    await asyncio.sleep(0.01)  # let the 1 ms tick lock lapse
    assert await poller.tick(VIEWER_FID) == 1
    channel, payload = redis.published[-1]
    assert channel == direct_cast_relay.events_channel(VIEWER_FID)
    frame = json.loads(payload)
    assert frame["type"] == "message" and frame["message"]["message_id"] == "fresh"

    long_poller = InboxPoller(
        service=service, redis=redis, session_factory=_NullSession, interval_seconds=60
    )
    await asyncio.sleep(0.01)
    assert await long_poller.tick(VIEWER_FID) == 0  # wins lock, no change
    assert await long_poller.tick(VIEWER_FID) == 0  # lock held: skipped
    assert len(fake.calls_to("GET", PATH_INBOX)) == 3
    # Every tick acts with the stored custody-minted token (no JFS mint).
    assert {c.headers["authorization"] for c in fake.calls_to("GET", PATH_INBOX)} == {
        f"Bearer {STORED_DC_TOKEN}"
    }


async def test_poller_tick_without_token_raises_403(fake, monkeypatch):
    _stub_stored_token(monkeypatch, bearer=None, token_status="expired")
    poller = InboxPoller(
        service=make_service(fake),
        redis=FakeRedis(),
        session_factory=_NullSession,
        interval_seconds=0,
    )
    with pytest.raises(MessagingAuthError) as exc:
        await poller.tick(VIEWER_FID)
    assert exc.value.code == "messaging_token_expired"
    assert fake.calls == []


# ---------------------------------------------------------------------------
# Round 2 contract additions
# ---------------------------------------------------------------------------


def _b64(value) -> str:
    import base64

    return base64.b64encode(json.dumps(value).encode()).decode().rstrip("=")


def _unb64(value: str):
    import base64

    return json.loads(base64.b64decode(value + "=" * (-len(value) % 4)))


def test_peer_last_read_at_one_to_one_only():
    raw = load_fixture("inbox")["result"]["conversations"]
    one, group = (normalize_conversation(item) for item in raw)
    assert one.peer_last_read_at == 1760600060000
    assert group.peer_last_read_at is None
    missing = {k: v for k, v in raw[0].items() if k != "lastReadTime"}
    assert normalize_conversation(missing).peer_last_read_at is None
    assert normalize_conversation({**raw[0], "lastReadTime": 0}).peer_last_read_at == 0


def test_split_thread_cursor():
    assert split_thread_cursor(None) == (None, None)
    assert split_thread_cursor("not-json!") == ("not-json!", None)
    older, newer = split_thread_cursor(
        _b64({"page": 1, "limit": 20, "before": 5, "after": 9, "midpoint": 7})
    )
    assert _unb64(older) == {"limit": 20, "page": 1, "before": 5}
    assert _unb64(newer) == {"limit": 20, "page": 1, "after": 9}
    only_older, no_newer = split_thread_cursor(_b64({"before": 5}))
    assert _unb64(only_older) == {"before": 5} and no_newer is None
    no_older, only_newer = split_thread_cursor(_b64({"after": 9, "before": None}))
    assert no_older is None and _unb64(only_newer) == {"after": 9}
    # urlsafe alphabet decodes too
    import base64

    urlsafe = base64.urlsafe_b64encode(b'{"before":"??>>"}').decode().rstrip("=")
    assert _unb64(split_thread_cursor(urlsafe)[0]) == {"before": "??>>"}


async def test_messages_newest_first_and_cursor_passthrough(fake):
    raw = load_fixture("messages")
    raw["result"]["messages"].reverse()  # upstream order is not trusted
    fake.route("GET", PATH_MESSAGES, raw)
    service = make_service(fake)
    page = await service.messages(
        VIEWER, ONE_TO_ONE_ID, cursor=None, anchor_message_id=None, limit=30
    )
    sent = [m.sent_at for m in page.items]
    assert sent == sorted(sent, reverse=True)
    # {"before": ...} round-trips byte-identically; no newer direction.
    assert page.next_cursor == load_fixture("messages")["next"]["cursor"]
    assert page.next_newer_cursor is None


async def test_messages_newer_cursor_is_forwarded(fake):
    fake.route("GET", PATH_MESSAGES, {**load_fixture("messages"), "next": None})
    service = make_service(fake)
    newer = _b64({"page": 1, "limit": 30, "after": 9})
    page = await service.messages(
        VIEWER, ONE_TO_ONE_ID, cursor=newer, anchor_message_id=None, limit=30
    )
    assert fake.calls_to("GET", PATH_MESSAGES)[0].params["cursor"] == newer
    assert page.next_cursor is None and page.next_newer_cursor is None


@pytest.mark.parametrize(
    ("text", "snippets", "ranges", "terms"),
    [
        # exact snippet located in text
        ("gm alice", ["gm <fc_highlight>alice</fc_highlight>"], [(3, 8)], ["alice"]),
        # multiple tags, multi-line snippet
        (
            "hello\nworld hello",
            [
                "<fc_highlight>hello</fc_highlight>\nworld <fc_highlight>hello</fc_highlight>"
            ],
            [(0, 5), (12, 17)],
            ["hello"],
        ),
        # truncated snippet: fall back to case-insensitive term search
        ("Alice met alice", ["…met <em>ALICE</em>"], [(0, 5), (10, 15)], ["ALICE"]),
        # UTF-16 offsets: the emoji is two code units
        (
            "\U0001f600 gm",
            ["\U0001f600 <fc_highlight>gm</fc_highlight>"],
            [(3, 5)],
            ["gm"],
        ),
        # overlapping snippets merge; no tags yields nothing
        (
            "abc abc",
            ["<em>abc</em> abc", "abc <em>abc</em>", "plain"],
            [(0, 3), (4, 7)],
            ["abc"],
        ),
        ("x", [], [], []),
    ],
)
def test_highlight_ranges(text, snippets, ranges, terms):
    got_ranges, got_terms = highlight_ranges(text, snippets)
    assert [(r.start, r.end) for r in got_ranges] == ranges
    assert got_terms == terms


def test_search_hit_context_newest_first_and_cursors():
    raw = load_fixture("search")["result"]["searchResults"][0]
    raw = {
        **raw,
        "surroundingMessagesCursor": _b64({"before": 1, "after": 2}),
        "highlights": ["gm <fc_highlight>alice</fc_highlight>", 7],
    }
    hit = normalize_search_hit(raw)
    assert hit.highlights == ["gm <fc_highlight>alice</fc_highlight>"]
    assert [(r.start, r.end) for r in hit.highlight_ranges] == [(3, 8)]
    assert _unb64(hit.thread_cursor) == {"before": 1}
    assert _unb64(hit.thread_newer_cursor) == {"after": 2}
    for context in (hit.before, hit.after):
        sent = [m.sent_at for m in context]
        assert sent == sorted(sent, reverse=True)


async def test_conversation_with_derives_id_and_validates_peer(fake):
    fake.route("GET", PATH_CONVERSATION, load_fixture("conversation"))
    service = make_service(fake)
    conversation = await service.conversation_with(VIEWER, PEER_FID)
    assert conversation.conversation_id == ONE_TO_ONE_ID
    # Upstream returning someone else's conversation is treated as missing.
    with pytest.raises(MessagingError) as exc:
        await service.conversation_with(VIEWER, OTHER_FID)
    assert (exc.value.status_code, exc.value.code) == (404, "conversation_not_found")
    with pytest.raises(MessagingError) as exc:
        await service.conversation_with(VIEWER, VIEWER_FID)
    assert exc.value.code == "invalid_recipient"


async def test_conversation_with_group_result_is_404(fake):
    raw = load_fixture("conversation")
    raw["result"]["conversation"]["isGroup"] = True
    fake.route("GET", PATH_CONVERSATION, raw)
    with pytest.raises(MessagingError) as exc:
        await make_service(fake).conversation_with(VIEWER, PEER_FID)
    assert exc.value.code == "conversation_not_found"


async def test_conversation_with_other_upstream_errors_propagate(fake):
    fake.route("GET", PATH_CONVERSATION, (401, {}))
    with pytest.raises(DirectCastUpstreamError) as exc:
        await make_service(fake).conversation_with(VIEWER, PEER_FID)
    assert exc.value.code == "messaging_token_rejected"


async def test_accept_decline_require_success(fake):
    fake.route("POST", PATH_CATEGORIZATION, {"result": {"success": False}})
    service = make_service(fake)
    for call in (service.accept_request, service.decline_request):
        with pytest.raises(DirectCastUpstreamError):
            await call(VIEWER, ONE_TO_ONE_ID)
    bodies = [c.json["category"] for c in fake.calls_to("POST", PATH_CATEGORIZATION)]
    assert bodies == ["default", "deleted"]


def test_farcaster_service_satisfies_protocol():
    assert isinstance(make_service(FakeDirectCast()), DirectCastService)


def test_diff_peer_read_and_legacy_snapshot():
    one, group = _conversations()
    previous = snapshot_inbox(_inbox([one, group]))
    peer_read = one.model_copy(update={"peer_last_read_at": one.peer_last_read_at + 1})
    events = diff_inbox(previous, _inbox([peer_read, group]))
    assert [(e.type, e.conversation_id, e.read_by) for e in events] == [
        ("read", ONE_TO_ONE_ID, "peer")
    ]
    viewer_read = one.model_copy(update={"last_read_at": one.last_read_at + 1})
    events = diff_inbox(previous, _inbox([viewer_read, group]))
    assert [e.read_by for e in events] == ["viewer"]
    # Three-field snapshots from before peer_last_read_at existed: no spurious
    # peer event on upgrade.
    legacy = {cid: entry[:3] for cid, entry in previous.items()}
    assert diff_inbox(legacy, _inbox([peer_read, group])) == []


# ---------------------------------------------------------------------------
# Round 3: send echo, upstream 400, rejected token, scoped search paging
# ---------------------------------------------------------------------------

QUOTED_ID = "a1b2c3d4-0002-4000-8000-000000000002"


async def test_send_echo_quotes_parent_from_recent_cache(fake):
    fake.route("GET", PATH_RECENT_MESSAGES, load_fixture("recent_messages"))
    fake.route("PUT", PATH_SEND, load_fixture("send_success"))
    service = make_service(fake, FakeRedis(), cache_ttl_seconds=60)
    await service.recent_messages(VIEWER, ONE_TO_ONE_ID)  # warms the cache
    body = _send_request(
        conversation_id=ONE_TO_ONE_ID,
        in_reply_to_id=QUOTED_ID,
        process_metadata=False,
    )
    message = await service.send(VIEWER, body, sender=SENDER)
    assert message.in_reply_to is not None
    assert message.in_reply_to.message_id == QUOTED_ID
    assert message.in_reply_to.text == "gm bob"
    assert message.in_reply_to.sender.fid == VIEWER_FID
    assert fake.calls_to("PUT", PATH_SEND)[0].json["inReplyToId"] == QUOTED_ID
    # The quote never costs an extra upstream read.
    assert len(fake.calls_to("GET", PATH_RECENT_MESSAGES)) == 1


async def test_send_echo_minimal_quote_when_parent_not_cached(fake):
    fake.route("PUT", PATH_SEND, load_fixture("send_success"))
    service = make_service(fake)
    body = _send_request(in_reply_to_id=QUOTED_ID, process_metadata=False)
    message = await service.send(VIEWER, body, sender=SENDER)
    quote = message.in_reply_to
    assert quote is not None
    assert (quote.message_id, quote.text, quote.sender.fid) == (QUOTED_ID, "", 0)
    assert fake.calls_to("GET", PATH_RECENT_MESSAGES) == []


async def test_send_echo_without_reply_has_no_quote(fake):
    fake.route("PUT", PATH_SEND, load_fixture("send_success"))
    message = await make_service(fake).send(
        VIEWER, _send_request(process_metadata=False), sender=SENDER
    )
    assert message.in_reply_to is None


@pytest.mark.parametrize(
    "result",
    [
        {"success": True, "serverTimestamp": 1_760_000_000_123},
        {"success": True, "message": {"serverTimestamp": 1_760_000_000_123}},
    ],
)
async def test_send_echo_prefers_upstream_timestamp(fake, result):
    fake.route("PUT", PATH_SEND, {"result": result})
    message = await make_service(fake).send(
        VIEWER, _send_request(process_metadata=False), sender=SENDER
    )
    assert message.sent_at == 1_760_000_000_123


async def test_send_echo_falls_back_to_proxy_clock(fake, monkeypatch):
    from app.services import direct_cast_service

    monkeypatch.setattr(direct_cast_service, "_now_ms", lambda: 42)
    fake.route("PUT", PATH_SEND, load_fixture("send_success"))
    message = await make_service(fake).send(
        VIEWER, _send_request(process_metadata=False), sender=SENDER
    )
    assert message.sent_at == 42


async def test_upstream_400_carries_sanitized_capped_message(fake):
    noisy = (
        f"Bearer {FAKE_BEARER} rejected: message too long\x00\n"
        + "eyJhbGciOiJIUzI1NiJ9" * 3
        + " x" * 400
    )
    fake.route("PUT", PATH_SEND, (400, {"errors": [{"message": noisy}]}))
    with pytest.raises(DirectCastUpstreamError) as exc:
        await make_service(fake).send(
            VIEWER, _send_request(process_metadata=False), sender=SENDER
        )
    assert (exc.value.status_code, exc.value.code) == (422, "upstream_rejected")
    message = exc.value.client_message
    assert message is not None and "message too long" in message
    assert FAKE_BEARER not in message and "eyJhbGci" not in message
    assert "\x00" not in message and "\n" not in message
    assert len(message) <= 200


@pytest.mark.parametrize(
    "body", [{}, {"errors": "nope"}, ["x"], {"message": 7}, {"message": "   "}]
)
async def test_upstream_400_without_usable_message(fake, body):
    fake.route("GET", PATH_INBOX, (400, body))
    with pytest.raises(DirectCastUpstreamError) as exc:
        await make_service(fake).inbox(
            VIEWER, category="default", filter_=None, cursor=None, limit=25
        )
    assert exc.value.code == "upstream_rejected"
    assert exc.value.client_message is None


async def test_only_400_exposes_upstream_message(fake):
    fake.route("GET", PATH_INBOX, (403, {"message": "secret internals"}))
    with pytest.raises(DirectCastUpstreamError) as exc:
        await make_service(fake).inbox(
            VIEWER, category="default", filter_=None, cursor=None, limit=25
        )
    assert exc.value.client_message is None


async def test_upstream_401_reports_rejected_token(fake):
    rejected: list[tuple[int, str]] = []

    async def on_rejected(fid, bearer):
        rejected.append((fid, bearer))

    fake.route("GET", PATH_INBOX, (401, load_fixture("error_401")))
    service = make_service(fake, on_token_rejected=on_rejected)
    with pytest.raises(DirectCastUpstreamError) as exc:
        await service.inbox(
            VIEWER, category="default", filter_=None, cursor=None, limit=25
        )
    assert exc.value.code == "messaging_token_rejected"
    assert rejected == [(VIEWER_FID, FAKE_BEARER)]


async def test_non_401_does_not_report_rejected_token(fake):
    rejected = []

    async def on_rejected(fid, bearer):
        rejected.append(fid)

    fake.route("GET", PATH_INBOX, (403, {}))
    service = make_service(fake, on_token_rejected=on_rejected)
    with pytest.raises(DirectCastUpstreamError):
        await service.inbox(
            VIEWER, category="default", filter_=None, cursor=None, limit=25
        )
    assert rejected == []


class _BrokenSessionFactory:
    def __call__(self):
        return self

    async def __aenter__(self):
        from sqlalchemy.exc import OperationalError

        raise OperationalError("SELECT 1", {}, Exception("db down"))

    async def __aexit__(self, *exc):
        return False


async def test_revoke_rejected_token_is_best_effort(caplog):
    from app.services.direct_cast_service import revoke_rejected_token

    await revoke_rejected_token(_BrokenSessionFactory(), VIEWER_FID, FAKE_BEARER)
    assert "could not revoke" in caplog.text
    assert FAKE_BEARER not in caplog.text


def _search_page(message_ids, *, cursor, conversation_id=ONE_TO_ONE_ID):
    template = load_fixture("search")["result"]["searchResults"][0]
    results = []
    for message_id in message_ids:
        hit = json.loads(json.dumps(template))
        hit["result"]["messageId"] = message_id
        hit["result"]["conversationId"] = conversation_id
        results.append(hit)
    return {
        "result": {"searchResults": results},
        "next": {"cursor": cursor} if cursor else None,
    }


def _hit_ids(page):
    return [hit.message.message_id for hit in page.items]


async def test_in_thread_search_slices_and_resumes_mid_page(fake):
    first = _search_page(["m1", "m2", "m3"], cursor="up-2")
    second = _search_page(["m4"], cursor=None)
    fake.route("GET", PATH_MESSAGE_SEARCH, [first, first, second])
    service = make_service(fake)

    page = await service.search_messages(
        VIEWER, "gm", conversation_id=ONE_TO_ONE_ID, cursor=None, limit=2
    )
    assert _hit_ids(page) == ["m1", "m2"]
    assert page.next_cursor is not None and page.next_cursor.startswith("ts1.")

    rest = await service.search_messages(
        VIEWER, "gm", conversation_id=ONE_TO_ONE_ID, cursor=page.next_cursor, limit=2
    )
    assert _hit_ids(rest) == ["m3", "m4"]
    assert rest.next_cursor is None
    calls = fake.calls_to("GET", PATH_MESSAGE_SEARCH)
    # The resume re-fetches the same upstream page with the same page size.
    assert [(c.params.get("cursor"), c.params["limit"]) for c in calls] == [
        (None, "2"),
        (None, "2"),
        ("up-2", "2"),
    ]


async def test_in_thread_search_never_returns_more_than_limit(fake):
    fake.route(
        "GET", PATH_MESSAGE_SEARCH, _search_page(["a", "b", "c", "d"], cursor=None)
    )
    page = await make_service(fake).search_messages(
        VIEWER, "gm", conversation_id=ONE_TO_ONE_ID, cursor=None, limit=3
    )
    assert _hit_ids(page) == ["a", "b", "c"]
    assert page.next_cursor is not None


async def test_in_thread_search_empty_page_only_when_scan_budget_ran_out(fake):
    other = _search_page(["x"], cursor="more", conversation_id=GROUP_ID)
    fake.route("GET", PATH_MESSAGE_SEARCH, [other, other, other])
    page = await make_service(fake).search_messages(
        VIEWER, "gm", conversation_id=ONE_TO_ONE_ID, cursor=None, limit=5
    )
    assert page.items == []
    assert page.next_cursor == "more"
    assert len(fake.calls_to("GET", PATH_MESSAGE_SEARCH)) == 3


@pytest.mark.parametrize(
    "cursor",
    [
        "ts1.!!!",
        "ts1." + _b64(["not", "a", "dict"]),
        "ts1." + _b64({"c": None, "o": 0, "n": 5}),
        "ts1." + _b64({"c": None, "o": 2, "n": 0}),
        "ts1." + _b64({"c": 7, "o": 2, "n": 5}),
        "ts1." + _b64({"c": None, "o": True, "n": 5}),
        "ts1." + _b64({"c": None, "o": 10_000, "n": 5}),
    ],
)
async def test_in_thread_search_rejects_bad_cursor(fake, cursor):
    with pytest.raises(MessagingError) as exc:
        await make_service(fake).search_messages(
            VIEWER, "gm", conversation_id=ONE_TO_ONE_ID, cursor=cursor, limit=5
        )
    assert (exc.value.status_code, exc.value.code) == (400, "invalid_cursor")
    assert fake.calls == []


def test_diff_new_conversation_with_newer_message_is_message():
    one, group = _conversations()
    previous = snapshot_inbox(_inbox([group]))
    watermark = group.last_message.sent_at
    fresh = one.model_copy(
        update={
            "last_message": one.last_message.model_copy(
                update={"sent_at": watermark + 1}
            )
        }
    )
    events = diff_inbox(previous, _inbox([fresh, group]))
    assert [(e.type, e.conversation_id) for e in events] == [("message", ONE_TO_ONE_ID)]


def test_diff_new_conversation_with_old_message_is_inbox():
    one, group = _conversations()
    previous = snapshot_inbox(_inbox([group]))
    stale = one.model_copy(
        update={
            "last_message": one.last_message.model_copy(
                update={"sent_at": group.last_message.sent_at}
            )
        }
    )
    events = diff_inbox(previous, _inbox([stale, group]))
    assert [(e.type, e.conversation_id) for e in events] == [("inbox", ONE_TO_ONE_ID)]


def test_diff_new_conversation_without_watermark_is_inbox():
    one, group = _conversations()
    previous = snapshot_inbox(_inbox([group]))
    legacy = {
        cid: entry
        for cid, entry in previous.items()
        if cid != direct_cast_relay.SNAPSHOT_WATERMARK_KEY
    }
    events = diff_inbox(legacy, _inbox([one, group]))
    assert [(e.type, e.conversation_id) for e in events] == [("inbox", ONE_TO_ONE_ID)]


def test_snapshot_watermark_is_not_a_conversation():
    one, group = _conversations()
    previous = snapshot_inbox(_inbox([one, group]))
    assert previous[direct_cast_relay.SNAPSHOT_WATERMARK_KEY] == [
        max(one.last_message.sent_at, group.last_message.sent_at)
    ]
    # Unchanged inbox: the reserved entry never surfaces as a removed row.
    assert diff_inbox(previous, _inbox([one, group])) == []


# ---------------------------------------------------------------------------
# Round 4: versioned read cache, watermark-gated "message" for existing rows
# ---------------------------------------------------------------------------

_REACTION = ReactionRequest(
    conversation_id=ONE_TO_ONE_ID, message_id="m-1", reaction="\U0001f525"
)

# (label, upstream method, upstream path, service call)
_WRITES = [
    (
        "send",
        "PUT",
        PATH_SEND,
        lambda s: s.send(
            VIEWER,
            _send_request(conversation_id=ONE_TO_ONE_ID, process_metadata=False),
            sender=SENDER,
        ),
    ),
    (
        "react_add",
        "PUT",
        PATH_REACTION,
        lambda s: s.react(VIEWER, _REACTION, remove=False),
    ),
    (
        "react_remove",
        "DELETE",
        PATH_REACTION,
        lambda s: s.react(VIEWER, _REACTION, remove=True),
    ),
    (
        "delete",
        "DELETE",
        PATH_DELETE_MESSAGE,
        lambda s: s.delete_message(VIEWER, ONE_TO_ONE_ID, "m-1"),
    ),
    ("mark_read", "POST", PATH_MARK_READ, lambda s: s.mark_read(VIEWER, ONE_TO_ONE_ID)),
    (
        "mark_unread",
        "POST",
        PATH_MARK_UNREAD,
        lambda s: s.mark_unread(VIEWER, ONE_TO_ONE_ID),
    ),
    (
        "accept",
        "POST",
        PATH_CATEGORIZATION,
        lambda s: s.accept_request(VIEWER, ONE_TO_ONE_ID),
    ),
    (
        "decline",
        "POST",
        PATH_CATEGORIZATION,
        lambda s: s.decline_request(VIEWER, ONE_TO_ONE_ID),
    ),
]


@pytest.mark.parametrize(
    ("method", "path", "write"),
    [(method, path, write) for _, method, path, write in _WRITES],
    ids=[label for label, *_ in _WRITES],
)
async def test_read_after_write_misses_cache(fake, method, path, write):
    fake.route("GET", PATH_RECENT_MESSAGES, load_fixture("recent_messages"))
    fake.route(
        method,
        path,
        load_fixture("send_success" if path == PATH_SEND else "success"),
    )
    service = make_service(fake, FakeRedis(), cache_ttl_seconds=60)
    await service.recent_messages(VIEWER, ONE_TO_ONE_ID)
    await service.recent_messages(VIEWER, ONE_TO_ONE_ID)
    assert len(fake.calls_to("GET", PATH_RECENT_MESSAGES)) == 1  # cache hit
    await write(service)
    await service.recent_messages(VIEWER, ONE_TO_ONE_ID)
    assert len(fake.calls_to("GET", PATH_RECENT_MESSAGES)) == 2  # miss after write
    await service.recent_messages(VIEWER, ONE_TO_ONE_ID)
    assert len(fake.calls_to("GET", PATH_RECENT_MESSAGES)) == 2  # re-cached


async def test_failed_write_still_invalidates_and_only_that_fid(fake):
    fake.route("GET", PATH_RECENT_MESSAGES, load_fixture("recent_messages"))
    fake.route("POST", PATH_MARK_READ, (500, {}))
    service = make_service(fake, FakeRedis(), cache_ttl_seconds=60)
    other = MessagingViewer(fid=PEER_FID, bearer=FAKE_BEARER)
    await service.recent_messages(VIEWER, ONE_TO_ONE_ID)
    await service.recent_messages(other, ONE_TO_ONE_ID)
    # A 5xx/timeout write may still have landed upstream.
    with pytest.raises(DirectCastUpstreamError):
        await service.mark_read(VIEWER, ONE_TO_ONE_ID)
    await service.recent_messages(VIEWER, ONE_TO_ONE_ID)
    await service.recent_messages(other, ONE_TO_ONE_ID)
    assert len(fake.calls_to("GET", PATH_RECENT_MESSAGES)) == 3  # other fid hit


async def test_cache_version_read_failure_bypasses_cache(fake, monkeypatch):
    from redis.exceptions import ConnectionError as RedisConnectionError

    fake.route("GET", PATH_RECENT_MESSAGES, load_fixture("recent_messages"))
    redis = FakeRedis()
    service = make_service(fake, redis, cache_ttl_seconds=60)
    await service.recent_messages(VIEWER, ONE_TO_ONE_ID)

    async def broken_get(key):
        raise RedisConnectionError("down")

    monkeypatch.setattr(redis, "get", broken_get)
    await service.recent_messages(VIEWER, ONE_TO_ONE_ID)
    assert len(fake.calls_to("GET", PATH_RECENT_MESSAGES)) == 2


def test_diff_delete_leaving_older_last_message_is_inbox():
    one, group = _conversations()
    previous = snapshot_inbox(_inbox([one, group]))
    older = one.last_message.model_copy(
        update={"message_id": "older-id", "sent_at": one.last_message.sent_at - 1}
    )
    events = diff_inbox(
        previous, _inbox([one.model_copy(update={"last_message": older}), group])
    )
    assert [(e.type, e.conversation_id) for e in events] == [("inbox", ONE_TO_ONE_ID)]


def test_diff_changed_last_message_at_watermark_is_inbox():
    one, group = _conversations()
    previous = snapshot_inbox(_inbox([one, group]))
    watermark = max(one.last_message.sent_at, group.last_message.sent_at)
    same_time = one.last_message.model_copy(
        update={"message_id": "same-time", "sent_at": watermark}
    )
    events = diff_inbox(
        previous, _inbox([one.model_copy(update={"last_message": same_time}), group])
    )
    assert [(e.type, e.conversation_id) for e in events] == [("inbox", ONE_TO_ONE_ID)]


def test_diff_last_message_removed_is_inbox():
    one, group = _conversations()
    previous = snapshot_inbox(_inbox([one, group]))
    events = diff_inbox(
        previous, _inbox([one.model_copy(update={"last_message": None}), group])
    )
    assert [(e.type, e.conversation_id) for e in events] == [("inbox", ONE_TO_ONE_ID)]


def test_diff_changed_last_message_with_legacy_snapshot_is_inbox():
    one, group = _conversations()
    previous = {
        cid: entry
        for cid, entry in snapshot_inbox(_inbox([one, group])).items()
        if cid != direct_cast_relay.SNAPSHOT_WATERMARK_KEY
    }
    newer = one.last_message.model_copy(
        update={"message_id": "n", "sent_at": one.last_message.sent_at + 10}
    )
    events = diff_inbox(
        previous, _inbox([one.model_copy(update={"last_message": newer}), group])
    )
    assert [(e.type, e.conversation_id) for e in events] == [("inbox", ONE_TO_ONE_ID)]
