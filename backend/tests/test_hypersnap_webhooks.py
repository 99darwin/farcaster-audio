"""WS4: Hypersnap webhooks — signing, delivery verification, filter sync."""

import hashlib
import hmac
import json
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from eth_account import Account
from eth_utils import keccak

from app.clients import hypersnap
from app.clients import hypersnap_webhooks as hw
from app.config import settings
from app.dependencies import get_db
from app.main import app
from app.services import hypersnap_webhook_service as svc

# Throwaway test-only key material (never a real secret).
TEST_SECRET = "test-webhook-secret"
TEST_FID = 4242
HASH_A = "0x" + "ab" * 20
HASH_B = "0x" + "cd" * 20


def _sign(body: bytes, secret: str = TEST_SECRET) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha512).hexdigest()


def _signer() -> hw.WebhookSigner:
    return hw.WebhookSigner(fid=TEST_FID, account=Account.create())


@pytest.fixture(autouse=True)
def _reset_webhook_id_cache(monkeypatch):
    svc._webhook_ids.clear()
    monkeypatch.setattr(svc, "_webhook_ids_listed_at", None)
    yield
    svc._webhook_ids.clear()


# ---------------------------------------------------------------------------
# HMAC delivery verification
# ---------------------------------------------------------------------------


def test_verify_delivery_signature_valid():
    body = b'{"type":"cast.created"}'
    assert hw.verify_delivery_signature(body, _sign(body), [TEST_SECRET])


def test_verify_delivery_signature_accepts_0x_and_uppercase():
    body = b"{}"
    assert hw.verify_delivery_signature(body, "0x" + _sign(body).upper(), [TEST_SECRET])


def test_verify_delivery_signature_invalid():
    body = b'{"type":"cast.created"}'
    assert not hw.verify_delivery_signature(body, _sign(body, "other"), [TEST_SECRET])
    assert not hw.verify_delivery_signature(body + b" ", _sign(body), [TEST_SECRET])


def test_verify_delivery_signature_fails_closed_on_empty_secret():
    body = b"{}"
    # An attacker can compute HMAC under the empty key; it must never pass.
    assert not hw.verify_delivery_signature(body, _sign(body, ""), [""])
    assert not hw.verify_delivery_signature(body, _sign(body, ""), [])


def test_verify_delivery_signature_rejects_empty_signature():
    assert not hw.verify_delivery_signature(b"{}", "", [TEST_SECRET])


def test_verify_delivery_signature_rejects_non_ascii_and_odd_length():
    # compare_digest raises TypeError on non-ASCII str; must be a plain False.
    body = b'{"type":"cast.created"}'
    good = _sign(body)
    assert not hw.verify_delivery_signature(body, "\xff", [TEST_SECRET])
    assert not hw.verify_delivery_signature(body, good[:-1] + "\xe9", [TEST_SECRET])
    assert not hw.verify_delivery_signature(body, good[:-1], [TEST_SECRET])


def test_verify_delivery_signature_rotation_accepts_any_listed_secret():
    body = b"{}"
    secrets_ = hw.parse_secrets(f"old-secret, {TEST_SECRET} ,")
    assert secrets_ == ["old-secret", TEST_SECRET]
    assert hw.verify_delivery_signature(body, _sign(body, "old-secret"), secrets_)
    assert hw.verify_delivery_signature(body, _sign(body), secrets_)


# ---------------------------------------------------------------------------
# EIP-712 signed operations
# ---------------------------------------------------------------------------


def test_sign_request_recovers_custody_address():
    signer = _signer()
    body = b'{"name":"x"}'
    headers = hw.sign_request(signer, hw.WebhookOp.CREATE, body)
    assert hw.recover_request_signer(headers, body) == signer.account.address


def test_sign_request_header_format():
    headers = hw.sign_request(
        _signer(), hw.WebhookOp.READ, b"", signed_at=1_700_000_000
    )
    assert headers[hw.HEADER_FID] == str(TEST_FID)
    assert headers[hw.HEADER_OP] == "webhook.read"
    assert headers[hw.HEADER_SIGNED_AT] == "1700000000"
    nonce, signature = headers[hw.HEADER_NONCE], headers[hw.HEADER_SIGNATURE]
    assert nonce.startswith("0x") and len(nonce) == 2 + 64
    assert signature.startswith("0x") and len(signature) == 2 + 130


def test_sign_request_binds_body_and_op():
    signer = _signer()
    body = b'{"webhook_id":"a"}'
    headers = hw.sign_request(signer, hw.WebhookOp.UPDATE, body)
    assert hw.recover_request_signer(headers, b'{"webhook_id":"b"}') != (
        signer.account.address
    )
    tampered = headers | {hw.HEADER_OP: hw.WebhookOp.DELETE.value}
    assert hw.recover_request_signer(tampered, body) != signer.account.address


