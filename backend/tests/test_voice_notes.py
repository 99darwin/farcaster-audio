"""Tests for voice notes router + schema.

Focus: reply threading (parent_cast_hash) plumbing. Full end-to-end publish
is covered by integration tests against a real DB/R2/Neynar in staging;
here we guard the public API surface.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest
from datetime import datetime, timedelta, timezone
from fastapi import HTTPException
from jose import jwt
from pydantic import ValidationError

from app.config import settings
from app.dependencies import DEMO_SIGNER_UUID, require_non_demo_user
from app.schemas.voice_note import VoiceNoteCreateRequest


def make_auth_header(fid: int = 12345) -> dict:
    token = jwt.encode(
        {
            "fid": fid,
            "exp": int(
                (datetime.now(timezone.utc) + timedelta(hours=72)).timestamp()
            ),
        },
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


VALID_UPLOAD_ID = "12345678-1234-1234-1234-123456789abc"
VALID_PARENT_HASH = "0x" + "a" * 40


# --- Schema tests ---


def test_schema_accepts_valid_parent_cast_hash():
    req = VoiceNoteCreateRequest(
        upload_id=VALID_UPLOAD_ID,
        duration_ms=5000,
        parent_cast_hash=VALID_PARENT_HASH,
    )
    assert req.parent_cast_hash == VALID_PARENT_HASH


def test_schema_parent_cast_hash_defaults_to_none():
    req = VoiceNoteCreateRequest(upload_id=VALID_UPLOAD_ID, duration_ms=5000)
    assert req.parent_cast_hash is None


def test_schema_accepts_mixed_case_parent_cast_hash():
    h = "0xAbCd" + "1" * 36
    req = VoiceNoteCreateRequest(
        upload_id=VALID_UPLOAD_ID,
        duration_ms=5000,
        parent_cast_hash=h,
    )
    assert req.parent_cast_hash == h


@pytest.mark.parametrize(
    "bad_hash",
    [
        "0xnotahex" + "0" * 33,   # non-hex chars
        "0x" + "a" * 39,           # too short
        "0x" + "a" * 41,           # too long
        "a" * 40,                  # missing 0x prefix
        "",                        # empty string
    ],
)
def test_schema_rejects_malformed_parent_cast_hash(bad_hash):
    with pytest.raises(ValidationError):
        VoiceNoteCreateRequest(
            upload_id=VALID_UPLOAD_ID,
            duration_ms=5000,
            parent_cast_hash=bad_hash,
        )


# --- HTTP endpoint tests ---


@pytest.mark.asyncio
async def test_create_voice_note_requires_auth(client):
    response = await client.post(
        "/v1/voice-notes/",
        json={"upload_id": VALID_UPLOAD_ID, "duration_ms": 5000},
    )
    assert response.status_code in (401, 403)


@pytest.mark.asyncio
async def test_create_voice_note_rejects_bad_parent_cast_hash(client):
    headers = make_auth_header()
    response = await client.post(
        "/v1/voice-notes/",
        json={
            "upload_id": VALID_UPLOAD_ID,
            "duration_ms": 5000,
            "parent_cast_hash": "not-a-valid-hash",
        },
        headers=headers,
    )
    assert response.status_code == 422


# --- Demo-readonly gate tests ---


def _mock_db_returning_signer(signer_uuid: str | None):
    scalar_result = MagicMock()
    scalar_result.scalar_one_or_none = MagicMock(return_value=signer_uuid)
    db = MagicMock()
    db.execute = AsyncMock(return_value=scalar_result)
    return db


@pytest.mark.asyncio
async def test_require_non_demo_user_blocks_demo_signer_in_prod(monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    db = _mock_db_returning_signer(DEMO_SIGNER_UUID)
    with pytest.raises(HTTPException) as exc_info:
        await require_non_demo_user(fid=1, db=db)
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_require_non_demo_user_allows_demo_signer_in_development(monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    db = _mock_db_returning_signer(DEMO_SIGNER_UUID)
    # In development we never even query the DB.
    result = await require_non_demo_user(fid=1, db=db)
    assert result == 1
    db.execute.assert_not_called()


@pytest.mark.asyncio
async def test_require_non_demo_user_allows_real_signer_in_prod(monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    db = _mock_db_returning_signer("real-neynar-signer-uuid")
    result = await require_non_demo_user(fid=12345, db=db)
    assert result == 12345


@pytest.mark.asyncio
async def test_require_non_demo_user_short_circuits_non_demo_fid(monkeypatch):
    """Non-demo fids (!= 1) should not hit the DB in prod."""
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    db = _mock_db_returning_signer("real-neynar-signer-uuid")
    result = await require_non_demo_user(fid=12345, db=db)
    assert result == 12345
    db.execute.assert_not_called()


@pytest.mark.asyncio
async def test_require_non_demo_user_fails_closed_when_fid_1_missing(monkeypatch):
    """Valid JWT for fid=1 but user row deleted should fail, not pass."""
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    db = _mock_db_returning_signer(None)
    with pytest.raises(HTTPException) as exc_info:
        await require_non_demo_user(fid=1, db=db)
    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_require_non_demo_user_allows_real_signer_for_fid_1(monkeypatch):
    """If @farcaster (fid=1) signs in via real SIWN, writes should succeed."""
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    db = _mock_db_returning_signer("real-neynar-signer-for-farcaster")
    result = await require_non_demo_user(fid=1, db=db)
    assert result == 1
