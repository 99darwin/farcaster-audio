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


TEST_SIGNER_FID = 12345
MEDIA_URL = "https://res.cloudinary.com/demo/image/upload/example.jpg"


def _text_draft(**overrides):
    draft = MagicMock()
    draft.text = "check this"
    draft.media_embeds = [{"url": MEDIA_URL}]
    draft.quote_cast = {"fid": 123, "hash": VALID_PARENT_HASH}
    draft.parent_cast_hash = None
    draft.channel_id = "juke"
    draft.voice_metadata = None
    for key, value in overrides.items():
        setattr(draft, key, value)
    return draft


def _signer():
    from app.services.farcaster_writes import Signer

    return Signer(fid=TEST_SIGNER_FID, private_key=b"\x01" * 32)


@pytest.mark.asyncio
async def test_draft_cast_includes_media_quote_and_channel(monkeypatch):
    from app.routers.drafts import _draft_embed_urls, _publish_draft_cast

    publish = AsyncMock(return_value="0x" + "c" * 40)
    monkeypatch.setattr("app.routers.drafts.publish_cast", publish)
    draft = _text_draft()

    await _publish_draft_cast(_signer(), draft, embed_urls=_draft_embed_urls(draft))

    kwargs = publish.await_args.kwargs
    assert kwargs["channel_id"] == "juke"
    assert kwargs["parent_hash"] is None
    assert kwargs["embed_urls"] == [MEDIA_URL]
    assert kwargs["quote"].fid == 123
    assert kwargs["quote"].hash == bytes.fromhex(VALID_PARENT_HASH[2:])


@pytest.mark.asyncio
async def test_voice_draft_cast_prefers_parent_over_channel(monkeypatch):
    from app.routers.drafts import _publish_draft_cast

    publish = AsyncMock(return_value="0x" + "c" * 40)
    monkeypatch.setattr("app.routers.drafts.publish_cast", publish)
    draft = _text_draft(
        text="listen",
        parent_cast_hash=VALID_PARENT_HASH,
        voice_metadata={"object_key": "k"},
    )
    embed = "https://juke.audio/v/11111111-1111-4111-8111-111111111111"

    await _publish_draft_cast(_signer(), draft, embed_urls=[embed])

    kwargs = publish.await_args.kwargs
    assert kwargs["parent_hash"] == VALID_PARENT_HASH
    assert kwargs["channel_id"] is None
    assert kwargs["quote"] is None
    assert kwargs["embed_urls"] == [embed]


def test_draft_text_urls_fill_only_remaining_embed_slots():
    from app.routers.drafts import _draft_embed_urls

    draft = _text_draft(
        text="see https://a.example/x, https://b.example/y and ftp://c.example",
        quote_cast=None,
        media_embeds=[],
    )
    assert _draft_embed_urls(draft) == ["https://a.example/x", "https://b.example/y"]

    # One media embed + a quote already fill both protocol slots.
    draft = _text_draft(text="see https://a.example/x")
    assert _draft_embed_urls(draft) == [MEDIA_URL]


def test_draft_text_urls_skip_oversized_urls():
    from app.routers.drafts import _draft_embed_urls

    long_url = "https://a.example/" + "x" * 300
    draft = _text_draft(
        text=f"{long_url} https://ok.example", quote_cast=None, media_embeds=[]
    )
    assert _draft_embed_urls(draft) == ["https://ok.example"]


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