def test_typed_data_matches_spec():
    typed = hw.build_signed_op_typed_data(
        op="webhook.read",
        fid=1,
        signed_at=2,
        nonce=b"\x01" * 32,
        request_hash=keccak(b""),
    )
    assert typed["domain"] == {"name": "Hypersnap", "version": "1", "chainId": 10}
    assert typed["primaryType"] == "HypersnapSignedOp"
    fields = [(f["name"], f["type"]) for f in typed["types"]["HypersnapSignedOp"]]
    assert fields == [
        ("op", "string"),
        ("fid", "uint64"),
        ("signedAt", "uint256"),
        ("nonce", "bytes32"),
        ("requestHash", "bytes32"),
    ]


def test_build_typed_data_rejects_short_nonce():
    with pytest.raises(ValueError):
        hw.build_signed_op_typed_data(
            op="x", fid=1, signed_at=1, nonce=b"\x00", request_hash=keccak(b"")
        )


def test_app_webhook_signer_requires_config(monkeypatch):
    monkeypatch.setattr(settings, "FARCASTER_APP_FID", 0)
    monkeypatch.setattr(settings, "FARCASTER_APP_MNEMONIC", "")
    assert not hw.is_app_signer_configured()
    with pytest.raises(hw.HypersnapWebhookConfigError):
        hw.app_webhook_signer()


def test_app_webhook_signer_invalid_mnemonic_is_not_chained(monkeypatch):
    monkeypatch.setattr(settings, "FARCASTER_APP_FID", 1)
    monkeypatch.setattr(settings, "FARCASTER_APP_MNEMONIC", "not a mnemonic")
    with pytest.raises(hw.HypersnapWebhookConfigError) as excinfo:
        hw.app_webhook_signer()
    assert excinfo.value.__cause__ is None
    assert excinfo.value.__suppress_context__


# ---------------------------------------------------------------------------
# Management client (mock transport)
# ---------------------------------------------------------------------------


def _mock_http(handler) -> hypersnap.HypersnapClient:
    return hypersnap.HypersnapClient(
        "https://node.test", transport=httpx.MockTransport(handler)
    )


def _webhook_record(**overrides) -> dict:
    return {
        "webhook_id": "wh_1",
        "title": "juke-room-replies",
        "target_url": "https://api.test/v1/webhooks/hypersnap",
        "secrets": [{"uid": "s1", "value": "v1", "created_at": 1}],
    } | overrides


async def test_client_create_signs_exact_body_bytes():
    signer = _signer()
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["path"] = request.url.path
        seen["body"] = request.content
        seen["headers"] = request.headers
        return httpx.Response(200, json={"webhook": _webhook_record()})

    client = hw.HypersnapWebhookClient(signer, _mock_http(handler))
    sub = {"cast_created": {"parent_hashes": [HASH_A]}}
    webhook = await client.create(name="n", url="https://u", subscription=sub)

    assert webhook["webhook_id"] == "wh_1"
    assert (seen["method"], seen["path"]) == ("POST", "/v2/farcaster/webhook")
    assert json.loads(seen["body"]) == {
        "name": "n",
        "url": "https://u",
        "subscription": sub,
    }
    headers = {
        k: seen["headers"][k]
        for k in (
            hw.HEADER_FID,
            hw.HEADER_OP,
            hw.HEADER_SIGNED_AT,
            hw.HEADER_NONCE,
            hw.HEADER_SIGNATURE,
        )
    }
    assert headers[hw.HEADER_OP] == "webhook.create"
    assert hw.recover_request_signer(headers, seen["body"]) == signer.account.address


async def test_client_delete_uses_query_and_empty_body_hash():
    signer = _signer()
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["request"] = request
        return httpx.Response(200, json={"success": True})

    client = hw.HypersnapWebhookClient(signer, _mock_http(handler))
    await client.delete("wh_9")
    request = seen["request"]
    assert request.method == "DELETE"
    assert request.url.params["webhook_id"] == "wh_9"
    assert request.content == b""
    headers = {
        k: request.headers[k]
        for k in (
            hw.HEADER_FID,
            hw.HEADER_OP,
            hw.HEADER_SIGNED_AT,
            hw.HEADER_NONCE,
            hw.HEADER_SIGNATURE,
        )
    }
    assert headers[hw.HEADER_OP] == "webhook.delete"
    assert hw.recover_request_signer(headers, b"") == signer.account.address


async def test_client_maps_cap_and_not_found_errors():
    statuses = iter([429, 404, 401])

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(next(statuses), json={"message": "nope"})

    client = hw.HypersnapWebhookClient(_signer(), _mock_http(handler))
    with pytest.raises(hw.HypersnapWebhookLimitReached):
        await client.create(name="n", url="u", subscription={})
    with pytest.raises(hypersnap.HypersnapNotFound):
        await client.lookup("missing")
    with pytest.raises(hypersnap.HypersnapUpstreamError) as excinfo:
        await client.list()
    assert excinfo.value.status_code == 401


