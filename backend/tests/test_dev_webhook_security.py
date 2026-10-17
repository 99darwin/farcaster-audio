"""M1/L9: webhook SSRF pinning, port allowlist, secret encryption, status."""

import base64
import json
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi import HTTPException, Response
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import Base
from app.models.developer_webhook import DeveloperWebhook
from app.routers import developer as developer_router
from app.schemas.developer import DeveloperWebhookCreate
from app.services import dev_webhook_service as svc
from app.services import signer_crypto
from app.services.developer_key_service import VerifiedDeveloperKey

PUBLIC_IP = "93.184.216.34"
KEY_B64 = base64.urlsafe_b64encode(b"\x07" * 32).decode()


@pytest.fixture(autouse=True)
def encryption_key(monkeypatch):
    monkeypatch.setattr(settings, "SIGNER_ENCRYPTION_KEY", KEY_B64)
    monkeypatch.setattr(settings, "SIGNER_ENCRYPTION_KEYS", "")


@pytest.fixture
async def session_factory():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(
            Base.metadata.create_all, tables=[DeveloperWebhook.__table__]
        )
    yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    await engine.dispose()


def _resolve_to(*ips: str):
    return patch.object(svc, "_resolve_hostname", AsyncMock(return_value=list(ips)))


# --- address classification -------------------------------------------------


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",
        "10.0.0.5",
        "169.254.169.254",
        "100.64.0.1",  # CGNAT: not is_global
        "::1",
        "::ffff:127.0.0.1",  # IPv4-mapped loopback
        "::ffff:169.254.169.254",
        "64:ff9b::7f00:1",  # NAT64 of 127.0.0.1
        "fd00::1",
    ],
)
def test_non_public_addresses_are_unsafe(ip):
    assert svc._is_safe_ip(ip) is False


def test_public_address_is_safe():
    assert svc._is_safe_ip(PUBLIC_IP) is True


# --- target resolution / pinning ---------------------------------------------


async def test_target_pins_resolved_ip_and_keeps_host_and_sni():
    with _resolve_to(PUBLIC_IP):
        target, error = await svc._resolve_delivery_target(
            "https://hooks.example.com/juke?x=1"
        )
    assert error == ""
    assert target.url == f"https://{PUBLIC_IP}/juke?x=1"
    assert target.host_header == "hooks.example.com"
    assert target.sni_hostname == "hooks.example.com"


async def test_ipv6_target_is_bracketed_and_http_has_no_sni():
    with _resolve_to("2606:2800:220:1:248:1893:25c8:1946"):
        target, _ = await svc._resolve_delivery_target("http://hooks.example.com:80/")
    assert target.url == "http://[2606:2800:220:1:248:1893:25c8:1946]:80/"
    assert target.host_header == "hooks.example.com:80"
    assert target.sni_hostname is None


async def test_any_private_answer_blocks_delivery():
    with _resolve_to(PUBLIC_IP, "10.0.0.1"):
        assert await svc._resolve_delivery_target("https://mixed.example.com/") == (
            None,
            "blocked_ip",
        )


@pytest.mark.parametrize(
    "url,category",
    [
        ("https://hooks.example.com:6379/", "blocked_port"),
        ("http://hooks.example.com:8080/", "blocked_port"),
        ("https://user:pw@hooks.example.com/", "invalid_url"),
        ("ftp://hooks.example.com/", "invalid_url"),
        ("https://hooks.example.com:notaport/", "invalid_url"),
    ],
)
async def test_rejected_urls_never_resolve(url, category):
    resolver = AsyncMock(return_value=[PUBLIC_IP])
    with patch.object(svc, "_resolve_hostname", resolver):
        assert await svc._resolve_delivery_target(url) == (None, category)
    resolver.assert_not_awaited()


async def test_deliver_once_connects_to_pinned_ip_without_reresolving():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(204)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with _resolve_to(PUBLIC_IP):
        status_code, error = await svc._deliver_once(
            client, "https://hooks.example.com/in", "whsec_x", b"{}", event_id="e1"
        )
    await client.aclose()
    assert (status_code, error) == (204, "")
    request = seen[0]
    assert request.url.host == PUBLIC_IP
    assert request.headers["host"] == "hooks.example.com"
    assert request.extensions["sni_hostname"] == "hooks.example.com"


