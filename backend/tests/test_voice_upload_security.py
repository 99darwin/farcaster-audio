"""Security tests for voice upload finalization, presigning, and related caps."""

import json
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from fastapi import HTTPException
from jose import jwt
from pydantic import ValidationError

from app.config import settings
from app.models.compose_draft import ComposeDraft
from app.dependencies import get_db, require_non_demo_user
from app.main import app
from app.schemas.compose_draft import (
    ComposeDraftCreate,
    DraftCastSnapshot,
    DraftVoiceMetadata,
    DraftVoiceUploadUrlRequest,
)
from app.services import voice_upload_service
from app.services.audio_probe import AnalyzedAudio, AudioValidationError
from app.services.storage_service import (
    PRESIGNED_UPLOAD_TTL_SECONDS,
    StorageService,
    extract_recording_s3_key,
)
from app.services.voice_upload_service import (
    MAX_VOICE_UPLOAD_SIZE_BYTES,
    VoiceUploadError,
    build_voice_note_staging_key,
    finalize_voice_upload,
)

FID = 12345
UPLOAD_ID = "12345678-1234-1234-1234-123456789abc"
STAGING_KEY = f"voice-note-uploads/{FID}/{UPLOAD_ID}.m4a"


def _client_error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code}}, "HeadObject")


class FakeStorage:
    """In-memory stand-in for StorageService's object operations."""

    def __init__(self, objects: dict[str, int] | None = None) -> None:
        self.objects = dict(objects or {})
        self.copies: list[tuple[str, str]] = []
        self.deleted: list[str] = []
        self.head_error: Exception | None = None
        self.copy_error: Exception | None = None
        self.size_after_copy: int | None = None

    def get_object_size(self, key: str) -> int:
        if self.head_error is not None:
            raise self.head_error
        if key not in self.objects:
            raise _client_error("404")
        return self.objects[key]

    def copy_object(self, source_key: str, dest_key: str) -> None:
        if self.copy_error is not None:
            raise self.copy_error
        self.copies.append((source_key, dest_key))
        size = self.objects[source_key]
        if self.size_after_copy is not None:
            size = self.size_after_copy
        self.objects[dest_key] = size

    def download_file(self, key: str, local_path: str) -> None:
        with open(local_path, "wb") as fh:
            fh.write(b"\x00" * 16)

    def delete_object(self, key: str) -> None:
        self.deleted.append(key)
        self.objects.pop(key, None)


def _analyzed(duration_ms: int = 4200) -> AnalyzedAudio:
    samples = duration_ms * 16
    return AnalyzedAudio(
        demuxer="mp4",
        codec="aac",
        duration_ms=duration_ms,
        pcm=b"\x10\x00" * samples,
    )


@pytest.fixture
def analyze_ok(monkeypatch):
    mock = AsyncMock(return_value=_analyzed())
    monkeypatch.setattr(voice_upload_service, "analyze_audio", mock)
    return mock


# --- finalize_voice_upload ---


async def test_finalize_promotes_to_fresh_immutable_key(analyze_ok):
    storage = FakeStorage({STAGING_KEY: 5000})

    audio = await finalize_voice_upload(
        storage, staging_key=STAGING_KEY, fid=FID, content_type="audio/mp4"
    )

    assert storage.copies == [(STAGING_KEY, audio.object_key)]
    assert audio.object_key.startswith(f"voice-notes/{FID}/")
    assert audio.object_key.endswith(".m4a")
    assert audio.object_key != STAGING_KEY
    # Server-derived values, not client-supplied ones.
    assert audio.audio_size == 5000
    assert audio.duration_ms == 4200
    assert len(audio.waveform_peaks) == 200
    # Staging is kept until the caller has persisted the voice note, so a
    # failure between finalize and the DB write stays retryable.
    assert STAGING_KEY not in storage.deleted
    assert audio.object_key in storage.objects