def test_active_secret_picks_newest_unexpired():
    record = {
        "secrets": [
            {"value": "old", "created_at": 1, "expires_at": 50},
            {"value": "new", "created_at": 2, "expires_at": None},
            {"value": "expired", "created_at": 3, "expires_at": 10},
        ]
    }
    assert hw.active_secret(record, now=20) == "new"
    assert hw.active_secret({"secrets": []}) is None


# ---------------------------------------------------------------------------
# parent_hashes / FID filter sync
# ---------------------------------------------------------------------------


def test_room_reply_subscription_uses_sentinel_when_empty():
    # An empty array would mean "all casts" to Hypersnap.
    assert svc.room_reply_subscription([]) == {
        "cast_created": {"parent_hashes": [svc.SENTINEL_CAST_HASH]}
    }


def test_room_reply_subscription_normalizes_and_dedupes():
    sub = svc.room_reply_subscription(
        [HASH_A.upper().replace("0X", "0x"), HASH_A[2:], HASH_B, "garbage", ""]
    )
    assert sub == {"cast_created": {"parent_hashes": [HASH_A, HASH_B]}}


def test_room_reply_subscription_caps_entries():
    hashes = [f"0x{i:040x}" for i in range(1, hw.MAX_FILTER_ENTRIES + 10)]
    sub = svc.room_reply_subscription(hashes)
    assert len(sub["cast_created"]["parent_hashes"]) == hw.MAX_FILTER_ENTRIES


def test_push_subscription_sentinel_and_filter_keys():
    reply, mention, reaction, follow = svc.PUSH_WEBHOOKS
    assert svc.push_subscription(reply, []) == {
        "cast_created": {"parent_author_fids": [svc.SENTINEL_FID]}
    }
    assert svc.push_subscription(mention, [3, 3, 1]) == {
        "cast_created": {"mentioned_fids": [1, 3]}
    }
    assert svc.push_subscription(reaction, [5]) == {
        "reaction_created": {"target_fids": [5]}
    }
    assert svc.push_subscription(follow, [5]) == {
        "follow_created": {"target_fids": [5]}
    }


class _FakeWebhookClient:
    owner_fid = TEST_FID

    def __init__(self, records: list[dict] | None = None):
        self.records = (
            records
            if records is not None
            else [
                _webhook_record(webhook_id=f"wh_{w.name}", title=w.name)
                for w in svc.ALL_WEBHOOKS
            ]
        )
        self.updates: list[tuple[str, dict]] = []
        self.created: list[dict] = []

    async def list(self):
        return self.records

    async def update(self, webhook_id, **kwargs):
        self.updates.append((webhook_id, kwargs))
        return _webhook_record(webhook_id=webhook_id)

    async def create(self, **kwargs):
        self.created.append(kwargs)
        return _webhook_record(webhook_id=f"new_{kwargs['name']}", title=kwargs["name"])


def _fake_db(hashes: list[str]):
    result = MagicMock()
    result.scalars.return_value.all.return_value = hashes
    db = MagicMock()
    db.execute = AsyncMock(return_value=result)
    return db


async def test_push_room_reply_hashes_updates_global_webhook():
    db = _fake_db([HASH_B, HASH_A[2:]])
    client = _FakeWebhookClient()

    assert await svc.push_room_reply_hashes(db, client)

    assert client.updates == [
        (
            "wh_juke-room-replies",
            {
                "subscription": {"cast_created": {"parent_hashes": [HASH_A, HASH_B]}},
                "active": True,
            },
        )
    ]
    query = str(db.execute.call_args.args[0])
    assert "rooms.status" in query
    assert "rooms.cast_hash IS NOT NULL" in query
    assert "rooms.is_farcaster_native IS false" in query


async def test_push_room_reply_hashes_noop_when_not_provisioned():
    client = _FakeWebhookClient(records=[])
    assert not await svc.push_room_reply_hashes(_fake_db([HASH_A]), client)
    assert client.updates == []


async def test_push_room_reply_hashes_drops_cached_id_on_404():
    client = _FakeWebhookClient()
    client.update = AsyncMock(
        side_effect=hypersnap.HypersnapNotFound("gone", path="/x", status_code=404)
    )
    with pytest.raises(hypersnap.HypersnapNotFound):
        await svc.push_room_reply_hashes(_fake_db([]), client)
    assert svc.ROOM_REPLY_WEBHOOK.name not in svc._webhook_ids


