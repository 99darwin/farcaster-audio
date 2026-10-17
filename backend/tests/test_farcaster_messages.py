"""Tests for app.clients.farcaster_messages (build, sign, mentions, submit)."""

from __future__ import annotations

import asyncio
import base64
import json
import os
from datetime import UTC, datetime

import blake3
import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ed25519

from app.clients import farcaster_messages as fm
from app.clients import hypersnap
from app.clients.hypersnap import HypersnapClient
from app.clients.proto import message_pb2

# ---------------------------------------------------------------------------
# Known vector: a real mainnet cast by dwr (fid 3), fetched from the
# Hypersnap node at https://haatz.quilibrium.com/v1/castsByFid?fid=3.
# Its published hash and signature let us check our encoder, hash and
# signature scheme against bytes produced by an independent implementation.
# ---------------------------------------------------------------------------
VECTOR_FID = 3
VECTOR_TIMESTAMP = 182650549
VECTOR_TEXT = (
    "Looking forward to  finally having a social network. He’s been "
    "talking about it since 2013. \n\nAlso cool that you can build your own "
    "client."
)
VECTOR_MENTIONS = [37]
VECTOR_MENTION_POSITIONS = [19]
VECTOR_EMBED = fm.CastRef.from_hex(37, "83c734e1985ad2b6f28bea2938a750981740a093")
VECTOR_HASH = "0xaa46a97b0cdb80884918e1bf8e8c61ae6d5e39a3"
VECTOR_SIGNATURE = base64.b64decode(
    "/w4wzOutbnKv5gjyUVBk62oY791wFnoPSnPpL6xI0/SuwAMBc93MmXvwI729gUytcvPUm6//"
    "WbCX7CBkVvLlCg=="
)
VECTOR_SIGNER = bytes.fromhex(
    "c887f5bf385a4718eaee166481f1832198938cf33e98a82dc81a0b4b81ffe33d"
)
VECTOR_DATA_BYTES = bytes.fromhex(
    "0801100318b58d8c5720012ab201120125228d014c6f6f6b696e6720666f727761726420"
    "746f202066696e616c6c7920686176696e67206120736f6369616c206e6574776f726b2e"
    "204865e2809973206265656e2074616c6b696e672061626f75742069742073696e636520"
    "323031332e200a0a416c736f20636f6f6c207468617420796f752063616e206275696c64"
    "20796f7572206f776e20636c69656e742e2a0113321a12180825121483c734e1985ad2b6"
    "f28bea2938a750981740a093"
)


def _key() -> bytes:
    return os.urandom(32)


def _public(private: bytes) -> ed25519.Ed25519PublicKey:
    return ed25519.Ed25519PrivateKey.from_private_bytes(private).public_key()


def _vector_message(private: bytes) -> message_pb2.Message:
    return fm.build_cast_add(
        VECTOR_FID,
        VECTOR_TEXT,
        signer_private_key=private,
        embeds=[VECTOR_EMBED],
        mentions=VECTOR_MENTIONS,
        mentions_positions=VECTOR_MENTION_POSITIONS,
        timestamp=VECTOR_TIMESTAMP,
    )


class TestKnownVector:
    def test_data_bytes_and_hash_match_mainnet(self):
        message = _vector_message(_key())
        assert message.data_bytes == VECTOR_DATA_BYTES
        assert fm.message_hash_hex(message) == VECTOR_HASH

    def test_published_signature_verifies_over_hash(self):
        # Proves the scheme: Ed25519 over the 20-byte BLAKE3 hash.
        signer = ed25519.Ed25519PublicKey.from_public_bytes(VECTOR_SIGNER)
        signer.verify(VECTOR_SIGNATURE, bytes.fromhex(VECTOR_HASH[2:]))

    def test_own_signature_verifies(self):
        private = _key()
        message = _vector_message(private)
        _public(private).verify(message.signature, message.hash)
        assert message.signer == _public(private).public_bytes_raw()


