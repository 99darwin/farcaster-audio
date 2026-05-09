from typing import Literal

from pydantic import BaseModel, Field, HttpUrl, model_validator


class DraftCastAuthor(BaseModel):
    fid: int
    username: str = ""
    display_name: str = ""
    pfp_url: str | None = None


class DraftCastSnapshot(BaseModel):
    hash: str = Field(..., pattern=r"^0x[a-fA-F0-9]+$")
    author: DraftCastAuthor
    text: str = Field(default="", max_length=10000)


class DraftQuoteCast(BaseModel):
    fid: int
    hash: str = Field(..., pattern=r"^0x[a-fA-F0-9]+$")
    author: DraftCastAuthor | None = None
    text: str = Field(default="", max_length=10000)


class DraftMediaEmbed(BaseModel):
    url: HttpUrl
    type: Literal["image", "video", "gif", "url"] = "url"
    source: Literal["uploaded", "giphy", "url"] = "uploaded"
    preview_url: HttpUrl | None = None


class DraftVoiceMetadata(BaseModel):
    duration_ms: int = Field(..., gt=0, le=60000)
    audio_size: int = Field(default=0, ge=0)
    content_type: str = Field(default="audio/mp4", pattern=r"^audio/(mp4|aac|mp3)$")
    waveform_peaks: list[float] | None = None


class ComposeDraftBase(BaseModel):
    text: str = Field(default="", max_length=10000)
    channel_id: str | None = Field(
        default=None,
        pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$",
    )
    parent_cast_hash: str | None = Field(default=None, pattern=r"^0x[a-fA-F0-9]+$")
    parent_cast: DraftCastSnapshot | None = None
    quote_cast: DraftQuoteCast | None = None
    media_embeds: list[DraftMediaEmbed] = Field(default_factory=list, max_length=4)
    voice_metadata: DraftVoiceMetadata | None = None
    post_to_farcaster: bool = True

    @model_validator(mode="after")
    def validate_context(self):
        if self.parent_cast_hash and self.channel_id:
            raise ValueError("Replies cannot target a channel")
        if self.parent_cast and self.parent_cast_hash != self.parent_cast.hash:
            raise ValueError("parent_cast_hash must match parent_cast.hash")
        if (
            not self.text.strip()
            and not self.media_embeds
            and not self.voice_metadata
            and not self.quote_cast
        ):
            raise ValueError("Draft must have text, media, voice, or a quote")
        return self


class ComposeDraftCreate(ComposeDraftBase):
    pass


class ComposeDraftUpdate(BaseModel):
    text: str | None = Field(default=None, max_length=10000)
    channel_id: str | None = Field(
        default=None,
        pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$",
    )
    parent_cast_hash: str | None = Field(default=None, pattern=r"^0x[a-fA-F0-9]+$")
    parent_cast: DraftCastSnapshot | None = None
    quote_cast: DraftQuoteCast | None = None
    media_embeds: list[DraftMediaEmbed] | None = Field(default=None, max_length=4)
    voice_metadata: DraftVoiceMetadata | None = None
    post_to_farcaster: bool | None = None


class ComposeDraftResponse(ComposeDraftBase):
    id: str
    fid: int
    created_at: str
    updated_at: str


class ComposeDraftListResponse(BaseModel):
    drafts: list[ComposeDraftResponse]


class DraftVoiceUploadUrlRequest(BaseModel):
    duration_ms: int = Field(..., gt=0, le=60000)
    content_type: str = Field(default="audio/mp4", pattern=r"^audio/(mp4|aac|mp3)$")
    waveform_peaks: list[float] | None = None


class DraftVoiceUploadUrlResponse(BaseModel):
    upload_url: str
    expires_at: str
    voice_metadata: DraftVoiceMetadata