async def test_sync_push_webhooks_updates_each_and_survives_errors():
    client = _FakeWebhookClient()
    original = client.update
    calls = []

    async def flaky_update(webhook_id, **kwargs):
        calls.append(webhook_id)
        if webhook_id == "wh_juke-push-reaction":
            raise hypersnap.HypersnapUpstreamError("boom", path="/x", status_code=500)
        return await original(webhook_id, **kwargs)

    client.update = flaky_update
    await svc.sync_push_webhooks([7], client)
    assert calls == [f"wh_{w.name}" for w in svc.PUSH_WEBHOOKS]
    assert len(client.updates) == len(svc.PUSH_WEBHOOKS) - 1


def _sharded_records(shards: int) -> list[dict]:
    names = [svc.ROOM_REPLY_WEBHOOK.name] + [
        svc.shard_name(w, i) for w in svc.PUSH_WEBHOOKS for i in range(shards)
    ]
    return [_webhook_record(webhook_id=f"wh_{n}", title=n) for n in names]


def _filter_fids(subscription: dict) -> list[int]:
    (event_filter,) = subscription.values()
    (fids,) = event_filter.values()
    return fids


def test_shard_budget_fits_per_fid_cap():
    total = 1 + svc.PUSH_SHARDS_PER_STREAM * len(svc.PUSH_WEBHOOKS)
    assert total <= hw.MAX_WEBHOOKS_PER_FID
    assert svc.PUSH_FID_CAPACITY > hw.MAX_FILTER_ENTRIES
    assert svc.shard_name(svc.PUSH_WEBHOOKS[0], 0) == "juke-push-cast-reply"
    assert svc.shard_name(svc.PUSH_WEBHOOKS[0], 2) == "juke-push-cast-reply-2"


def test_shards_needed_bounds():
    assert svc.shards_needed(0) == 1
    assert svc.shards_needed(hw.MAX_FILTER_ENTRIES) == 1
    assert svc.shards_needed(hw.MAX_FILTER_ENTRIES + 1) == 2
    assert svc.shards_needed(hw.MAX_FILTER_ENTRIES - 10, headroom=20) == 2
    assert svc.shards_needed(10**9) == svc.PUSH_SHARDS_PER_STREAM


def test_partition_fids_covers_every_fid_within_filter_cap():
    fids = list(range(1, 2500)) + [0, -3, 5]
    shards = svc.partition_fids(fids, 3)
    assert [len(s) for s in shards] == [1024, 1024, 451]
    assert sorted(f for s in shards for f in s) == list(range(1, 2500))
    assert all(s == sorted(s) for s in shards)


def test_partition_fids_overflow_is_not_biased_against_high_fids():
    fids = range(1, 2 * hw.MAX_FILTER_ENTRIES + 1)
    (kept,) = svc.partition_fids(fids, 1)
    dropped = set(fids) - set(kept)
    # Newest (highest) FIDs must not be the ones systematically dropped.
    assert max(kept) > hw.MAX_FILTER_ENTRIES
    assert min(dropped) <= hw.MAX_FILTER_ENTRIES


async def test_sync_push_webhooks_spreads_fids_across_shards():
    client = _FakeWebhookClient(records=_sharded_records(2))
    fids = list(range(1, 1501))

    await svc.sync_push_webhooks(fids, client)

    assert len(client.updates) == 2 * len(svc.PUSH_WEBHOOKS)
    for webhook in svc.PUSH_WEBHOOKS:
        shard_ids = {f"wh_{svc.shard_name(webhook, i)}" for i in range(2)}
        subscribed = [
            fid
            for webhook_id, kwargs in client.updates
            if webhook_id in shard_ids
            for fid in _filter_fids(kwargs["subscription"])
        ]
        assert sorted(subscribed) == fids


async def test_sync_push_webhooks_unused_shards_get_sentinel():
    client = _FakeWebhookClient(records=_sharded_records(2))
    await svc.sync_push_webhooks([7], client)
    by_id = {webhook_id: kwargs for webhook_id, kwargs in client.updates}
    assert _filter_fids(by_id["wh_juke-push-follow"]["subscription"]) == [7]
    assert _filter_fids(by_id["wh_juke-push-follow-1"]["subscription"]) == [
        svc.SENTINEL_FID
    ]


async def test_sync_push_webhooks_overflow_is_logged_loudly(caplog):
    client = _FakeWebhookClient(records=_sharded_records(1))
    fids = range(1, hw.MAX_FILTER_ENTRIES + 11)

    with caplog.at_level("ERROR", logger=svc.logger.name):
        await svc.sync_push_webhooks(fids, client)

    overflow = [r for r in caplog.records if "exceed" in r.getMessage()]
    assert len(overflow) == len(svc.PUSH_WEBHOOKS)
    assert "10 FIDs get no pushes" in overflow[0].getMessage()
    assert "setup-webhooks" in overflow[0].getMessage()
    for _, kwargs in client.updates:
        assert len(_filter_fids(kwargs["subscription"])) == hw.MAX_FILTER_ENTRIES


