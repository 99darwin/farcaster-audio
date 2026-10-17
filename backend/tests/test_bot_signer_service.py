"""Tests for managed Ed25519 bot signers (``app.services.bot_signer_service``).

Covers the security-critical contract:
* encrypt/decrypt round-trips under the correct AAD (bot id),
* tampered ciphertext and wrong-AAD blobs fail closed,
* a missing/invalid encryption key raises the typed config error,
* ``provision_bot_signer`` persists an ENCRYPTED key + pending status and
  never logs plaintext key material,
* ``refresh_bot_signer_status`` honours the 30s/24h recheck windows, the
  terminal ``revoked`` state, and the CRITICAL fid-mismatch guard.
"""

import base64
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

pytest.importorskip("aiosqlite")

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import Base
from app.models.developer_app_bot import DeveloperAppBot
from app.services import bot_signer_service, snap_signer_service
from app.services.bot_signer_service import (
    BotSignerConfigError,
    BotSignerCryptoError,
    decrypt_bot_private_key,
    encrypt_bot_private_key,
)

# A deterministic 32-byte AES-256 key (base64url-encoded).
TEST_AES_KEY = base64.urlsafe_b64encode(b"\x11" * 32).decode()
BOT_FID = 424242
OTHER_FID = 999999


@pytest.fixture(autouse=True)
def _set_encryption_key(monkeypatch):
    monkeypatch.setattr(settings, "JUKE_BOT_SIGNER_ENCRYPTION_KEY", TEST_AES_KEY)


@pytest.fixture
async def db_session():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(
            Base.metadata.create_all,
            tables=[DeveloperAppBot.__table__],
        )
    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    async with session_factory() as session:
        yield session
    await engine.dispose()


def _new_bot(**overrides) -> DeveloperAppBot:
    import uuid

    kwargs = dict(
        id=uuid.uuid4(),
        app_id=uuid.uuid4(),
        fid=BOT_FID,
        label="test-bot",
        auth_mode="app_key",
    )
    kwargs.update(overrides)
    return DeveloperAppBot(**kwargs)


# ---------------------------------------------------------------------------
# Encryption at rest
# ---------------------------------------------------------------------------


def test_encrypt_decrypt_roundtrip():
    raw = b"\x07" * 32
    blob = encrypt_bot_private_key(raw, bot_id="bot-1")
    assert raw not in blob.encode()  # ciphertext, not plaintext
    assert decrypt_bot_private_key(blob, bot_id="bot-1") == raw


def test_encrypt_rejects_wrong_length():
    with pytest.raises(ValueError):
        encrypt_bot_private_key(b"tooshort", bot_id="bot-1")


def test_tampered_ciphertext_fails():
    blob = encrypt_bot_private_key(b"\x07" * 32, bot_id="bot-1")
    assert blob.startswith("v1:")
    raw = bytearray(base64.urlsafe_b64decode(blob.removeprefix("v1:").encode()))
    raw[-1] ^= 0xFF  # flip a ciphertext byte
    tampered = "v1:" + base64.urlsafe_b64encode(bytes(raw)).decode()
    with pytest.raises(BotSignerCryptoError):
        decrypt_bot_private_key(tampered, bot_id="bot-1")


def test_legacy_unversioned_blob_still_decrypts():
    # Bot blobs written before the v1 format are stored in production.
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    raw_key = base64.urlsafe_b64decode(TEST_AES_KEY)
    nonce = b"\x02" * 12
    legacy = base64.urlsafe_b64encode(
        nonce + AESGCM(raw_key).encrypt(nonce, b"\x07" * 32, b"bot-1")
    ).decode()
    assert decrypt_bot_private_key(legacy, bot_id="bot-1") == b"\x07" * 32


def test_wrong_bot_id_aad_fails():
    blob = encrypt_bot_private_key(b"\x07" * 32, bot_id="bot-1")
    with pytest.raises(BotSignerCryptoError):
        decrypt_bot_private_key(blob, bot_id="bot-2")


def test_missing_env_key_raises_typed_error(monkeypatch):
    monkeypatch.setattr(settings, "JUKE_BOT_SIGNER_ENCRYPTION_KEY", "")
    with pytest.raises(BotSignerConfigError):
        encrypt_bot_private_key(b"\x07" * 32, bot_id="bot-1")


def test_invalid_length_env_key_raises_typed_error(monkeypatch):
    # 16 bytes → AES-128, rejected to keep a single AES-256 tier.
    monkeypatch.setattr(
        settings,
        "JUKE_BOT_SIGNER_ENCRYPTION_KEY",
        base64.urlsafe_b64encode(b"\x11" * 16).decode(),
    )
    with pytest.raises(BotSignerConfigError):
        encrypt_bot_private_key(b"\x07" * 32, bot_id="bot-1")


