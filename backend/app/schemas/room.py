from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic import BaseModel, Field

from app.schemas.auth import UserResponse

if TYPE_CHECKING:
    from app.schemas.participant import ParticipantResponse


class RsvpUserResponse(BaseModel):
    fid: int
    display_name: str
    pfp_url: str | None = None


class RsvpSummary(BaseModel):
    count: int
    users: list[RsvpUserResponse] = []
    is_going: bool = False


class RsvpResponse(BaseModel):
    status: str


class RoomCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=256)
    announce_cast: bool = False
    scheduled_at: str | None = None  # ISO 8601 datetime string


class RoomResponse(BaseModel):
    id: str
    title: str
    host_fid: int
    host: UserResponse
    status: str
    started_at: str
    ended_at: str | None = None
    scheduled_at: str | None = None
    speaker_count: int = 0
    listener_count: int = 0
    recording: bool = False
    cast_hash: str | None = None
    rsvp_summary: RsvpSummary | None = None


class RoomCreateResponse(BaseModel):
    room: RoomResponse
    livekit_token: str | None = None
    livekit_ws_url: str | None = None


class RoomGoLiveResponse(BaseModel):
    room: RoomResponse
    livekit_token: str
    livekit_ws_url: str


class RoomListResponse(BaseModel):
    rooms: list[RoomResponse]
    next_cursor: str | None = None


class RoomDetailResponse(BaseModel):
    room: RoomResponse
    participants: list[ParticipantResponse]
    hand_queue: list[int] = []