async def test_resolve_webhook_ids_relists_after_ttl(monkeypatch):
    client = _FakeWebhookClient(records=_sharded_records(1))
    client.list = AsyncMock(side_effect=lambda: client.records)
    now = [1000.0]
    monkeypatch.setattr(svc.time, "monotonic", lambda: now[0])

    await svc.sync_push_webhooks([1], client)
    await svc.sync_push_webhooks([1], client)
    assert client.list.await_count == 1

    client.records = _sharded_records(2)
    now[0] += svc.WEBHOOK_ID_CACHE_TTL_SECONDS + 1
    await svc.sync_push_webhooks([1], client)
    assert client.list.await_count == 2
    assert "juke-push-follow-1" in svc._webhook_ids


class _FakeRedis:
    def __init__(self):
        self.store: dict[str, str] = {}

    async def set(self, key, value, nx=False, ex=None):
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    async def get(self, key):
        return self.store.get(key)

    async def exists(self, key):
        return int(key in self.store)

    async def delete(self, key):
        return int(self.store.pop(key, None) is not None)


async def test_sync_room_reply_webhook_drains_and_releases_lock():
    redis = _FakeRedis()
    client = _FakeWebhookClient()

    @asynccontextmanager
    async def session_factory():
        yield _fake_db([HASH_A])

    await svc.sync_room_reply_webhook(redis, session_factory, client)

    assert len(client.updates) == 1
    assert redis.store == {}


async def test_sync_room_reply_webhook_defers_to_lock_holder():
    redis = _FakeRedis()
    redis.store[svc.ROOM_SYNC_LOCK_KEY] = "someone-else"
    client = _FakeWebhookClient()

    @asynccontextmanager
    async def session_factory():
        yield _fake_db([HASH_A])

    await svc.sync_room_reply_webhook(redis, session_factory, client)

    # The holder will see the pending flag and push the latest set.
    assert client.updates == []
    assert redis.store[svc.ROOM_SYNC_PENDING_KEY] == "1"
    assert redis.store[svc.ROOM_SYNC_LOCK_KEY] == "someone-else"


def test_schedule_room_reply_sync_noop_without_signer(monkeypatch):
    monkeypatch.setattr(settings, "FARCASTER_APP_FID", 0)
    svc.schedule_room_reply_sync(_FakeRedis())  # no running loop needed
    assert not svc._background_tasks


async def test_ensure_webhooks_creates_missing_with_sentinels(monkeypatch):
    monkeypatch.setattr(settings, "API_BASE_URL", "https://api.test/")
    client = _FakeWebhookClient(records=[])

    results = await svc.ensure_webhooks(client)

    assert [r["name"] for r in results] == [w.name for w in svc.ALL_WEBHOOKS]
    assert all(r["created"] for r in results)
    room_create = client.created[0]
    assert room_create["url"] == "https://api.test/v1/webhooks/hypersnap"
    assert room_create["subscription"] == {
        "cast_created": {"parent_hashes": [svc.SENTINEL_CAST_HASH]}
    }
    assert client.created[1]["subscription"] == {
        "cast_created": {"parent_author_fids": [svc.SENTINEL_FID]}
    }


async def test_ensure_webhooks_provisions_shards_for_fid_count():
    client = _FakeWebhookClient(records=[])

    results = await svc.ensure_webhooks(
        client, push_fid_count=hw.MAX_FILTER_ENTRIES + 1
    )

    names = [r["name"] for r in results]
    assert len(names) == 1 + 2 * len(svc.PUSH_WEBHOOKS)
    assert "juke-push-reaction-1" in names
    assert "juke-push-reaction-2" not in names


async def test_ensure_webhooks_keeps_existing_extra_shards():
    records = _sharded_records(3)
    client = _FakeWebhookClient(records=records)
    results = await svc.ensure_webhooks(client)
    assert client.created == []
    assert len(results) == len(records)


def test_secret_env_joins_shard_secrets_per_var():
    results = [
        {"secret_var": "A", "secret": "s1"},
        {"secret_var": "A", "secret": "s2"},
        {"secret_var": "A", "secret": "s1"},
        {"secret_var": "B", "secret": None},
    ]
    assert svc.secret_env(results) == {"A": "s1,s2", "B": ""}


async def test_ensure_webhooks_respects_per_fid_cap():
    records = [
        _webhook_record(webhook_id=f"other_{i}", title=f"other-{i}")
        for i in range(hw.MAX_WEBHOOKS_PER_FID - 1)
    ]
    client = _FakeWebhookClient(records=records)
    with pytest.raises(svc.WebhookCapacityError):
        await svc.ensure_webhooks(client)
    assert client.created == []


