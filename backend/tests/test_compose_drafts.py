from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import ValidationError

from app.schemas.compose_draft import (
    ComposeDraftCreate,
    ComposeDraftUpdate,
    DraftVoiceMetadata,
)


VALID_PARENT_HASH = "0x" + "a" * 40


def test_draft_schema_accepts_text_and_channel():
    draft = ComposeDraftCreate(text="gm", channel_id="juke")
    assert draft.text == "gm"
    assert draft.channel_id == "juke"


def test_draft_schema_accepts_voice_metadata():
    draft = ComposeDraftCreate(
        text="listen",
        voice_metadata=DraftVoiceMetadata(
            object_key="voice-note-drafts/1/example.m4a",
            duration_ms=12000,
            audio_size=100,
            waveform_peaks=[0.1, 0.8],
        ),
    )
    assert draft.voice_metadata.duration_ms == 12000


def test_draft_schema_rejects_reply_with_channel():
    with pytest.raises(ValidationError):
        ComposeDraftCreate(
            text="reply",
            parent_cast_hash=VALID_PARENT_HASH,
            channel_id="juke",
        )


def test_draft_schema_rejects_empty_payload():
    with pytest.raises(ValidationError):
        ComposeDraftCreate(text="")


def test_update_candidate_rejects_reply_channel_conflict():
    from app.routers.drafts import _validate_update_candidate

    existing = MagicMock()
    existing.text = "reply"
    existing.channel_id = None
    existing.parent_cast_hash = VALID_PARENT_HASH
    existing.parent_cast = None
    existing.quote_cast = None
    existing.media_embeds = []
    existing.voice_metadata = None
    existing.post_to_farcaster = True

    with pytest.raises(ValidationError):
        _validate_update_candidate(
            existing,
            ComposeDraftUpdate(channel_id="juke"),
        )


def test_build_cast_payload_includes_media_quote_and_channel():
    from app.routers.drafts import _build_cast_payload

    draft = MagicMock()
    draft.text = "check this"
    draft.media_embeds = [
        {"url": "https://res.cloudinary.com/demo/image/upload/example.jpg"}
    ]
    draft.quote_cast = {"fid": 123, "hash": VALID_PARENT_HASH}
    draft.parent_cast_hash = None
    draft.channel_id = "juke"

    payload = _build_cast_payload(draft, "signer")

    assert payload["signer_uuid"] == "signer"
    assert payload["channel_id"] == "juke"
    assert payload["embeds"][0]["url"].startswith("https://")
    assert payload["embeds"][1]["cast_id"] == {
        "fid": 123,
        "hash": VALID_PARENT_HASH,
    }


def test_build_voice_cast_payload_prefers_parent_over_channel():
    from app.routers.drafts import _build_voice_cast_payload

    draft = MagicMock()
    draft.text = "listen"
    draft.parent_cast_hash = VALID_PARENT_HASH
    draft.channel_id = "juke"

    payload = _build_voice_cast_payload(
        draft,
        "signer",
        "11111111-1111-4111-8111-111111111111",
    )

    assert payload["parent"] == VALID_PARENT_HASH
    assert "channel_id" not in payload
    assert payload["embeds"][0]["url"].endswith("/11111111-1111-4111-8111-111111111111")


def test_draft_response_strips_internal_voice_object_key():
    from app.routers.drafts import _draft_to_response

    draft = MagicMock()
    draft.id = "00000000-0000-0000-0000-000000000000"
    draft.fid = 1
    draft.text = "voice"
    draft.channel_id = None
    draft.parent_cast_hash = None
    draft.parent_cast = None
    draft.quote_cast = None
    draft.media_embeds = []
    draft.voice_metadata = {
        "object_key": "voice-note-drafts/1/abc/file.m4a",
        "duration_ms": 1000,
        "audio_size": 0,
        "content_type": "audio/mp4",
    }
    draft.post_to_farcaster = True
    draft.created_at.isoformat.return_value = "2026-05-09T00:00:00+00:00"
    draft.updated_at.isoformat.return_value = "2026-05-09T00:00:00+00:00"

    response = _draft_to_response(draft)

    assert response.voice_metadata is not None
    assert not hasattr(response.voice_metadata, "object_key")


def test_owned_draft_voice_key_requires_user_and_draft_prefix():
    from app.routers.drafts import _owned_draft_voice_key

    draft_id = "00000000-0000-0000-0000-000000000000"
    assert _owned_draft_voice_key(
        1,
        draft_id,
        f"voice-note-drafts/1/{draft_id}/audio.m4a",
    )
    assert not _owned_draft_voice_key(
        2,
        draft_id,
        f"voice-note-drafts/1/{draft_id}/audio.m4a",
    )
    assert not _owned_draft_voice_key(1, draft_id, "voice-notes/1/audio.m4a")


@pytest.mark.asyncio
async def test_get_owned_draft_is_scoped_to_fid():
    from app.routers.drafts import _get_owned_draft

    scalar_result = MagicMock()
    scalar_result.scalar_one_or_none = MagicMock(return_value=None)
    db = MagicMock()
    db.execute = AsyncMock(return_value=scalar_result)

    with pytest.raises(Exception) as exc_info:
        await _get_owned_draft(
            db,
            draft_id="00000000-0000-0000-0000-000000000000",
            fid=1,
        )
    assert getattr(exc_info.value, "status_code", None) == 404