async def test_deliver_once_refuses_rebinding_to_private_ip():
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: pytest.fail("must not connect"))
    )
    with _resolve_to("127.0.0.1"):
        result = await svc._deliver_once(
            client, "https://rebind.example.com/", "whsec_x", b"{}", event_id="e1"
        )
    await client.aclose()
    assert result == (None, "blocked_ip")


# --- public status vocabulary ------------------------------------------------


def _webhook(**fields) -> DeveloperWebhook:
    return DeveloperWebhook(
        id=uuid.uuid4(), app_id=uuid.uuid4(), url="https://x.example", **fields
    )


def test_public_outcome_maps_to_fixed_vocabulary():
    now = datetime.now(timezone.utc)
    assert svc.public_delivery_outcome(_webhook()) is None
    assert (
        svc.public_delivery_outcome(_webhook(last_delivery_at=now, last_error=None))
        == "success"
    )
    assert (
        svc.public_delivery_outcome(
            _webhook(last_delivery_at=now, last_error="timeout")
        )
        == "timeout"
    )
    # Anything outside the vocabulary (e.g. a legacy raw string) is generic.
    assert (
        svc.public_delivery_outcome(
            _webhook(last_delivery_at=now, last_error="ConnectError: 10.0.0.5:22")
        )
        == svc.GENERIC_ERROR_CATEGORY
    )


def test_router_response_never_exposes_raw_status():
    webhook = _webhook(
        last_delivery_at=datetime.now(timezone.utc),
        last_status=502,
        last_error="Connection refused by 10.0.0.5",
        events=["room.started"],
        created_at=datetime.now(timezone.utc),
    )
    fields = developer_router._webhook_response_fields(webhook)
    assert fields["last_status"] is None
    assert fields["last_error"] == svc.GENERIC_ERROR_CATEGORY
    assert fields["last_outcome"] == svc.GENERIC_ERROR_CATEGORY


# --- schema ------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "https://hooks.example.com:6379/",
        "https://hooks.example.com:8443/",
        "https://user:pw@hooks.example.com/",
    ],
)
def test_schema_rejects_nonstandard_port_and_credentials(url):
    with pytest.raises(ValidationError):
        DeveloperWebhookCreate(url=url, events=["room.started"])


def test_schema_accepts_default_ports():
    for url in ("https://hooks.example.com/", "https://hooks.example.com:443/x"):
        assert DeveloperWebhookCreate(url=url, events=["room.started"]).url


# --- secret encryption -------------------------------------------------------


def test_secret_round_trip_and_aad_binding():
    webhook_id = uuid.uuid4()
    secret = svc.generate_secret()
    blob = svc.encrypt_secret(webhook_id, secret)
    assert secret not in blob and not blob.startswith(svc.SECRET_PREFIX)
    assert svc.decrypt_secret(webhook_id, blob) == secret
    # A blob copied onto another row does not decrypt.
    with pytest.raises(signer_crypto.SignerDecryptError):
        svc.decrypt_secret(uuid.uuid4(), blob)


def test_legacy_plaintext_secret_still_signs():
    assert svc.decrypt_secret(uuid.uuid4(), "whsec_legacy") == "whsec_legacy"


async def test_encrypt_legacy_secrets_backfills_once(session_factory):
    legacy_id, encrypted_id = uuid.uuid4(), uuid.uuid4()
    async with session_factory() as db:
        db.add_all(
            [
                DeveloperWebhook(
                    id=legacy_id,
                    app_id=uuid.uuid4(),
                    url="https://a.example",
                    secret="whsec_old",
                    events=[],
                ),
                DeveloperWebhook(
                    id=encrypted_id,
                    app_id=uuid.uuid4(),
                    url="https://b.example",
                    secret=svc.encrypt_secret(encrypted_id, "whsec_new"),
                    events=[],
                ),
            ]
        )
        await db.commit()

    assert await svc.encrypt_legacy_secrets(session_factory) == 1
    assert await svc.encrypt_legacy_secrets(session_factory) == 0

    async with session_factory() as db:
        rows = dict(
            (await db.execute(select(DeveloperWebhook.id, DeveloperWebhook.secret)))
            .tuples()
            .all()
        )
    assert not rows[legacy_id].startswith("whsec_")
    assert svc.decrypt_secret(legacy_id, rows[legacy_id]) == "whsec_old"
    assert svc.decrypt_secret(encrypted_id, rows[encrypted_id]) == "whsec_new"


