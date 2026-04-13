from pydantic import BaseModel, Field


class UploadUrlRequest(BaseModel):
    duration_ms: int = Field(..., gt=0, le=60000)
    content_type: str = Field(..., pattern=r"^audio/(mp4|aac|mp3)$")


class UploadUrlResponse(BaseModel):
    upload_id: str
    upload_url: str
    expires_at: str


class VoiceNoteCreateRequest(BaseModel):
    upload_id: str = Field(
        ...,
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    )
    duration_ms: int = Field(..., gt=0, le=60000)
    audio_size: int = Field(default=0, ge=0)
    post_to_farcaster: bool = True
    cast_text: str = Field(default="", max_length=1024)


class VoiceNoteAuthor(BaseModel):
    fid: int
    username: str
    display_name: str
    pfp_url: str | None = None


class VoiceNoteResponse(BaseModel):
    id: str
    fid: int
    duration_ms: int
    audio_url: str
    audio_size: int
    waveform_peaks: list[float] | None = None
    transcript: str | None = None
    transcript_lang: str | None = None
    transcript_words: list[dict] | None = None
    cast_hash: str | None = None
    cast_url: str | None = None
    caption: str | None = None
    created_at: str
    deleted_at: str | None = None


class VoiceNoteDetailResponse(BaseModel):
    voice_note: VoiceNoteResponse
    author: VoiceNoteAuthor
    reaction_counts: dict[str, int]
    viewer_reactions: list[str]
    play_count: int


class VoiceNoteFeedResponse(BaseModel):
    voice_notes: list[VoiceNoteDetailResponse]
    next_cursor: str | None = None


class PlayRequest(BaseModel):
    listened_ms: int = Field(..., ge=0)
    completed: bool = False


class ReactionRequest(BaseModel):
    reaction_type: str = Field(..., pattern=r"^(like|recast)$")