async def test_finalize_fails_closed_when_head_errors(analyze_ok):
    storage = FakeStorage({STAGING_KEY: 5000})
    storage.head_error = _client_error("InternalError")

    with pytest.raises(VoiceUploadError) as exc:
        await finalize_voice_upload(
            storage, staging_key=STAGING_KEY, fid=FID, content_type="audio/mp4"
        )

    assert exc.value.status_code == 503
    assert storage.copies == []
    analyze_ok.assert_not_awaited()
    # Transient failure: keep the staged audio so a draft can be retried.
    assert STAGING_KEY not in storage.deleted


async def test_finalize_rejects_missing_upload(analyze_ok):
    with pytest.raises(VoiceUploadError) as exc:
        await finalize_voice_upload(
            FakeStorage(), staging_key=STAGING_KEY, fid=FID, content_type="audio/mp4"
        )
    assert exc.value.status_code == 400


async def test_finalize_rejects_oversized_upload_before_copy(analyze_ok):
    storage = FakeStorage({STAGING_KEY: MAX_VOICE_UPLOAD_SIZE_BYTES + 1})

    with pytest.raises(VoiceUploadError) as exc:
        await finalize_voice_upload(
            storage, staging_key=STAGING_KEY, fid=FID, content_type="audio/mp4"
        )

    assert exc.value.status_code == 413
    assert storage.copies == []
    assert STAGING_KEY in storage.deleted


async def test_finalize_rechecks_size_of_immutable_copy(analyze_ok):
    """A re-PUT between the first HEAD and the copy can't slip past the cap."""
    storage = FakeStorage({STAGING_KEY: 5000})
    storage.size_after_copy = MAX_VOICE_UPLOAD_SIZE_BYTES * 5

    with pytest.raises(VoiceUploadError) as exc:
        await finalize_voice_upload(
            storage, staging_key=STAGING_KEY, fid=FID, content_type="audio/mp4"
        )

    assert exc.value.status_code == 413
    final_key = storage.copies[0][1]
    assert final_key in storage.deleted
    analyze_ok.assert_not_awaited()


async def test_finalize_rejects_invalid_audio_and_cleans_up(monkeypatch):
    monkeypatch.setattr(
        voice_upload_service,
        "analyze_audio",
        AsyncMock(side_effect=AudioValidationError("too_long")),
    )
    storage = FakeStorage({STAGING_KEY: 5000})

    with pytest.raises(VoiceUploadError) as exc:
        await finalize_voice_upload(
            storage, staging_key=STAGING_KEY, fid=FID, content_type="audio/mp4"
        )

    assert exc.value.status_code == 422
    final_key = storage.copies[0][1]
    assert final_key in storage.deleted
    assert STAGING_KEY in storage.deleted


async def test_finalize_copy_failure_is_503(analyze_ok):
    storage = FakeStorage({STAGING_KEY: 5000})
    storage.copy_error = _client_error("SlowDown")

    with pytest.raises(VoiceUploadError) as exc:
        await finalize_voice_upload(
            storage, staging_key=STAGING_KEY, fid=FID, content_type="audio/mp4"
        )
    assert exc.value.status_code == 503


def test_staging_key_is_outside_final_prefix():
    key = build_voice_note_staging_key(FID, UPLOAD_ID, "audio/mp3")
    assert key == f"voice-note-uploads/{FID}/{UPLOAD_ID}.mp3"
    assert not key.startswith("voice-notes/")


# --- StorageService presign ---


def test_presigned_upload_url_is_short_lived():
    storage = StorageService.__new__(StorageService)
    storage._client = MagicMock()
    storage._client.generate_presigned_url.return_value = "https://signed"

    storage.generate_presigned_upload_url("voice-note-uploads/1/x.m4a", "audio/mp4")

    kwargs = storage._client.generate_presigned_url.call_args.kwargs
    assert kwargs["ExpiresIn"] == PRESIGNED_UPLOAD_TTL_SECONDS
    assert PRESIGNED_UPLOAD_TTL_SECONDS <= 300


# --- extract_recording_s3_key host matching (L6) ---