# ---------------------------------------------------------------------------
# Payload normalization
# ---------------------------------------------------------------------------


@pytest.fixture
def _no_profile_lookup(monkeypatch):
    monkeypatch.setattr(svc, "_fetch_users", AsyncMock(return_value={}))


async def test_to_push_payload_reaction(_no_profile_lookup):
    payload = {
        "type": "reaction.created",
        "data": {
            "object": "reaction",
            "reaction_type": "like",
            "reactor_fid": 10,
            "target": {"object": "cast", "fid": 20, "hash": HASH_A},
        },
    }
    out = await svc.to_push_payload("reaction.created", payload)
    assert out["data"] == {
        "reaction_type": "like",
        "user": {"fid": 10},
        "cast": {"hash": HASH_A, "author": {"fid": 20}},
    }


async def test_to_push_payload_follow(_no_profile_lookup):
    payload = {"data": {"follower_fid": 10, "target_fid": 20}}
    out = await svc.to_push_payload("follow.created", payload)
    assert out["data"] == {"follower": {"fid": 10}, "user": {"fid": 20}}


async def test_to_push_payload_cast_accepts_flat_and_nested(monkeypatch):
    profile = {"fid": 10, "username": "alice", "display_name": "Alice"}
    monkeypatch.setattr(svc, "_fetch_users", AsyncMock(return_value={10: profile}))
    cast = {"hash": HASH_A, "author": {"fid": 10, "username": "fid:10"}}
    for data in (cast, {"cast": cast}):
        out = await svc.to_push_payload("cast.created", {"data": data})
        assert out["data"]["hash"] == HASH_A
        assert out["data"]["author"] == profile


async def test_to_push_payload_cast_restores_mentions(_no_profile_lookup, monkeypatch):
    hydrated = {"cast": {"hash": HASH_A, "text": "gm @alice"}}
    lookup = AsyncMock(return_value=hydrated)
    monkeypatch.setattr(svc.hypersnap, "get", lookup)
    cast = {"hash": HASH_A, "text": "gm ", "mentioned_profiles": [{"fid": 10}]}
    out = await svc.to_push_payload("cast.created", {"data": cast})
    assert out["data"]["text"] == "gm @alice"
    lookup.assert_awaited_once_with("/cast", {"identifier": HASH_A, "type": "hash"})


async def test_to_push_payload_cast_keeps_text_when_lookup_fails(
    _no_profile_lookup, monkeypatch
):
    error = svc.hypersnap.HypersnapUpstreamError("down", path="/cast")
    monkeypatch.setattr(svc.hypersnap, "get", AsyncMock(side_effect=error))
    cast = {"hash": HASH_A, "text": "gm ", "mentioned_profiles": [{"fid": 10}]}
    out = await svc.to_push_payload("cast.created", {"data": cast})
    assert out["data"]["text"] == "gm "


@pytest.mark.parametrize(
    "fetched", [{"hash": HASH_B, "text": "other @cast"}, "not a cast", None]
)
async def test_to_push_payload_cast_ignores_unusable_lookup(
    _no_profile_lookup, monkeypatch, fetched
):
    lookup = AsyncMock(return_value={"cast": fetched})
    monkeypatch.setattr(svc.hypersnap, "get", lookup)
    cast = {"hash": HASH_A, "text": "gm ", "mentioned_profiles": [{"fid": 10}]}
    out = await svc.to_push_payload("cast.created", {"data": cast})
    assert out["data"]["text"] == "gm "


async def test_to_push_payload_cast_without_mentions_skips_lookup(
    _no_profile_lookup, monkeypatch
):
    lookup = AsyncMock()
    monkeypatch.setattr(svc.hypersnap, "get", lookup)
    cast = {"hash": HASH_A, "text": "gm", "mentioned_profiles": []}
    out = await svc.to_push_payload("cast.created", {"data": cast})
    assert out["data"]["text"] == "gm"
    lookup.assert_not_awaited()


def test_dedupe_key_collapses_reply_and_mention_deliveries():
    data = {"hash": HASH_A.upper().replace("0X", "0x")}
    assert svc.dedupe_key("cast.created", data) == f"cast:{HASH_A}"
    assert svc.dedupe_key("cast.created", {"cast": data}) == f"cast:{HASH_A}"
    assert svc.dedupe_key("follow.created", {"follower_fid": 1}) is None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_db():
    result = MagicMock()
    result.scalars.return_value.first.return_value = None
    db = MagicMock()
    db.execute = AsyncMock(return_value=result)

    async def _override():
        yield db

    app.dependency_overrides[get_db] = _override
    yield db
    app.dependency_overrides.pop(get_db, None)