class TestEnvelope:
    def test_message_fields(self):
        private = _key()
        message = fm.build_cast_add(7, "gm", signer_private_key=private, timestamp=123)
        assert message.hash_scheme == message_pb2.HASH_SCHEME_BLAKE3
        assert message.signature_scheme == message_pb2.SIGNATURE_SCHEME_ED25519
        assert message.data.network == message_pb2.FARCASTER_NETWORK_MAINNET
        assert message.data.SerializeToString(deterministic=True) == (
            message.data_bytes
        )
        assert message.hash == blake3.blake3(message.data_bytes).digest()[:20]

    def test_farcaster_timestamp_epoch(self):
        moment = datetime(2021, 1, 2, tzinfo=UTC)
        assert fm.farcaster_timestamp(moment) == 86400

    def test_rejects_bad_private_key(self):
        with pytest.raises(fm.MessageBuildError):
            fm.build_cast_add(7, "gm", signer_private_key=b"short")


class TestCastAdd:
    def test_long_cast_type(self):
        message = fm.build_cast_add(7, "x" * 321, signer_private_key=_key())
        assert message.data.cast_add_body.type == message_pb2.LONG_CAST

    def test_standard_cast_at_limit(self):
        # 320 bytes made of 3-byte characters plus padding.
        text = "✓" * 106 + "xx"
        assert len(text.encode()) == 320
        message = fm.build_cast_add(7, text, signer_private_key=_key())
        assert message.data.cast_add_body.type == message_pb2.CAST

    def test_too_long(self):
        with pytest.raises(fm.MessageBuildError):
            fm.build_cast_add(7, "x" * 1025, signer_private_key=_key())

    def test_empty(self):
        with pytest.raises(fm.MessageBuildError):
            fm.build_cast_add(7, "", signer_private_key=_key())

    def test_embed_only_allowed(self):
        message = fm.build_cast_add(
            7, "", signer_private_key=_key(), embeds=["https://juke.audio"]
        )
        assert message.data.cast_add_body.embeds[0].url == "https://juke.audio"

    def test_parent_cast_and_url_exclusive(self):
        with pytest.raises(fm.MessageBuildError):
            fm.build_cast_add(
                7,
                "hi",
                signer_private_key=_key(),
                parent_cast_id=VECTOR_EMBED,
                parent_url="https://juke.audio",
            )

    def test_parent_cast(self):
        message = fm.build_cast_add(
            7, "reply", signer_private_key=_key(), parent_cast_id=VECTOR_EMBED
        )
        assert message.data.cast_add_body.parent_cast_id.fid == 37

    @pytest.mark.parametrize(
        "mentions,positions",
        [([1], []), ([1, 2], [5, 1]), ([1], [99]), ([0], [0]), ([1] * 11, [0] * 11)],
    )
    def test_invalid_mentions(self, mentions, positions):
        with pytest.raises(fm.MessageBuildError):
            fm.build_cast_add(
                7,
                "hello",
                signer_private_key=_key(),
                mentions=mentions,
                mentions_positions=positions,
            )

    def test_bad_cast_ref_hash(self):
        with pytest.raises(fm.MessageBuildError):
            fm.build_cast_add(
                7,
                "x",
                signer_private_key=_key(),
                embeds=[fm.CastRef(fid=1, hash=b"\x00" * 19)],
            )