def _recording_settings():
    mock_settings = MagicMock()
    mock_settings.AWS_S3_BUCKET_NAME = "juke-recordings"
    mock_settings.AWS_ENDPOINT_URL = None
    mock_settings.AWS_DEFAULT_REGION = "us-east-1"
    return mock_settings


@pytest.mark.parametrize(
    "host",
    [
        "juke-recordings.s3.evil.com",
        "juke-recordings.s3.us-east-1.amazonaws.com.evil.com",
        "juke-recordings.s3.attacker-region.amazonaws.com",
    ],
)
def test_recording_key_rejects_lookalike_bucket_hosts(host):
    with patch("app.services.storage_service.settings", _recording_settings()):
        assert extract_recording_s3_key(f"https://{host}/recordings/r/a.ogg") is None


@pytest.mark.parametrize(
    "host",
    [
        "juke-recordings.s3.us-east-1.amazonaws.com",
        "juke-recordings.s3.amazonaws.com",
    ],
)
def test_recording_key_accepts_exact_bucket_hosts(host):
    with patch("app.services.storage_service.settings", _recording_settings()):
        url = f"https://{host}/recordings/r/a.ogg"
        assert extract_recording_s3_key(url) == "recordings/r/a.ogg"


# --- Schema caps ---


def test_draft_waveform_peaks_length_capped():
    with pytest.raises(ValidationError):
        DraftVoiceMetadata(duration_ms=1000, waveform_peaks=[0.5] * 257)


@pytest.mark.parametrize("bad", [1.5, -0.1, float("nan"), float("inf")])
def test_draft_waveform_peak_values_bounded(bad):
    with pytest.raises(ValidationError):
        DraftVoiceUploadUrlRequest(duration_ms=1000, waveform_peaks=[0.2, bad])


def test_draft_waveform_peaks_accepts_recorder_output():
    meta = DraftVoiceMetadata(duration_ms=1000, waveform_peaks=[0.0, 0.5, 1.0] * 66)
    assert len(meta.waveform_peaks) == 198


def test_draft_cast_hash_length_capped():
    with pytest.raises(ValidationError):
        ComposeDraftCreate(text="x", parent_cast_hash="0x" + "a" * 65)
    with pytest.raises(ValidationError):
        DraftCastSnapshot(hash="0x" + "a" * 1000, author={"fid": 1})


def _auth_header(fid: int = FID) -> dict:
    token = jwt.encode(
        {
            "fid": fid,
            "exp": int((datetime.now(timezone.utc) + timedelta(hours=1)).timestamp()),
        },
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )
    return {"Authorization": f"Bearer {token}"}


async def test_bookmark_rejects_oversized_hash(client):
    response = await client.post(
        "/v1/feed/bookmarks/0x" + "a" * 200, headers=_auth_header()
    )
    assert response.status_code == 422


# --- Router wiring ---


@pytest.fixture
def overrides():
    db = MagicMock()
    db.commit = AsyncMock()
    db.refresh = AsyncMock()
    db.scalar = AsyncMock(return_value=0)
    db.add = MagicMock()

    async def _db():
        yield db

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[require_non_demo_user] = lambda: FID
    try:
        yield db
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(require_non_demo_user, None)


async def test_finalize_consumes_upload_token_atomically(client, overrides):
    redis = app.state.redis
    redis.getdel = AsyncMock(return_value=None)

    response = await client.post(
        "/v1/voice-notes/",
        json={"upload_id": UPLOAD_ID, "duration_ms": 5000, "post_to_farcaster": False},
    )

    assert response.status_code == 400
    redis.getdel.assert_awaited_once_with(f"voice_notes:upload:{UPLOAD_ID}")


