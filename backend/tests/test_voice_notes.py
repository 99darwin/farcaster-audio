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
from app.routers.voice_notes import _publish_voice_note_cast
from app.services.farcaster_writes import Signer
from app.schemas.voice_note import VoiceNoteCreateRequest


def make_auth_header(fid: int = 12345) -> dict:
    token = jwt.encode(
        {
            "fid": fid,
            "exp": int((datetime.now(timezone.utc) + timedelta(hours=72)).timestamp()),
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
    assert req.channel_id is None


def test_schema_accepts_mixed_case_parent_cast_hash():
    h = "0xAbCd" + "1" * 36
    req = VoiceNoteCreateRequest(
        upload_id=VALID_UPLOAD_ID,
        duration_ms=5000,
        parent_cast_hash=h,
    )
    assert req.parent_cast_hash == h


def test_schema_accepts_valid_channel_id():
    req = VoiceNoteCreateRequest(
        upload_id=VALID_UPLOAD_ID,
        duration_ms=5000,
        channel_id="fc-updates_1",
    )
    assert req.channel_id == "fc-updates_1"


@pytest.mark.parametrize(
    "bad_channel_id",
    [
        "-neynar",
        "_neynar",
        "neynar!",
        "a" * 65,
        "",
    ],
)
def test_schema_rejects_malformed_channel_id(bad_channel_id):
    with pytest.raises(ValidationError):
        VoiceNoteCreateRequest(
            upload_id=VALID_UPLOAD_ID,
            duration_ms=5000,
            channel_id=bad_channel_id,
        )


@pytest.mark.parametrize(
    "bad_hash",
    [
        "0xnotahex" + "0" * 33,  # non-hex chars
        "0x" + "a" * 39,  # too short
        "0x" + "a" * 41,  # too long
        "a" * 40,  # missing 0x prefix
        "",  # empty string
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


@pytest.mark.asyncio
async def test_create_voice_note_rejects_reply_with_channel_id(client):
    headers = make_auth_header()
    response = await client.post(
        "/v1/voice-notes/",
        json={
            "upload_id": VALID_UPLOAD_ID,
            "duration_ms": 5000,
            "post_to_farcaster": True,
            "parent_cast_hash": VALID_PARENT_HASH,
            "channel_id": "neynar",
        },
        headers=headers,
    )
    assert response.status_code == 400


VOICE_NOTE_ID = "00000000-0000-4000-8000-000000000123"
TEST_SIGNER = Signer(fid=12345, private_key=b"\x01" * 32)


@pytest.mark.asyncio
async def test_voice_note_cast_includes_channel_for_top_level_post(monkeypatch):
    publish = AsyncMock(return_value="0x" + "ab" * 20)
    monkeypatch.setattr("app.services.farcaster_writes.publish_cast", publish)

    await _publish_voice_note_cast(
        TEST_SIGNER,
        text="listen",
        voice_note_id=VOICE_NOTE_ID,
        parent_cast_hash=None,
        channel_id="neynar",
    )

    kwargs = publish.await_args.kwargs
    assert kwargs["channel_id"] == "neynar"
    assert kwargs["parent_hash"] is None
    assert kwargs["embed_urls"] == [f"https://juke.audio/v/{VOICE_NOTE_ID}"]


@pytest.mark.asyncio
async def test_voice_note_cast_prefers_reply_parent_over_channel(monkeypatch):
    publish = AsyncMock(return_value="0x" + "ab" * 20)
    monkeypatch.setattr("app.services.farcaster_writes.publish_cast", publish)

    await _publish_voice_note_cast(
        TEST_SIGNER,
        text="listen",
        voice_note_id=VOICE_NOTE_ID,
        parent_cast_hash=VALID_PARENT_HASH,
        channel_id="neynar",
    )

    kwargs = publish.await_args.kwargs
    assert kwargs["parent_hash"] == VALID_PARENT_HASH
    assert kwargs["channel_id"] is None


# --- Demo-readonly gate tests ---


def _mock_db_returning_signer(signer_uuid: str | None):
    scalar_result = MagicMock()
    scalar_result.scalar_one_or_none = MagicMock(return_value=signer_uuid)
    db = MagicMock()
    db.execute = AsyncMock(return_value=scalar_result)
    return db


@pytest.mark.parametrize(
    "sentinel",
    ["demo-readonly", "dev-signer", "admin", "readonly", "demo", "", "not-a-uuid"],
)
@pytest.mark.asyncio
async def test_require_non_demo_user_blocks_any_non_uuid_signer_in_prod(
    monkeypatch, sentinel
):
    """Any non-UUID signer for fid=1 in prod must be blocked — not just the current
    'demo-readonly' sentinel. Legacy rows (e.g. 'dev-signer') must also fail."""
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    db = _mock_db_returning_signer(sentinel)
    with pytest.raises(HTTPException) as exc_info:
        await require_non_demo_user(fid=1, db=db)
    assert exc_info.value.status_code in (401, 403)


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
    """Non-demo fids short-circuit before the DB check. Any fid != 1 passes."""
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
async def test_require_non_demo_user_allows_approved_signer_for_fid_1(monkeypatch):
    """If @farcaster (fid=1) adds a real app signer, writes succeed."""
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    db = _mock_db_returning_signer("approved")
    result = await require_non_demo_user(fid=1, db=db)
    assert result == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("signer_status", ["demo", "none", "pending"])
async def test_require_non_demo_user_blocks_unapproved_fid_1(
    monkeypatch, signer_status
):
    """fid=1 without an approved signer (demo session etc.) cannot write."""
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    db = _mock_db_returning_signer(signer_status)
    with pytest.raises(HTTPException) as exc_info:
        await require_non_demo_user(fid=1, db=db)
    assert exc_info.value.status_code == 403
