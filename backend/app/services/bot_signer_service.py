"""Managed Ed25519 bot signers for self-serve Farcaster-native spaces.

Legacy developer bots authenticate with a custody EOA key that must live
in Juke's own environment (``custody_key_ref="env:<VAR>"``) — impossible
for external partners. This service implements the *managed-signer* path:

1. Juke generates an Ed25519 app key per bot.
2. The private key is stored AES-256-GCM-encrypted at rest, under a
   DEDICATED ``JUKE_BOT_SIGNER_ENCRYPTION_KEY`` (single-purpose-secret
   stance — NOT the developer-API-key cipher) with the bot row id bound
   as AAD so a ciphertext can't be transplanted onto another bot.
3. The bot FID's custody address adds the public key on-chain
   (``KeyGateway``); the key is ``approved`` once Hypersnap lists it under
   the bot's FID. (A Juke-relayed ``addFor`` for bots is a follow-up.)
4. Thereafter, JFS bearers are minted server-side per request.

Security invariants:
* The plaintext Ed25519 private key exists only in local scope — never
  logged, never returned, never assigned to the model except in
  encrypted form.
* Minting is gated on ``signer_status == "approved"`` AND a confirmed
  FID match. If the upstream lookup reports the key approved under a FID
  that isn't this bot's, the status flips to ``fid_mismatch`` and the
  bot can never mint (recovery = re-register with a fresh key).
* Encryption-key misconfiguration fails closed with a typed error that
  callers translate to an opaque 503 — the detail never leaks.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from cryptography.hazmat.primitives.asymmetric import ed25519
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.developer_app_bot import DeveloperAppBot
from app.services import signer_crypto, snap_signer_service
from app.services.jfs import mint_jfs_bearer

logger = logging.getLogger(__name__)

# Recheck cadences mirror the snap-signer cache so the two managed-signer
# surfaces behave identically. Pending is polled tightly (30s); approved
# is re-reconciled daily to catch silent on-chain revocations; revoked and
# fid_mismatch are terminal (recovery is an explicit re-register).
PENDING_RECHECK_SECONDS = snap_signer_service.PENDING_RECHECK_SECONDS
APPROVED_RECHECK_SECONDS = snap_signer_service.APPROVED_RECHECK_SECONDS
RECHECK_BY_STATUS = {
    "approved": APPROVED_RECHECK_SECONDS,
    "pending_approval": PENDING_RECHECK_SECONDS,
}
# Statuses that are never re-checked upstream.
TERMINAL_STATUSES = frozenset({"revoked", "fid_mismatch"})

AUTH_MODE_APP_KEY = "app_key"


# Bot signers share the generic signer cipher but keep their DEDICATED key
# (JUKE_BOT_SIGNER_ENCRYPTION_KEY) — never the user-signer fallback chain —
# so rotating SIGNER_ENCRYPTION_KEY can never orphan existing bot blobs.
# Aliased (not subclassed) so routers catching these names also catch the
# shared signer_crypto errors raised underneath.
BotSignerConfigError = signer_crypto.SignerKeyConfigError
BotSignerCryptoError = signer_crypto.SignerDecryptError


class BotSignerNotReady(Exception):
    """Bot signer cannot mint a bearer (not approved / no key material)."""


def _load_bot_signer_aes_key() -> bytes:
    """Return the 32-byte AES-256 key for bot-signer encryption.

    Raises ``BotSignerConfigError`` (→ opaque 503) when unset/invalid.
    """
    return signer_crypto.decode_aes_key(settings.JUKE_BOT_SIGNER_ENCRYPTION_KEY)


def encrypt_bot_private_key(raw32: bytes, *, bot_id: str) -> str:
    """AES-256-GCM-encrypt a 32-byte Ed25519 private key.

    ``bot_id`` is bound as AAD so the ciphertext is cryptographically
    pinned to one row — a blob copied onto another bot fails to decrypt.
    Returns a versioned ``v1:`` blob (see ``signer_crypto``).
    """
    return signer_crypto.encrypt_private_key(
        raw32,
        aad=bot_id,
        purpose=signer_crypto.SignerPurpose.BOT,
        key=_load_bot_signer_aes_key(),
    )


def decrypt_bot_private_key(blob: str, *, bot_id: str) -> bytes:
    """Inverse of :func:`encrypt_bot_private_key`.

    Accepts both ``v1:`` blobs and the legacy unversioned blobs already
    stored for existing bots. Raises ``BotSignerCryptoError`` on any failure
    (tamper, wrong AAD, wrong key, malformed blob). Callers translate to an
    opaque 503.
    """
    return signer_crypto.decrypt_private_key(
        blob,
        aad=bot_id,
        purpose=signer_crypto.SignerPurpose.BOT,
        key=_load_bot_signer_aes_key(),
    )


def _now() -> datetime:
    return datetime.now(UTC)


async def provision_bot_signer(
    db: AsyncSession, bot: DeveloperAppBot
) -> DeveloperAppBot:
    """Generate a managed Ed25519 signer for ``bot``.

    Steps: keygen → encrypt privkey → persist signer columns +
    ``auth_mode="app_key"`` with ``signer_status="pending_approval"``.

    The key becomes usable once the bot FID's custody address adds it via
    ``KeyGateway`` (the ``addFor`` relay for bots is a follow-up); there is
    no hosted approval URL any more. ``refresh_bot_signer_status`` flips
    the status to ``approved`` once Hypersnap lists the key for the FID.

    The plaintext private key exists only in this function's local scope
    and is discarded after encryption.
    """
    raw_private, public_key_hex = signer_crypto.generate_ed25519_keypair()

    now = _now()
    bot.auth_mode = AUTH_MODE_APP_KEY
    bot.signer_public_key = public_key_hex
    # Encrypt in-place; the plaintext ``raw_private`` is never persisted or
    # logged and goes out of scope when this function returns.
    bot.signer_private_key_encrypted = encrypt_bot_private_key(
        raw_private, bot_id=str(bot.id)
    )
    # INVARIANT: ``approved`` is never persisted here. The approved state
    # carries mint authority and is only reached via
    # ``refresh_bot_signer_status``, which reads the key from Hypersnap
    # under this bot's FID.
    bot.signer_status = "pending_approval"
    bot.signer_approval_url = None
    bot.signer_registered_at = now
    bot.signer_last_checked_at = now
    bot.signer_approved_at = None

    await db.commit()
    await db.refresh(bot)
    return bot


async def refresh_bot_signer_status(
    db: AsyncSession, bot: DeveloperAppBot
) -> DeveloperAppBot:
    """Lazily reconcile ``bot``'s managed-signer status with Hypersnap.

    Cache semantics mirror ``snap_signer_service.get_signer_status_cached``:
    ``pending_approval`` is re-checked at most once / 30s, ``approved``
    once / 24h, and ``revoked`` / ``fid_mismatch`` are terminal (never
    re-checked). Non-managed bots and bots without a public key are
    returned unchanged.

    CRITICAL fid guard: minting is only ever unlocked when Hypersnap lists
    the key UNDER THIS BOT'S FID. If the reported FID differs (or is
    missing), the status becomes ``fid_mismatch`` and ``approval_url`` is
    cleared so the bot can never mint. An approved key that is no longer
    listed was removed on-chain and becomes ``revoked``.
    """
    if bot.auth_mode != AUTH_MODE_APP_KEY or not bot.signer_public_key:
        return bot

    now = _now()
    if bot.signer_status in TERMINAL_STATUSES:
        return bot

    recheck_window = RECHECK_BY_STATUS.get(bot.signer_status)
    if recheck_window is not None:
        last_checked = bot.signer_last_checked_at
        if last_checked is not None:
            # SQLite drops tzinfo on round-trip; coerce to UTC.
            if last_checked.tzinfo is None:
                last_checked = last_checked.replace(tzinfo=UTC)
            if now - last_checked < timedelta(seconds=recheck_window):
                return bot

    upstream = await snap_signer_service.check_ed25519_signer_status(
        bot.signer_public_key, bot.fid
    )
    upstream_status = upstream.get("status", "unknown")
    upstream_fid = upstream.get("fid")

    bot.signer_last_checked_at = now

    if upstream_status == "approved":
        # Fail closed: the lookup is scoped to ``bot.fid``, but re-check the
        # echoed FID so a malformed upstream payload can never unlock
        # minting. A missing or differing FID → fid_mismatch (terminal).
        try:
            fid_matches = upstream_fid is not None and int(upstream_fid) == bot.fid
        except (TypeError, ValueError):
            fid_matches = False
        if not fid_matches:
            bot.signer_status = "fid_mismatch"
            bot.signer_approval_url = None
            # Terminal + unusable: drop the key material. Re-registration
            # generates and encrypts a fresh key, so retaining this one buys
            # nothing and only widens the exposure window.
            bot.signer_private_key_encrypted = None
        else:
            bot.signer_status = "approved"
            bot.signer_approval_url = None
            if bot.signer_approved_at is None:
                bot.signer_approved_at = now
    elif bot.signer_status == "approved":
        # Previously listed, no longer active: removed on-chain. Terminal;
        # the key is unusable, so drop it. Re-registration replaces it.
        bot.signer_status = "revoked"
        bot.signer_approval_url = None
        bot.signer_private_key_encrypted = None
    else:
        bot.signer_status = upstream_status

    await db.commit()
    await db.refresh(bot)
    return bot


async def mint_bearer_for_bot(bot: DeveloperAppBot) -> str:
    """Mint a fresh JFS bearer for an approved managed-signer bot.

    Guards on ``auth_mode == "app_key"``, ``signer_status == "approved"``,
    and presence of key material. Decrypts the private key into local
    scope, mints, and discards. Raises ``BotSignerNotReady`` if the bot
    isn't in a mintable state; ``BotSignerCryptoError`` /
    ``BotSignerConfigError`` (→ opaque 503) on crypto/config failure.
    """
    if bot.auth_mode != AUTH_MODE_APP_KEY:
        raise BotSignerNotReady("bot is not a managed-signer bot")
    if bot.signer_status != "approved":
        raise BotSignerNotReady("bot signer is not approved")
    if not bot.signer_public_key or not bot.signer_private_key_encrypted:
        raise BotSignerNotReady("bot signer has no key material")

    raw_private = decrypt_bot_private_key(
        bot.signer_private_key_encrypted, bot_id=str(bot.id)
    )
    private_key = ed25519.Ed25519PrivateKey.from_private_bytes(raw_private)
    return mint_jfs_bearer(
        fid=bot.fid,
        private_key=private_key,
        public_key_hex=bot.signer_public_key,
    )