async def test_finalize_uses_server_derived_audio_values(
    client, overrides, monkeypatch
):
    redis = app.state.redis
    redis.getdel = AsyncMock(
        return_value=json.dumps(
            {
                "fid": FID,
                "object_key": STAGING_KEY,
                "content_type": "audio/mp4",
                "duration_ms": 60000,
            }
        )
    )
    finalized = voice_upload_service.FinalizedVoiceAudio(
        object_key=f"voice-notes/{FID}/final.m4a",
        audio_size=4321,
        duration_ms=4200,
        waveform_peaks=[0.5] * 200,
    )
    finalize = AsyncMock(return_value=finalized)
    monkeypatch.setattr("app.routers.voice_notes.finalize_voice_upload", finalize)
    vn = MagicMock(
        id="00000000-0000-4000-8000-000000000001",
        fid=FID,
        duration_ms=4200,
        audio_size=4321,
        waveform_peaks=[0.5] * 200,
        transcript=None,
        transcript_lang=None,
        transcript_words=None,
        cast_hash=None,
        cast_url=None,
        parent_cast_hash=None,
        caption=None,
        created_at=datetime.now(timezone.utc),
    )
    create = AsyncMock(return_value=vn)
    monkeypatch.setattr(
        "app.routers.voice_notes.voice_note_service.create_voice_note", create
    )
    monkeypatch.setattr("app.workers.voice_note_worker.process_voice_note", AsyncMock())
    storage = MagicMock()
    storage.generate_presigned_get_url.return_value = "https://get"
    monkeypatch.setattr("app.routers.voice_notes._get_storage", lambda: storage)

    response = await client.post(
        "/v1/voice-notes/",
        json={
            "upload_id": UPLOAD_ID,
            "duration_ms": 60000,
            "audio_size": 1,
            "post_to_farcaster": False,
        },
    )

    assert response.status_code == 200, response.text
    assert finalize.await_args.kwargs["staging_key"] == STAGING_KEY
    kwargs = create.await_args.kwargs
    assert kwargs["duration_ms"] == 4200
    assert kwargs["audio_size"] == 4321
    assert kwargs["object_key"] == f"voice-notes/{FID}/final.m4a"
    assert kwargs["waveform_peaks"] == [0.5] * 200
    # Staging removed only after the voice note row exists.
    storage.delete_object.assert_called_once_with(STAGING_KEY)


def _staged_token() -> str:
    return json.dumps(
        {"fid": FID, "object_key": STAGING_KEY, "content_type": "audio/mp4"}
    )


async def test_finalize_maps_upload_errors_to_http(client, overrides, monkeypatch):
    redis = app.state.redis
    redis.getdel = AsyncMock(return_value=_staged_token())
    redis.set = AsyncMock()
    monkeypatch.setattr(
        "app.routers.voice_notes.finalize_voice_upload",
        AsyncMock(side_effect=VoiceUploadError(422, "Unsupported or invalid audio")),
    )
    monkeypatch.setattr("app.routers.voice_notes._get_storage", MagicMock)

    response = await client.post(
        "/v1/voice-notes/",
        json={"upload_id": UPLOAD_ID, "duration_ms": 5000, "post_to_farcaster": False},
    )
    assert response.status_code == 422
    # Definitive rejection: the token stays consumed.
    redis.set.assert_not_awaited()


async def test_transient_finalize_failure_restores_upload_token(
    client, overrides, monkeypatch
):
    from app.routers.voice_notes import UPLOAD_TTL_SECONDS

    redis = app.state.redis
    token = _staged_token()
    redis.getdel = AsyncMock(return_value=token)
    redis.set = AsyncMock()
    monkeypatch.setattr(
        "app.routers.voice_notes.finalize_voice_upload",
        AsyncMock(side_effect=VoiceUploadError(503, "Could not verify")),
    )
    monkeypatch.setattr("app.routers.voice_notes._get_storage", MagicMock)

    response = await client.post(
        "/v1/voice-notes/",
        json={"upload_id": UPLOAD_ID, "duration_ms": 5000, "post_to_farcaster": False},
    )

    assert response.status_code == 503
    redis.set.assert_awaited_once_with(
        f"voice_notes:upload:{UPLOAD_ID}", token, ex=UPLOAD_TTL_SECONDS
    )


