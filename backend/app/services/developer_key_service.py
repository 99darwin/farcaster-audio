import base64
import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.developer import DeveloperApiKey, DeveloperApp
from app.models.user import User

PUBLIC_PREFIX = "jk_pub_live_"
SECRET_PREFIX = "jk_sec_live_"
FIRST_REVEAL_TTL = timedelta(minutes=15)


@dataclass(frozen=True)
class VerifiedDeveloperKey:
    # `fid` is derived from the key itself (key_id -> app -> owner_fid) so the
    # caller does not need to present a separate user JWT. The X-Juke-Api-Key
    # is now a true machine credential.
    fid: int
    app_id: UUID
    key_id: str
    audit_hmac: str | None = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _token_urlsafe(bytes_len: int = 24) -> str:
    return secrets.token_urlsafe(bytes_len).rstrip("=")


def _token_hex(bytes_len: int = 12) -> str:
    return secrets.token_hex(bytes_len)


def _require_pepper() -> bytes:
    if not settings.JUKE_API_KEY_PEPPER:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="API key pepper is not configured.",
        )
    return settings.JUKE_API_KEY_PEPPER.encode()


def hash_api_key(value: str) -> str:
    return hmac.new(_require_pepper(), value.encode(), hashlib.sha256).hexdigest()


def build_backend_audit_hmac(
    *,
    method: str,
    path: str,
    fid: int,
    key_id: str,
) -> str | None:
    # Audit HMAC must be its own dedicated secret. We previously fell back
    # to JUKE_API_KEY_PEPPER, which would let a holder of the API key hash
    # pepper also forge audit signatures — a clear single-purpose-secret
    # violation. If JUKE_API_AUDIT_SECRET is unset, return None and let
    # callers omit the header.
    secret = settings.JUKE_API_AUDIT_SECRET
    if not secret:
        return None
    message = "\n".join([method.upper(), path, str(fid), key_id])
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()


def _load_aes_key() -> bytes:
    raw = settings.JUKE_API_KEY_ENCRYPTION_KEY
    if not raw:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="API key encryption key is not configured.",
        )
    # AES-256 only. AES-128 / AES-192 are rejected to keep a single security
    # tier across deployments and avoid silently weakening encryption if an
    # operator misconfigures the key length.
    for decoder in (base64.urlsafe_b64decode, base64.b64decode):
        try:
            decoded = decoder(raw + "=" * (-len(raw) % 4))
        except Exception:
            continue
        if len(decoded) == 32:
            return decoded
    raw_bytes = raw.encode()
    if len(raw_bytes) == 32:
        return raw_bytes
    raise HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail="API key encryption key must decode to exactly 32 bytes (AES-256).",
    )


def encrypt_once_secret(secret_key: str, *, key_id: str) -> str:
    aesgcm = AESGCM(_load_aes_key())
    nonce = secrets.token_bytes(12)
    ciphertext = aesgcm.encrypt(nonce, secret_key.encode(), key_id.encode())
    return base64.urlsafe_b64encode(nonce + ciphertext).decode()


def decrypt_once_secret(encrypted: str, *, key_id: str) -> str:
    try:
        payload = base64.urlsafe_b64decode(encrypted.encode())
        nonce, ciphertext = payload[:12], payload[12:]
        return (
            AESGCM(_load_aes_key()).decrypt(nonce, ciphertext, key_id.encode()).decode()
        )
    except (ValueError, InvalidTag):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Stored secret cannot be revealed.",
        )


def generate_public_key() -> str:
    return f"{PUBLIC_PREFIX}{_token_urlsafe(18)}"


def generate_secret_key(key_id: str) -> str:
    return f"{SECRET_PREFIX}{key_id}_{_token_urlsafe(32)}"


INVALID_API_KEY_DETAIL = "Invalid Juke API key."


def parse_secret_key(value: str) -> str:
    if not value.startswith(SECRET_PREFIX):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=INVALID_API_KEY_DETAIL,
        )
    rest = value[len(SECRET_PREFIX) :]
    key_id, separator, _secret = rest.partition("_")
    if not separator or not key_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=INVALID_API_KEY_DETAIL,
        )
    return key_id


async def require_approved_developer(db: AsyncSession, fid: int) -> User:
    result = await db.execute(select(User).where(User.fid == fid))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found.",
        )
    if user.developer_access_status != "approved":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Developer access is not approved.",
        )
    return user


async def get_owned_app(db: AsyncSession, fid: int, app_id: UUID) -> DeveloperApp:
    result = await db.execute(
        select(DeveloperApp).where(
            DeveloperApp.id == app_id,
            DeveloperApp.owner_fid == fid,
            DeveloperApp.status != "deleted",
        )
    )
    app = result.scalar_one_or_none()
    if app is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Developer app not found.",
        )
    return app