def _cast_body(parent_hash: str = HASH_A) -> bytes:
    return json.dumps(
        {"type": "cast.created", "data": {"hash": HASH_B, "parent_hash": parent_hash}}
    ).encode()


async def test_room_reply_route_fails_closed_without_secret(
    client, fake_db, monkeypatch
):
    monkeypatch.setattr(settings, "HYPERSNAP_WEBHOOK_SECRET_ROOM_REPLY", "")
    body = _cast_body()
    resp = await client.post(
        "/v1/webhooks/hypersnap",
        content=body,
        headers={"X-Hypersnap-Signature": _sign(body, "")},
    )
    assert resp.status_code == 503
    fake_db.execute.assert_not_called()


async def test_room_reply_route_rejects_bad_signature_before_parsing(
    client, fake_db, monkeypatch
):
    monkeypatch.setattr(settings, "HYPERSNAP_WEBHOOK_SECRET_ROOM_REPLY", TEST_SECRET)
    resp = await client.post(
        "/v1/webhooks/hypersnap",
        content=b"not json",
        headers={"X-Hypersnap-Signature": "00" * 64},
    )
    assert resp.status_code == 401
    resp = await client.post("/v1/webhooks/hypersnap", content=b"not json")
    assert resp.status_code == 401
    fake_db.execute.assert_not_called()


async def test_hypersnap_routes_reject_non_ascii_signature_with_401(
    client, fake_db, monkeypatch
):
    monkeypatch.setattr(settings, "HYPERSNAP_WEBHOOK_SECRET_ROOM_REPLY", TEST_SECRET)
    monkeypatch.setattr(settings, "HYPERSNAP_WEBHOOK_SECRET_FOLLOW", TEST_SECRET)
    for path in ("/v1/webhooks/hypersnap", "/v1/webhooks/hypersnap/notifications"):
        resp = await client.post(
            path, content=_cast_body(), headers={"X-Hypersnap-Signature": b"\xff"}
        )
        assert resp.status_code == 401
    fake_db.execute.assert_not_called()


async def test_room_reply_route_broadcasts_new_reply(client, fake_db, monkeypatch):
    monkeypatch.setattr(settings, "HYPERSNAP_WEBHOOK_SECRET_ROOM_REPLY", TEST_SECRET)
    room = MagicMock(id="room-1", cast_hash=HASH_A[2:])
    fake_db.execute.return_value.scalars.return_value.first.return_value = room
    livekit = MagicMock(send_data=AsyncMock(), close=AsyncMock())
    from app.routers import webhooks as webhooks_router

    monkeypatch.setattr(webhooks_router, "LiveKitService", lambda: livekit)
    body = _cast_body(parent_hash=HASH_A[2:])

    resp = await client.post(
        "/v1/webhooks/hypersnap",
        content=body,
        headers={"X-Hypersnap-Signature": _sign(body)},
    )

    assert resp.status_code == 200
    room_id, message = livekit.send_data.call_args.args[:2]
    assert room_id == "room-1"
    assert json.loads(message) == {"type": "new_reply", "cast_hash": HASH_A[2:]}


async def test_notifications_route_dispatches_and_dedupes(
    client, fake_db, monkeypatch, _no_profile_lookup
):
    for name in ("CAST", "MENTION", "REACTION", "FOLLOW"):
        monkeypatch.setattr(settings, f"HYPERSNAP_WEBHOOK_SECRET_{name}", "")
    monkeypatch.setattr(settings, "HYPERSNAP_WEBHOOK_SECRET_FOLLOW", TEST_SECRET)
    handle = AsyncMock()
    from app.services import push_service

    monkeypatch.setattr(push_service.PushService, "handle_notification_event", handle)
    body = json.dumps(
        {"type": "follow.created", "data": {"follower_fid": 1, "target_fid": 2}}
    ).encode()
    headers = {"X-Hypersnap-Signature": _sign(body)}

    resp = await client.post(
        "/v1/webhooks/hypersnap/notifications", content=body, headers=headers
    )
    assert resp.status_code == 200
    event_type, payload = handle.call_args.args
    assert event_type == "follow.created"
    assert payload["data"] == {"follower": {"fid": 1}, "user": {"fid": 2}}

    app.state.redis.set = AsyncMock(return_value=None)  # already seen
    resp = await client.post(
        "/v1/webhooks/hypersnap/notifications", content=body, headers=headers
    )
    assert resp.json() == {"status": "duplicate"}
    assert handle.call_count == 1


async def test_notifications_route_rejects_cross_event_replay(
    client, fake_db, monkeypatch
):
    for name in ("CAST", "MENTION", "REACTION"):
        monkeypatch.setattr(settings, f"HYPERSNAP_WEBHOOK_SECRET_{name}", "")
    monkeypatch.setattr(settings, "HYPERSNAP_WEBHOOK_SECRET_FOLLOW", TEST_SECRET)
    # Signed with the follow secret but claims to be a cast event.
    body = _cast_body()
    resp = await client.post(
        "/v1/webhooks/hypersnap/notifications",
        content=body,
        headers={"X-Hypersnap-Signature": _sign(body)},
    )
    assert resp.status_code == 401