async def test_upload_url_uses_staging_prefix_and_short_expiry(
    client, overrides, monkeypatch
):
    storage = MagicMock()
    storage.generate_presigned_upload_url.return_value = "https://put"
    monkeypatch.setattr("app.routers.voice_notes._get_storage", lambda: storage)

    response = await client.post(
        "/v1/voice-notes/upload-url",
        json={"duration_ms": 5000, "content_type": "audio/mp4"},
    )

    assert response.status_code == 200, response.text
    key = storage.generate_presigned_upload_url.call_args.args[0]
    assert key.startswith(f"voice-note-uploads/{FID}/")
    expires_at = datetime.fromisoformat(response.json()["expires_at"])
    remaining = expires_at - datetime.now(timezone.utc)
    assert remaining <= timedelta(seconds=PRESIGNED_UPLOAD_TTL_SECONDS)


async def test_create_draft_enforces_per_fid_cap(client, overrides):
    from app.dependencies import get_current_user
    from app.routers.drafts import MAX_DRAFTS_PER_FID

    overrides.scalar = AsyncMock(return_value=MAX_DRAFTS_PER_FID)
    app.dependency_overrides[get_current_user] = lambda: FID
    try:
        response = await client.post("/v1/drafts", json={"text": "gm"})
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert response.status_code == 409
    overrides.add.assert_not_called()


async def test_publish_voice_draft_uses_fail_closed_finalize(
    client, overrides, monkeypatch
):
    import uuid as uuid_mod

    draft_id = uuid_mod.uuid4()
    staging = f"voice-note-drafts/{FID}/{draft_id}/{UPLOAD_ID}.m4a"
    draft = MagicMock(
        id=draft_id,
        fid=FID,
        text="hi",
        parent_cast_hash=None,
        channel_id=None,
        post_to_farcaster=False,
        voice_metadata={
            "object_key": staging,
            "content_type": "audio/mp4",
            "duration_ms": 60000,
            "waveform_peaks": [1.0] * 200,
        },
    )
    monkeypatch.setattr(
        "app.routers.drafts._get_owned_draft", AsyncMock(return_value=draft)
    )
    monkeypatch.setattr("app.routers.drafts._get_storage", MagicMock)
    finalize = AsyncMock(side_effect=VoiceUploadError(503, "Could not verify"))
    monkeypatch.setattr("app.routers.drafts.finalize_voice_upload", finalize)
    create = AsyncMock()
    monkeypatch.setattr(
        "app.routers.drafts.voice_note_service.create_voice_note", create
    )

    response = await client.post(f"/v1/drafts/{draft_id}/publish")

    assert response.status_code == 503
    assert finalize.await_args.kwargs["staging_key"] == staging
    create.assert_not_awaited()


async def test_concurrent_publish_is_rejected(client, overrides, monkeypatch):
    draft_id = "00000000-0000-4000-8000-0000000000aa"
    draft = MagicMock(parent_cast_hash=None, channel_id=None)
    monkeypatch.setattr(
        "app.routers.drafts._get_owned_draft", AsyncMock(return_value=draft)
    )
    publish = AsyncMock()
    monkeypatch.setattr("app.routers.drafts._publish_claimed_draft", publish)
    redis = app.state.redis
    redis.set = AsyncMock(return_value=None)  # NX not acquired
    redis.delete = AsyncMock()

    response = await client.post(f"/v1/drafts/{draft_id}/publish")

    assert response.status_code == 409
    publish.assert_not_awaited()
    redis.delete.assert_not_awaited()