async def test_encrypt_legacy_secrets_fails_fast_without_key(
    session_factory, monkeypatch
):
    monkeypatch.setattr(settings, "SIGNER_ENCRYPTION_KEY", "")
    with pytest.raises(signer_crypto.SignerKeyConfigError):
        await svc.encrypt_legacy_secrets(session_factory)


async def test_dispatch_records_secret_unavailable_without_delivering(
    session_factory,
):
    webhook = _webhook(secret="v1:garbage", events=["room.started"])
    recorded = AsyncMock()
    deliver = AsyncMock()
    with (
        patch.object(
            svc, "_list_subscriptions_for_event", AsyncMock(return_value=[webhook])
        ),
        patch.object(svc, "_record_delivery_result", recorded),
        patch.object(svc, "_deliver_with_retry", deliver),
    ):
        await svc.dispatch(
            AsyncMock(), app_id=webhook.app_id, event_type="room.started", data={}
        )
        await svc.drain_delivery_tasks()
    deliver.assert_not_called()
    assert recorded.await_args.args[1:] == (
        webhook.id,
        None,
        svc.ERROR_SECRET_UNAVAILABLE,
    )


# --- create route ------------------------------------------------------------


async def _create(session_factory, url: str = "https://hooks.example.com/in"):
    key = VerifiedDeveloperKey(fid=1, app_id=uuid.uuid4(), key_id="jk_test")
    async with session_factory() as db:
        with patch.object(developer_router, "_enforce_rate_limit", AsyncMock()):
            return await developer_router.create_developer_webhook(
                body=DeveloperWebhookCreate(url=url, events=["room.started"]),
                response=Response(),
                verified_key=key,
                db=db,
                redis=AsyncMock(),
            )


async def test_create_stores_encrypted_secret_and_returns_plaintext_once(
    session_factory,
):
    created = await _create(session_factory)
    assert created.secret.startswith("whsec_")
    assert created.last_status is None and created.last_outcome is None
    async with session_factory() as db:
        stored = await db.scalar(
            select(DeveloperWebhook.secret).where(DeveloperWebhook.id == created.id)
        )
    assert stored != created.secret and "whsec_" not in stored
    assert svc.decrypt_secret(created.id, stored) == created.secret
    # The GET shape has no secret field at all.
    assert "secret" not in json.loads(
        developer_router._webhook_response(
            DeveloperWebhook(
                id=created.id,
                app_id=created.app_id,
                url=created.url,
                events=created.events,
                created_at=created.created_at,
            )
        ).model_dump_json()
    )


async def test_create_fails_closed_without_encryption_key(session_factory, monkeypatch):
    monkeypatch.setattr(settings, "SIGNER_ENCRYPTION_KEY", "")
    with pytest.raises(HTTPException) as excinfo:
        await _create(session_factory)
    assert excinfo.value.status_code == 503
    async with session_factory() as db:
        assert await db.scalar(select(DeveloperWebhook.id)) is None


# --- audit log line ----------------------------------------------------------


def test_audit_line_has_identifiers_but_no_secret(caplog):
    from app.dependencies import log_developer_key_use

    raw_secret = "jk_sk_live_should_never_appear"
    request = SimpleNamespace(
        method="POST",
        url=SimpleNamespace(path="/v1/developer/webhooks"),
        headers={"x-juke-api-key": raw_secret},
    )
    verified = VerifiedDeveloperKey(
        fid=42, app_id=uuid.uuid4(), key_id="jk_pub", audit_hmac="abc123"
    )
    with caplog.at_level("INFO", logger="juke.audit.developer_api"):
        log_developer_key_use(request, verified)
    [record] = caplog.records
    message = record.getMessage()
    assert "path=/v1/developer/webhooks" in message
    assert "fid=42" in message and "key_id=jk_pub" in message
    assert "audit_hmac=abc123" in message
    assert raw_secret not in message
    assert record.audit_event == "developer_api_request"
