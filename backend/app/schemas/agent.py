import re

from pydantic import BaseModel, Field, field_validator

# Allow alphanumeric, spaces, hyphens, underscores, dots
_SAFE_NAME_PATTERN = re.compile(r"^[\w\s\-\.]+$")


class AgentJoinRequest(BaseModel):
    """Request body for agent joins. Agents must identify themselves."""
    agent_name: str = Field(..., min_length=1, max_length=128, description="Display name for the agent")
    agent_pfp_url: str | None = Field(default=None, max_length=512, description="Optional avatar URL (https only)")

    @field_validator("agent_name")
    @classmethod
    def validate_agent_name(cls, v: str) -> str:
        if not _SAFE_NAME_PATTERN.match(v):
            raise ValueError("agent_name must contain only letters, numbers, spaces, hyphens, underscores, and dots")
        return v.strip()

    @field_validator("agent_pfp_url")
    @classmethod
    def validate_agent_pfp_url(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not v.startswith("https://"):
            raise ValueError("agent_pfp_url must use HTTPS scheme")
        return v


class AgentJoinResponse(BaseModel):
    """Extended join response for agents — includes session_token."""
    session_token: str
    livekit_token: str
    livekit_ws_url: str
    role: str
    room: dict  # RoomResponse serialized
    participants: list[dict]  # ParticipantResponse serialized