class TestOtherBuilders:
    def test_cast_remove(self):
        target = bytes(20)
        message = fm.build_cast_remove(7, target, signer_private_key=_key())
        assert message.data.type == message_pb2.MESSAGE_TYPE_CAST_REMOVE
        assert message.data.cast_remove_body.target_hash == target

    def test_cast_remove_bad_hash(self):
        with pytest.raises(fm.MessageBuildError):
            fm.build_cast_remove(7, b"\x01", signer_private_key=_key())

    @pytest.mark.parametrize(
        "action,kind,message_type,reaction_type",
        [
            ("add", "like", "MESSAGE_TYPE_REACTION_ADD", "REACTION_TYPE_LIKE"),
            (
                "remove",
                "recast",
                "MESSAGE_TYPE_REACTION_REMOVE",
                "REACTION_TYPE_RECAST",
            ),
        ],
    )
    def test_reaction(self, action, kind, message_type, reaction_type):
        message = fm.build_reaction(
            7, action, kind, VECTOR_EMBED, signer_private_key=_key()
        )
        assert message.data.type == getattr(message_pb2, message_type)
        assert message.data.reaction_body.type == getattr(message_pb2, reaction_type)
        assert message.data.reaction_body.target_cast_id.hash == VECTOR_EMBED.hash

    def test_reaction_unknown_type(self):
        with pytest.raises(fm.MessageBuildError):
            fm.build_reaction(
                7, "add", "boost", VECTOR_EMBED, signer_private_key=_key()  # type: ignore[arg-type]
            )

    @pytest.mark.parametrize(
        "action,message_type",
        [("add", "MESSAGE_TYPE_LINK_ADD"), ("remove", "MESSAGE_TYPE_LINK_REMOVE")],
    )
    def test_link(self, action, message_type):
        message = fm.build_link(7, action, "follow", 37, signer_private_key=_key())
        assert message.data.type == getattr(message_pb2, message_type)
        assert message.data.link_body.target_fid == 37
        assert message.data.link_body.type == "follow"

    @pytest.mark.parametrize("link_type,target", [("", 37), ("x" * 9, 37), ("f", 7)])
    def test_link_invalid(self, link_type, target):
        with pytest.raises(fm.MessageBuildError):
            fm.build_link(7, "add", link_type, target, signer_private_key=_key())


# ---------------------------------------------------------------------------
# Mentions
# ---------------------------------------------------------------------------

USERNAMES = {"dwr": 3, "v": 2, "vitalik.eth": 5650, "juke": 99}


async def _resolve(username: str) -> int | None:
    return USERNAMES.get(username)


class TestParseMentions:
    async def test_basic(self):
        parsed = await fm.parse_mentions("gm @dwr and @v!", _resolve)
        assert parsed.text == "gm  and !"
        assert parsed.mentions == [3, 2]
        assert parsed.mentions_positions == [3, 8]

    async def test_emoji_and_multibyte_offsets(self):
        # "🎧" is 4 UTF-8 bytes, "é" is 2, "日本" is 6.
        parsed = await fm.parse_mentions("🎧 café @dwr 日本 @vitalik.eth", _resolve)
        assert parsed.text == "🎧 café  日本 "
        assert parsed.mentions == [3, 5650]
        encoded = parsed.text.encode()
        assert parsed.mentions_positions == [len("🎧 café ".encode()), len(encoded)]
        assert parsed.mentions_positions == [11, 19]

    async def test_offsets_feed_builder(self):
        parsed = await fm.parse_mentions("🎧 @dwr hi @juke", _resolve)
        message = fm.build_cast_add(
            7,
            parsed.text,
            signer_private_key=_key(),
            mentions=parsed.mentions,
            mentions_positions=parsed.mentions_positions,
        )
        assert list(message.data.cast_add_body.mentions_positions) == [5, 9]

    async def test_unresolved_and_email_left_literal(self):
        parsed = await fm.parse_mentions(
            "mail me@example.com or @nobody, @DWR", _resolve
        )
        assert parsed.text == "mail me@example.com or @nobody, "
        assert parsed.mentions == [3]
        assert parsed.mentions_positions == [len(parsed.text.encode())]

    async def test_resolver_called_once_per_name(self):
        calls: list[str] = []

        async def resolve(username: str) -> int | None:
            calls.append(username)
            return 3

        parsed = await fm.parse_mentions("@dwr @Dwr @dwr", resolve)
        assert calls == ["dwr"]
        assert parsed.mentions == [3, 3, 3]

    async def test_mention_cap(self):
        text = " ".join(["@dwr"] * 12)
        parsed = await fm.parse_mentions(text, _resolve)
        assert len(parsed.mentions) == fm.MAX_MENTIONS
        assert parsed.text.endswith("@dwr @dwr")


# ---------------------------------------------------------------------------
# submit_message
# ---------------------------------------------------------------------------

# Verbatim haatz response for a cast signed by an unregistered key.
HAATZ_INVALID_SIGNER = {
    "error": "Failed to submit message",
    "error_detail": (
        'status: InvalidArgument, message: "bad_request.validation_failure/'
        'invalid signer", details: [], metadata: MetadataMap { headers: '
        '{"x-err-code": "bad_request.validation_failure"} }'
    ),
}


