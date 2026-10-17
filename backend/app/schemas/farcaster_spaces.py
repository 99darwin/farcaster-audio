"""Pydantic models for Farcaster-native audio spaces (the undocumented
`client.farcaster.xyz` API surface).

Field shapes mirror what Quorum Mobile's reverse-engineered client
documented. The upstream API uses camelCase keys and sometimes
denormalizes nested objects (e.g. `pfp.url` collapses to `pfpUrl` on
some endpoints), so models are configured to accept either form via
``populate_by_name`` aliases and a `pfp_url` field validator.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class FarcasterSpacesConfigError(Exception):
    """Raised when the service-FID custody key (and other discovery
    config) is missing or empty. Routers translate this to HTTP 503.
    """


class SpaceUser(BaseModel):
    """A Farcaster user as it appears inside audio-room payloads.

    Tolerates both the canonical nested `pfp: { url: ... }` shape and
    the denormalized `pfpUrl` top-level form. The validator runs on
    ``pre`` mode so it sees the raw upstream dict (with camelCase keys)
    before any alias resolution.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    fid: int
    username: str | None = None
    display_name: str | None = Field(default=None, alias="displayName")
    pfp_url: str | None = Field(default=None, alias="pfpUrl")

    @field_validator("pfp_url", mode="before")
    @classmethod
    def _coerce_pfp_url(cls, value: Any, info: Any) -> str | None:
        """Accept `pfpUrl` (string), `pfp.url` (nested), or absent.

        ``info.data`` is the partially-validated model, so we can't read
        sibling raw keys from it. Instead we lean on Pydantic populating
        ``value`` from either ``pfp_url`` or its alias ``pfpUrl`` first,
        and only fall back to looking up nested ``pfp.url`` when called
        with a dict (which happens when a downstream model_validator
        passes the full payload through).
        """
        if value is None or isinstance(value, str):
            return value
        if isinstance(value, dict):
            # Allow callers passing the raw `pfp` mapping in directly.
            nested = value.get("url")
            return nested if isinstance(nested, str) else None
        return None

    @classmethod
    def model_validate_upstream(cls, payload: dict[str, Any]) -> "SpaceUser":
        """Build a SpaceUser from an upstream dict, folding
        ``pfp.url`` into ``pfpUrl`` if needed. Used by parent models'
        pre-validators."""
        if not isinstance(payload, dict):
            return cls.model_validate(payload)
        normalized = dict(payload)
        if "pfpUrl" not in normalized and "pfp_url" not in normalized:
            pfp = normalized.get("pfp")
            if isinstance(pfp, dict) and isinstance(pfp.get("url"), str):
                normalized["pfpUrl"] = pfp["url"]
        return cls.model_validate(normalized)


class AudioRoom(BaseModel):
    """A Farcaster audio room snapshot.

    `state` is loosely typed as either the known literal set or a
    pass-through string so a previously unseen value (e.g. a new
    server-side state) does not crash discovery.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    id: str
    title: str | None = None
    description: str | None = None
    host: SpaceUser
    state: Literal["scheduled", "live", "ended"] | str
    started_at: datetime | None = Field(default=None, alias="startedAt")
    scheduled_at: datetime | None = Field(default=None, alias="scheduledAt")
    ended_at: datetime | None = Field(default=None, alias="endedAt")
    listener_count: int | None = Field(default=None, alias="listenerCount")
    channel_key: str | None = Field(default=None, alias="channelKey")
    root_cast_hash: str | None = Field(default=None, alias="rootCastHash")
    root_cast_fid: int | None = Field(default=None, alias="rootCastFid")

    @field_validator("host", mode="before")
    @classmethod
    def _normalize_host(cls, value: Any) -> Any:
        if isinstance(value, dict):
            return SpaceUser.model_validate_upstream(value)
        return value


class PendingStageInvite(BaseModel):
    """Per-participant pending stage invite — set when a host has
    invited the user to the stage, cleared by accept/decline."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    role: Literal["host", "cohost", "speaker", "listener", "speaker_invited"]
    inviter_fid: int | None = Field(default=None, alias="inviterFid")


class AudioRoomParticipant(BaseModel):
    """A participant inside a Farcaster audio room (host / cohost /
    speaker / listener)."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    user: SpaceUser
    role: Literal["host", "cohost", "speaker", "listener"]
    hand_raised: bool | None = Field(default=None, alias="handRaised")
    joined_at: datetime | None = Field(default=None, alias="joinedAt")
    # Surfaced so Juke clients (which don't get Farcaster's stage-invite
    # push notification) can poll the participants endpoint and detect
    # a pending invite for their own fid → render the accept/decline UI.
    pending_invite: PendingStageInvite | None = Field(
        default=None, alias="pendingInvite"
    )

    @field_validator("user", mode="before")
    @classmethod
    def _normalize_user(cls, value: Any) -> Any:
        if isinstance(value, dict):
            return SpaceUser.model_validate_upstream(value)
        return value


class AudioRoomChatMessage(BaseModel):
    """A chat message in an audio room. Chat IDs and FIDs are optional
    because the upstream surface is read-only and the server's exact
    envelope shape varies between message types."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    id: str | None = None
    fid: int | None = None
    user: SpaceUser | None = None
    text: str
    created_at: datetime | int | str | None = Field(default=None, alias="createdAt")

    @field_validator("user", mode="before")
    @classmethod
    def _normalize_user(cls, value: Any) -> Any:
        if isinstance(value, dict):
            return SpaceUser.model_validate_upstream(value)
        return value