# ---------------------------------------------------------------------------
# provision_bot_signer
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_provision_persists_encrypted_key_and_pending(
    db_session, monkeypatch, caplog
):

    bot = _new_bot(auth_mode="custody_env")
    db_session.add(bot)
    await db_session.flush()

    with caplog.at_level("DEBUG"):
        await bot_signer_service.provision_bot_signer(db_session, bot)

    assert bot.auth_mode == "app_key"
    assert bot.signer_status == "pending_approval"
    # No hosted approval URL: the key is added on-chain via KeyGateway.
    assert bot.signer_approval_url is None
    assert bot.signer_public_key.startswith("0x")
    assert bot.signer_private_key_encrypted
    assert bot.signer_registered_at is not None
    assert bot.signer_approved_at is None

    # The stored blob must decrypt back to a valid 32-byte Ed25519 key.
    raw = decrypt_bot_private_key(bot.signer_private_key_encrypted, bot_id=str(bot.id))
    assert len(raw) == 32

    # No PLAINTEXT private key material may appear in logs. (The encrypted
    # blob may surface in aiosqlite's DEBUG SQL echo — that's ciphertext,
    # not sensitive; the invariant is that the raw key never leaks.)
    assert raw.hex() not in caplog.text
    assert raw not in caplog.text.encode(errors="ignore")


# ---------------------------------------------------------------------------
# refresh_bot_signer_status
# ---------------------------------------------------------------------------


def _persisted_bot(db_session, **overrides):
    fields = dict(
        signer_public_key="0x" + "ab" * 32,
        signer_private_key_encrypted=encrypt_bot_private_key(
            b"\x07" * 32, bot_id="seed"
        ),
        signer_status="pending_approval",
        signer_registered_at=datetime.now(timezone.utc),
        signer_last_checked_at=datetime.now(timezone.utc),
    )
    fields.update(overrides)
    bot = _new_bot(**fields)
    db_session.add(bot)
    return bot


@pytest.mark.asyncio
async def test_refresh_pending_within_window_skips_neynar(db_session, monkeypatch):
    bot = _persisted_bot(db_session)
    await db_session.commit()

    check = AsyncMock()
    monkeypatch.setattr(snap_signer_service, "check_ed25519_signer_status", check)
    await bot_signer_service.refresh_bot_signer_status(db_session, bot)
    check.assert_not_called()


@pytest.mark.asyncio
async def test_refresh_pending_stale_calls_neynar_and_approves(db_session, monkeypatch):
    bot = _persisted_bot(
        db_session,
        signer_last_checked_at=datetime.now(timezone.utc) - timedelta(seconds=60),
    )
    await db_session.commit()

    check = AsyncMock(return_value={"status": "approved", "fid": BOT_FID})
    monkeypatch.setattr(snap_signer_service, "check_ed25519_signer_status", check)
    await bot_signer_service.refresh_bot_signer_status(db_session, bot)

    assert check.await_count == 1
    assert bot.signer_status == "approved"
    assert bot.signer_approved_at is not None
    assert bot.signer_approval_url is None


@pytest.mark.asyncio
async def test_refresh_approved_fresh_skips_neynar(db_session, monkeypatch):
    bot = _persisted_bot(
        db_session,
        signer_status="approved",
        signer_approved_at=datetime.now(timezone.utc),
    )
    await db_session.commit()

    check = AsyncMock()
    monkeypatch.setattr(snap_signer_service, "check_ed25519_signer_status", check)
    await bot_signer_service.refresh_bot_signer_status(db_session, bot)
    check.assert_not_called()


@pytest.mark.asyncio
async def test_refresh_approved_stale_rechecks(db_session, monkeypatch):
    bot = _persisted_bot(
        db_session,
        signer_status="approved",
        signer_approved_at=datetime.now(timezone.utc) - timedelta(days=2),
        signer_last_checked_at=datetime.now(timezone.utc) - timedelta(hours=25),
    )
    await db_session.commit()

    check = AsyncMock(return_value={"status": "revoked"})
    monkeypatch.setattr(snap_signer_service, "check_ed25519_signer_status", check)
    await bot_signer_service.refresh_bot_signer_status(db_session, bot)

    assert check.await_count == 1
    assert bot.signer_status == "revoked"
    # Terminal + unusable: the key material is nulled (re-registration replaces it).
    assert bot.signer_private_key_encrypted is None


