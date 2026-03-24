from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic import BaseModel, Field

if TYPE_CHECKING:
    from app.schemas.room import RoomResponse


class ParticipantResponse(BaseModel):
    fid: int
    role: str
    is_muted: bool
    hand_raised: bool
    display_name: str
    pfp_url: str | None = None


class JoinResponse(BaseModel):
    livekit_token: str
    livekit_ws_url: str
    role: str
    room: RoomResponse
    participants: list[ParticipantResponse]


class RaiseHandRequest(BaseModel):
    raised: bool


class RaiseHandResponse(BaseModel):
    hand_raised: bool
    queue_position: int | None = None


class PromoteResponse(BaseModel):
    fid: int
    role: str


class BanRequest(BaseModel):
    reason: str | None = None
    duration_hours: int | None = Field(default=None, ge=1, le=8760)


class BanResponse(BaseModel):
    fid: int
    status: str
    expires_at: str | None = None


class TokenRefreshResponse(BaseModel):
    livekit_token: str
    expires_at: str