async def create_api_key(
    db: AsyncSession,
    app: DeveloperApp,
    *,
    name: str,
    rotated_from_key_id: str | None = None,
    commit: bool = True,
) -> tuple[DeveloperApiKey, str, str, str]:
    """Create a new developer API key.

    When ``commit`` is True (default) the new key row is committed before
    returning. The rotate path passes ``commit=False`` so the caller can
    revoke the old key and insert the new key in a single transaction —
    if the new-key insert fails, the old key's revocation is rolled back.
    """
    key_id = _token_hex(10)
    public_key = generate_public_key()
    secret_key = generate_secret_key(key_id)
    reveal_token = _token_urlsafe(32)
    reveal_expires_at = _now() + FIRST_REVEAL_TTL
    api_key = DeveloperApiKey(
        app_id=app.id,
        key_id=key_id,
        name=name,
        public_key_hash=hash_api_key(public_key),
        secret_key_hash=hash_api_key(secret_key),
        encrypted_secret_once=encrypt_once_secret(secret_key, key_id=key_id),
        reveal_token_hash=hash_api_key(reveal_token),
        reveal_expires_at=reveal_expires_at,
        rotated_from_key_id=rotated_from_key_id,
    )
    db.add(api_key)
    if commit:
        await db.commit()
        await db.refresh(api_key)
    else:
        await db.flush()
        await db.refresh(api_key)
    return api_key, public_key, secret_key, reveal_token


async def clear_expired_reveal_blob(db: AsyncSession, key: DeveloperApiKey) -> None:
    """Zero the once-encrypted secret blob if its reveal window expired.

    Bounds the window in which a DB dump combined with the AES key compromise
    would expose plaintext secrets. Safe to call on already-revealed keys.
    """
    if key.encrypted_secret_once is None and key.reveal_token_hash is None:
        return
    expires_at = (
        _as_aware(key.reveal_expires_at) if key.reveal_expires_at is not None else None
    )
    if expires_at is None or expires_at >= _now():
        return
    key.encrypted_secret_once = None
    key.reveal_token_hash = None
    await db.commit()


async def reveal_api_key_once(
    db: AsyncSession,
    key: DeveloperApiKey,
    *,
    reveal_token: str,
) -> str:
    await clear_expired_reveal_blob(db, key)
    now = _now()
    expires_at = (
        _as_aware(key.reveal_expires_at) if key.reveal_expires_at is not None else None
    )
    if (
        key.encrypted_secret_once is None
        or key.revealed_at is not None
        or expires_at is None
        or expires_at < now
        or key.revoked_at is not None
        or key.reveal_token_hash is None
    ):
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="Secret is no longer revealable.",
        )
    if not hmac.compare_digest(hash_api_key(reveal_token), key.reveal_token_hash):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid reveal token.",
        )
    secret_key = decrypt_once_secret(key.encrypted_secret_once, key_id=key.key_id)
    key.encrypted_secret_once = None
    key.reveal_token_hash = None
    key.revealed_at = now
    await db.commit()
    return secret_key


LAST_USED_WRITE_THROTTLE = timedelta(seconds=60)


def _invalid_api_key() -> HTTPException:
    """All authentication failures in verify_developer_api_key return the
    same opaque 401. This prevents an attacker from probing whether a given
    bearer FID is an approved developer, owns a particular key id, or which
    of {parse, lookup, owner, app status, hash} failed."""
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=INVALID_API_KEY_DETAIL,
    )


async def verify_developer_api_key(
    db: AsyncSession,
    *,
    raw_secret_key: str,
    method: str | None = None,
    path: str | None = None,
    origin: str | None = None,
) -> VerifiedDeveloperKey:
    # Key-only auth: the secret key is parsed for its embedded key_id, the
    # key row is looked up, and the owning fid is read from the app. No
    # user JWT is required. All failure modes collapse into the same 401
    # via _invalid_api_key() so we don't leak which check tripped.
    try:
        key_id = parse_secret_key(raw_secret_key)
    except HTTPException:
        raise _invalid_api_key()

    result = await db.execute(
        select(DeveloperApiKey, DeveloperApp)
        .join(DeveloperApp, DeveloperApiKey.app_id == DeveloperApp.id)
        .where(DeveloperApiKey.key_id == key_id)
    )
    row = result.first()
    if row is None:
        raise _invalid_api_key()
    key, app = row
    fid = app.owner_fid

    # Approved-developer check. require_approved_developer raises 401 if the
    # user is missing and 403 if developer access is not approved/suspended.
    # Translate the 403 into the collapsed 401 so the error-string surface
    # stays opaque to attackers.
    try:
        await require_approved_developer(db, fid)
    except HTTPException:
        raise _invalid_api_key()

    if app.status != "active" or key.revoked_at is not None:
        raise _invalid_api_key()
    provided_hash = hash_api_key(raw_secret_key)
    if not hmac.compare_digest(provided_hash, key.secret_key_hash):
        raise _invalid_api_key()

    # Origin check: browsers always send an Origin header on POST, so when
    # a request arrives with an Origin and the app declares allowed_origins,
    # the request must come from one of them. Server-to-server callers
    # typically omit Origin entirely and are unaffected.
    if origin and app.allowed_origins:
        if origin not in app.allowed_origins:
            raise _invalid_api_key()

    now = _now()
    last_used_at = _as_aware(key.last_used_at) if key.last_used_at is not None else None
    # Batch last_used_at writes: only persist if older than 60s. Reduces DB
    # write amplification on hot keys and narrows a timing oracle.
    if last_used_at is None or now - last_used_at >= LAST_USED_WRITE_THROTTLE:
        key.last_used_at = now
        await db.commit()

    audit_hmac = (
        build_backend_audit_hmac(
            method=method,
            path=path,
            fid=fid,
            key_id=key.key_id,
        )
        if method and path
        else None
    )
    return VerifiedDeveloperKey(
        fid=fid,
        app_id=app.id,
        key_id=key.key_id,
        audit_hmac=audit_hmac,
    )