@pytest.mark.asyncio
async def test_refresh_fid_mismatch_guard(db_session, monkeypatch):
    """Neynar reports approved but under a DIFFERENT fid → fid_mismatch."""
    bot = _persisted_bot(
        db_session,
        signer_last_checked_at=datetime.now(timezone.utc) - timedelta(seconds=60),
    )
    await db_session.commit()

    check = AsyncMock(return_value={"status": "approved", "fid": OTHER_FID})
    monkeypatch.setattr(snap_signer_service, "check_ed25519_signer_status", check)
    await bot_signer_service.refresh_bot_signer_status(db_session, bot)

    assert bot.signer_status == "fid_mismatch"
    assert bot.signer_approval_url is None
    # Terminal + unusable: the key material is nulled.
    assert bot.signer_private_key_encrypted is None
    # A fid_mismatch bot must never mint.
    with pytest.raises(bot_signer_service.BotSignerNotReady):
        await bot_signer_service.mint_bearer_for_bot(bot)


@pytest.mark.asyncio
async def test_refresh_approved_missing_fid_fails_closed(db_session, monkeypatch):
    """Approved but Neynar omits the fid → cannot confirm → fid_mismatch."""
    bot = _persisted_bot(
        db_session,
        signer_last_checked_at=datetime.now(timezone.utc) - timedelta(seconds=60),
    )
    await db_session.commit()

    check = AsyncMock(return_value={"status": "approved"})
    monkeypatch.setattr(snap_signer_service, "check_ed25519_signer_status", check)
    await bot_signer_service.refresh_bot_signer_status(db_session, bot)
    assert bot.signer_status == "fid_mismatch"
    assert bot.signer_private_key_encrypted is None


@pytest.mark.asyncio
async def test_refresh_approved_unparseable_fid_fails_closed(db_session, monkeypatch):
    """Approved but Neynar returns a non-numeric fid → fid_mismatch, no crash."""
    bot = _persisted_bot(
        db_session,
        signer_last_checked_at=datetime.now(timezone.utc) - timedelta(seconds=60),
    )
    await db_session.commit()

    check = AsyncMock(return_value={"status": "approved", "fid": "not-a-number"})
    monkeypatch.setattr(snap_signer_service, "check_ed25519_signer_status", check)
    await bot_signer_service.refresh_bot_signer_status(db_session, bot)
    assert bot.signer_status == "fid_mismatch"
    assert bot.signer_private_key_encrypted is None


@pytest.mark.asyncio
async def test_refresh_approved_stringified_matching_fid(db_session, monkeypatch):
    """A stringified matching fid still approves (int coercion)."""
    bot = _persisted_bot(
        db_session,
        signer_last_checked_at=datetime.now(timezone.utc) - timedelta(seconds=60),
    )
    await db_session.commit()

    check = AsyncMock(return_value={"status": "approved", "fid": str(BOT_FID)})
    monkeypatch.setattr(snap_signer_service, "check_ed25519_signer_status", check)
    await bot_signer_service.refresh_bot_signer_status(db_session, bot)
    assert bot.signer_status == "approved"


@pytest.mark.asyncio
async def test_refresh_revoked_is_terminal(db_session, monkeypatch):
    bot = _persisted_bot(
        db_session,
        signer_status="revoked",
        signer_last_checked_at=datetime.now(timezone.utc) - timedelta(days=99),
    )
    await db_session.commit()

    check = AsyncMock()
    monkeypatch.setattr(snap_signer_service, "check_ed25519_signer_status", check)
    await bot_signer_service.refresh_bot_signer_status(db_session, bot)
    check.assert_not_called()


@pytest.mark.asyncio
async def test_refresh_non_managed_bot_is_noop(db_session, monkeypatch):
    bot = _new_bot(auth_mode="custody_env", signer_public_key=None)
    db_session.add(bot)
    await db_session.commit()

    check = AsyncMock()
    monkeypatch.setattr(snap_signer_service, "check_ed25519_signer_status", check)
    result = await bot_signer_service.refresh_bot_signer_status(db_session, bot)
    check.assert_not_called()
    assert result is bot


# ---------------------------------------------------------------------------
# mint_bearer_for_bot
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mint_bearer_for_approved_bot_roundtrips(db_session, monkeypatch):
    from app.services.jfs import decode_jfs_bearer

    bot = _new_bot(auth_mode="custody_env")
    db_session.add(bot)
    await db_session.flush()
    await bot_signer_service.provision_bot_signer(db_session, bot)

    # Simulate approval.
    bot.signer_status = "approved"

    bearer = await bot_signer_service.mint_bearer_for_bot(bot)
    assert decode_jfs_bearer(bearer) == BOT_FID


@pytest.mark.asyncio
async def test_mint_bearer_rejects_unapproved(db_session):
    bot = _new_bot(
        signer_status="pending_approval",
        signer_public_key="0x" + "ab" * 32,
        signer_private_key_encrypted=encrypt_bot_private_key(b"\x07" * 32, bot_id="x"),
    )
    with pytest.raises(bot_signer_service.BotSignerNotReady):
        await bot_signer_service.mint_bearer_for_bot(bot)