async def test_publish_lock_released_after_failure(client, overrides, monkeypatch):
    draft_id = "00000000-0000-4000-8000-0000000000ab"
    draft = MagicMock(parent_cast_hash=None, channel_id=None)
    monkeypatch.setattr(
        "app.routers.drafts._get_owned_draft", AsyncMock(return_value=draft)
    )
    monkeypatch.setattr(
        "app.routers.drafts._publish_claimed_draft",
        AsyncMock(side_effect=HTTPException(status_code=503, detail="x")),
    )
    redis = app.state.redis
    redis.set = AsyncMock(return_value=True)
    redis.delete = AsyncMock()

    response = await client.post(f"/v1/drafts/{draft_id}/publish")

    assert response.status_code == 503
    lock_key = f"drafts:publish_lock:{draft_id}"
    assert redis.set.await_args.args[0] == lock_key
    assert redis.set.await_args.kwargs["nx"] is True
    redis.delete.assert_awaited_once_with(lock_key)


def _voice_draft(draft_id: uuid.UUID, object_key: str) -> ComposeDraft:
    now = datetime.now(timezone.utc)
    return ComposeDraft(
        id=draft_id,
        fid=FID,
        text="",
        channel_id=None,
        parent_cast_hash=None,
        parent_cast=None,
        quote_cast=None,
        media_embeds=[],
        voice_metadata={
            "duration_ms": 1000,
            "content_type": "audio/mp4",
            "waveform_peaks": [2.0, float("nan")],  # legacy, out of range
            "object_key": object_key,
        },
        post_to_farcaster=True,
        created_at=now,
        updated_at=now,
    )


@pytest.fixture
def patch_user():
    from app.dependencies import get_current_user

    app.dependency_overrides[get_current_user] = lambda: FID
    yield
    app.dependency_overrides.pop(get_current_user, None)


async def test_patch_voice_metadata_keeps_server_object_key(
    client, overrides, patch_user, monkeypatch
):
    draft_id = uuid.uuid4()
    key = f"voice-note-drafts/{FID}/{draft_id}/{UPLOAD_ID}.m4a"
    draft = _voice_draft(draft_id, key)
    monkeypatch.setattr(
        "app.routers.drafts._get_owned_draft", AsyncMock(return_value=draft)
    )
    storage = MagicMock()
    monkeypatch.setattr("app.routers.drafts._get_storage", lambda: storage)

    response = await client.patch(
        f"/v1/drafts/{draft_id}",
        json={"text": "hi", "voice_metadata": {"duration_ms": 2000}},
    )

    assert response.status_code == 200, response.text
    assert draft.voice_metadata["object_key"] == key
    assert draft.voice_metadata["duration_ms"] == 2000
    assert "object_key" not in response.json()["voice_metadata"]
    storage.delete_object.assert_not_called()


async def test_patch_text_with_legacy_peaks_does_not_500(
    client, overrides, patch_user, monkeypatch
):
    draft_id = uuid.uuid4()
    draft = _voice_draft(draft_id, f"voice-note-drafts/{FID}/{draft_id}/a.m4a")
    monkeypatch.setattr(
        "app.routers.drafts._get_owned_draft", AsyncMock(return_value=draft)
    )

    response = await client.patch(f"/v1/drafts/{draft_id}", json={"text": "hi"})

    assert response.status_code == 200, response.text


async def test_patch_clearing_voice_deletes_staged_object(
    client, overrides, patch_user, monkeypatch
):
    draft_id = uuid.uuid4()
    key = f"voice-note-drafts/{FID}/{draft_id}/{UPLOAD_ID}.m4a"
    draft = _voice_draft(draft_id, key)
    monkeypatch.setattr(
        "app.routers.drafts._get_owned_draft", AsyncMock(return_value=draft)
    )
    storage = MagicMock()
    monkeypatch.setattr("app.routers.drafts._get_storage", lambda: storage)

    response = await client.patch(
        f"/v1/drafts/{draft_id}", json={"text": "hi", "voice_metadata": None}
    )

    assert response.status_code == 200, response.text
    assert draft.voice_metadata is None
    storage.delete_object.assert_called_once_with(key)


async def test_delete_cast_rejects_oversized_hash(client):
    response = await client.delete(
        "/v1/feed/cast/0x" + "a" * 200, headers=_auth_header()
    )
    assert response.status_code == 422