async def test_notifications_route_fails_closed_without_secrets(
    client, fake_db, monkeypatch
):
    for name in ("CAST", "MENTION", "REACTION", "FOLLOW"):
        monkeypatch.setattr(settings, f"HYPERSNAP_WEBHOOK_SECRET_{name}", "")
    body = b"{}"
    resp = await client.post(
        "/v1/webhooks/hypersnap/notifications",
        content=body,
        headers={"X-Hypersnap-Signature": _sign(body, "")},
    )
    assert resp.status_code == 503


async def test_legacy_neynar_routes_removed(client):
    for path in ("/v1/webhooks/neynar", "/v1/webhooks/neynar/notifications"):
        resp = await client.post(path, content=b"{}")
        assert resp.status_code in (404, 405)


async def test_admin_setup_webhooks_provisions_shards_without_secrets(
    client, fake_db, monkeypatch
):
    from app.dependencies import get_redis
    from app.middleware.auth import get_admin_user
    from app.routers import admin

    fake_client = _FakeWebhookClient(records=[])
    monkeypatch.setattr(admin, "app_webhook_signer", lambda: None)
    monkeypatch.setattr(admin, "HypersnapWebhookClient", lambda _signer: fake_client)
    redis = MagicMock()
    redis.smembers = AsyncMock(
        return_value={str(fid).encode() for fid in range(1, 1501)}
    )

    async def _admin_override():
        return 1

    app.dependency_overrides[get_admin_user] = _admin_override
    app.dependency_overrides[get_redis] = lambda: redis
    try:
        response = await client.post("/v1/admin/setup-webhooks")
    finally:
        app.dependency_overrides.pop(get_admin_user, None)
        app.dependency_overrides.pop(get_redis, None)

    assert response.status_code == 200
    body = response.json()
    assert len(body["webhooks"]) == 1 + 2 * len(svc.PUSH_WEBHOOKS)
    # C2: signing secrets never leave the server via HTTP.
    assert "secret_env" not in body
    assert '"v1"' not in response.text
    for webhook in body["webhooks"]:
        assert "secret" not in webhook
        assert isinstance(webhook["secret_configured"], bool)
    follow_fids = [
        fid
        for webhook_id, kwargs in fake_client.updates
        if webhook_id.startswith("new_juke-push-follow")
        for fid in _filter_fids(kwargs["subscription"])
    ]
    assert sorted(follow_fids) == list(range(1, 1501))


async def test_admin_setup_webhooks_reports_secret_configured(
    client, fake_db, monkeypatch
):
    """``secret_configured`` reflects whether the live secret is deployed."""
    from app.dependencies import get_redis
    from app.middleware.auth import get_admin_user
    from app.routers import admin

    fake_client = _FakeWebhookClient(records=[])
    monkeypatch.setattr(admin, "app_webhook_signer", lambda: None)
    monkeypatch.setattr(admin, "HypersnapWebhookClient", lambda _signer: fake_client)
    monkeypatch.setattr(settings, "HYPERSNAP_WEBHOOK_SECRET_ROOM_REPLY", "old,v1")
    monkeypatch.setattr(settings, "HYPERSNAP_WEBHOOK_SECRET_CAST", "stale")
    redis = MagicMock()
    redis.smembers = AsyncMock(return_value=set())

    async def _admin_override():
        return 1

    app.dependency_overrides[get_admin_user] = _admin_override
    app.dependency_overrides[get_redis] = lambda: redis
    try:
        response = await client.post("/v1/admin/setup-webhooks")
    finally:
        app.dependency_overrides.pop(get_admin_user, None)
        app.dependency_overrides.pop(get_redis, None)

    assert response.status_code == 200
    by_var = {w["secret_var"]: w for w in response.json()["webhooks"]}
    assert by_var["HYPERSNAP_WEBHOOK_SECRET_ROOM_REPLY"]["secret_configured"] is True
    assert by_var["HYPERSNAP_WEBHOOK_SECRET_CAST"]["secret_configured"] is False


async def test_print_webhook_secrets_script_collects_secret_env():
    """The ops script is the out-of-band channel that replaced secret_env."""
    from scripts.print_hypersnap_webhook_secrets import collect_secret_env

    fake_client = _FakeWebhookClient()
    env = await collect_secret_env(fake_client)
    assert env["HYPERSNAP_WEBHOOK_SECRET_ROOM_REPLY"] == "v1"
    # Read-only: nothing created or updated.
    assert fake_client.created == []
    assert fake_client.updates == []