def _client(handler) -> HypersnapClient:
    return HypersnapClient("https://node.test", transport=httpx.MockTransport(handler))


class TestSubmitMessage:
    async def test_success_posts_protobuf(self):
        message = fm.build_cast_add(7, "gm", signer_private_key=_key())
        seen: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["path"] = request.url.path
            seen["type"] = request.headers["content-type"]
            seen["body"] = request.content
            return httpx.Response(200, json={"hash": fm.message_hash_hex(message)})

        client = _client(handler)
        assert await fm.submit_message(message, client=client) is message
        await client.aclose()
        assert seen["path"] == "/v1/submitMessage"
        assert seen["type"] == "application/octet-stream"
        assert message_pb2.Message.FromString(seen["body"]) == message

    async def test_haatz_error_envelope(self):
        message = fm.build_cast_add(7, "gm", signer_private_key=_key())
        client = _client(lambda _: httpx.Response(400, json=HAATZ_INVALID_SIGNER))
        with pytest.raises(fm.SubmitMessageError) as info:
            await fm.submit_message(message, client=client)
        await client.aclose()
        assert info.value.status_code == 400
        assert info.value.err_code == "bad_request.validation_failure"
        assert info.value.node_message == "invalid signer"

    async def test_hubble_error_envelope(self):
        message = fm.build_cast_add(7, "gm", signer_private_key=_key())
        body = {"errCode": "bad_request.duplicate", "message": "message exists"}
        client = _client(lambda _: httpx.Response(400, json=body))
        with pytest.raises(fm.SubmitMessageError) as info:
            await fm.submit_message(message, client=client)
        await client.aclose()
        assert info.value.err_code == "bad_request.duplicate"
        assert info.value.node_message == "message exists"

    async def test_non_json_error(self):
        message = fm.build_cast_add(7, "gm", signer_private_key=_key())
        client = _client(lambda _: httpx.Response(503, text="overloaded"))
        with pytest.raises(fm.SubmitMessageError) as info:
            await fm.submit_message(message, client=client)
        await client.aclose()
        assert info.value.status_code == 503
        assert info.value.err_code is None
        assert info.value.node_message == "overloaded"

    async def test_transport_error(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("down", request=request)

        message = fm.build_cast_add(7, "gm", signer_private_key=_key())
        client = _client(handler)
        with pytest.raises(fm.SubmitMessageError) as info:
            await fm.submit_message(message, client=client)
        await client.aclose()
        assert info.value.status_code is None

    async def test_echoed_hash_mismatch(self):
        message = fm.build_cast_add(7, "gm", signer_private_key=_key())
        body = json.dumps({"hash": "0x" + "00" * 20})
        client = _client(lambda _: httpx.Response(200, text=body))
        with pytest.raises(fm.SubmitMessageError):
            await fm.submit_message(message, client=client)
        await client.aclose()

    async def test_oversized_response_is_transport_failure(self):
        message = fm.build_cast_add(7, "gm", signer_private_key=_key())
        oversized = b"x" * (hypersnap.MAX_RESPONSE_BYTES + 1)
        client = _client(lambda _: httpx.Response(200, content=oversized))
        with pytest.raises(fm.SubmitMessageError) as info:
            await fm.submit_message(message, client=client)
        await client.aclose()
        assert info.value.status_code is None
        assert isinstance(info.value.__cause__, hypersnap.HypersnapResponseTooLarge)

    async def test_deadline_is_transport_failure(self):
        async def slow_body():
            await asyncio.sleep(1)
            yield b"{}"

        message = fm.build_cast_add(7, "gm", signer_private_key=_key())
        client = HypersnapClient(
            "https://node.test",
            transport=httpx.MockTransport(
                lambda _: httpx.Response(200, content=slow_body())
            ),
            deadline_seconds=0.05,
        )
        with pytest.raises(fm.SubmitMessageError) as info:
            await fm.submit_message(message, client=client)
        await client.aclose()
        assert info.value.status_code is None
