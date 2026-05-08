from typing import Literal

from pydantic import BaseModel, Field


class DeviceTokenRequest(BaseModel):
    expo_push_token: str = Field(
        ..., min_length=1, max_length=512,
        pattern=r"^Expo(nent)?PushToken\[.+\]$",
    )
    device_id: str | None = Field(default=None, max_length=256)


class NotificationPreferencesResponse(BaseModel):
    follows_enabled: bool = True
    likes_enabled: bool = True
    replies_enabled: bool = True
    recasts_enabled: bool = True
    space_started_enabled: bool = True
    space_invited_enabled: bool = True
    hand_raised_enabled: bool = True
    miniapp_enabled: bool = False


class NotificationPreferencesUpdate(BaseModel):
    follows_enabled: bool | None = None
    likes_enabled: bool | None = None
    replies_enabled: bool | None = None
    recasts_enabled: bool | None = None
    space_started_enabled: bool | None = None
    space_invited_enabled: bool | None = None
    hand_raised_enabled: bool | None = None
    miniapp_enabled: bool | None = None


class RoomLiveNotifyRequest(BaseModel):
    target: Literal["rsvps", "all_active"] = "all_active"
    dry_run: bool = False


class RoomLiveNotifyResponse(BaseModel):
    room_id: str
    target: Literal["rsvps", "all_active"]
    dry_run: bool
    campaign: str
    users_considered: int
    users_eligible: int
    users_sent: int
    users_skipped_self: int = 0
    users_skipped_preferences: int = 0
    users_skipped_idempotent: int = 0
    native_targets: int = 0
    miniapp_targets: int = 0
    preference_bypass: bool = False
